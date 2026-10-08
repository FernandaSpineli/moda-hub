import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { AppError, conflict } from '../../common/app-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { DB, type Db, type Tx } from '../../platform/database.js';
import { isUniqueViolation } from '../../platform/db-errors.js';
import { lockOrder, type Order, OrdersService, orderErrors } from '../orders/orders.service.js';
import { PAYMENT_GATEWAY, type PaymentGateway, PaymentProviderError } from './payment-gateway.js';

/** Stripe requires at least 30 minutes from creation; keep a margin. */
const SESSION_TTL_MS = 31 * 60_000;
/** Reserved stock outlives the session, so a last-second payment still finds it. */
const RESERVATION_GRACE_MS = 5 * 60_000;
/** An open session this close to closing is replaced rather than handed back. */
const REUSE_MARGIN_MS = 2 * 60_000;
const WEBHOOK_TOLERANCE_SECONDS = 300;

export const paymentErrors = {
  disabled: () => new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not available at the moment'),
  notPayable: () => conflict('ORDER_NOT_PAYABLE', 'This order is not awaiting payment'),
  provider: () =>
    new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not be reached; try again'),
  conflict: () =>
    conflict('CHECKOUT_IN_PROGRESS', 'A checkout for this order is being created; retry shortly'),
  invalidSignature: () => new AppError(400, 'INVALID_SIGNATURE', 'Webhook signature verification failed'),
};

export interface Checkout {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: Date;
}

type PaymentRow = {
  id: string;
  order_id: string;
  status: string;
  amount_cents: string;
  currency: string;
};

const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

@Injectable()
export class PaymentsService {
  private readonly webhooks?: { verify: (payload: Buffer, signature: string) => Stripe.Event };

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orders: OrdersService,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway | null,
  ) {
    logger.setContext('payments');
    const secret = config.stripe?.webhookSecret.reveal();
    if (secret) {
      // Signature checks are local: no API key or network needed.
      const stripe = new Stripe('sk_test_signature_verification_only');
      this.webhooks = {
        verify: (payload, signature) =>
          stripe.webhooks.constructEvent(payload, signature, secret, WEBHOOK_TOLERANCE_SECONDS),
      };
    }
  }

  /**
   * A hosted checkout page for one of the user's unpaid orders: the open
   * session if there is one, else a new one. Stripe is called between two
   * short transactions, never while holding row locks; concurrent requests
   * compute the same attempt number, hence the same idempotency key, and
   * Stripe returns them the same session.
   */
  async startCheckout(userId: string, orderId: string): Promise<{ checkout: Checkout; created: boolean }> {
    if (!this.gateway) throw paymentErrors.disabled();

    const prep = await this.db.transaction(async (tx) => {
      const order = await this.payable(tx, userId, orderId);
      const { rows } = await tx.execute<{ id: string; checkout_url: string; expires_at: Date }>(sql`
        SELECT stripe_checkout_session_id AS id, checkout_url, expires_at FROM payments
        WHERE order_id = ${orderId} AND status = 'pending'`);
      const open = rows[0];
      if (open && new Date(open.expires_at).getTime() > Date.now() + REUSE_MARGIN_MS) {
        return {
          order,
          reuse: { sessionId: open.id, checkoutUrl: open.checkout_url, expiresAt: new Date(open.expires_at) },
        };
      }
      if (open) {
        await tx.execute(
          sql`UPDATE payments SET status = 'expired' WHERE stripe_checkout_session_id = ${open.id}`,
        );
      }
      const { rows: counts } = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int + 1 AS n FROM payments WHERE order_id = ${orderId}`,
      );
      const { rows: users } = await tx.execute<{ email: string }>(
        sql`SELECT email FROM users WHERE id = ${userId}`,
      );
      return { order, attempt: counts[0]?.n ?? 1, email: users[0]?.email as string };
    });
    if (prep.reuse) {
      this.logger.info({ order_id: orderId, session_id: prep.reuse.sessionId }, 'payment.checkout_reused');
      return { checkout: prep.reuse, created: false };
    }

    const { order } = prep;
    let session: Awaited<ReturnType<PaymentGateway['createCheckoutSession']>>;
    try {
      session = await this.gateway.createCheckoutSession({
        orderId,
        customerEmail: prep.email as string,
        currency: order.currency,
        lines: order.items.map((i) => ({
          name: `${i.productName} — ${i.size} / ${i.color}`,
          unitPriceCents: i.unitPriceCents,
          quantity: i.quantity,
        })),
        shippingCents: order.shippingCents,
        successUrl: `${this.config.baseUrl}/checkout/success?order_id=${encodeURIComponent(orderId)}`,
        cancelUrl: `${this.config.baseUrl}/checkout/cancel?order_id=${encodeURIComponent(orderId)}`,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        idempotencyKey: `checkout-${orderId}-${prep.attempt}`,
      });
    } catch (err) {
      if (!(err instanceof PaymentProviderError)) throw err;
      this.logger.error({ order_id: orderId, reason: err.message }, 'stripe.request_failed');
      throw paymentErrors.provider();
    }

    await this.db.transaction(async (tx) => {
      // The order may have been cancelled meanwhile; its session then just expires unused.
      await this.payable(tx, userId, orderId);
      try {
        await tx.execute(sql`
          INSERT INTO payments (order_id, stripe_checkout_session_id, amount_cents, currency, checkout_url, expires_at)
          VALUES (${orderId}, ${session.id}, ${order.totalCents}, ${order.currency}, ${session.url}, ${session.expiresAt})
          ON CONFLICT (stripe_checkout_session_id) DO NOTHING`);
      } catch (err) {
        if (isUniqueViolation(err, 'payments_one_pending_per_order')) throw paymentErrors.conflict();
        throw err;
      }
      await tx.execute(sql`
        UPDATE orders SET expires_at = GREATEST(expires_at, ${new Date(session.expiresAt.getTime() + RESERVATION_GRACE_MS)})
        WHERE id = ${orderId} AND status = 'pending_payment'`);
    });
    this.logger.info(
      { order_id: orderId, session_id: session.id, amount_cents: order.totalCents, attempt: prep.attempt },
      'payment.checkout_created',
    );
    return {
      checkout: { sessionId: session.id, checkoutUrl: session.url, expiresAt: session.expiresAt },
      created: true,
    };
  }

  /**
   * Verifies a webhook and records it. Stripe delivers at least once; the
   * event ID is the primary key, so a redelivery is recognised here and never
   * applied twice. Returns the event ID to apply, or undefined when there is
   * nothing to do.
   */
  async receive(payload: Buffer | undefined, signature: string | undefined): Promise<string | undefined> {
    if (!this.webhooks) throw paymentErrors.disabled();
    let event: Stripe.Event;
    try {
      event = this.webhooks.verify(payload ?? Buffer.alloc(0), signature ?? '');
    } catch (err) {
      this.logger.warn({ reason: (err as Error).message }, 'webhook.signature_invalid');
      throw paymentErrors.invalidSignature();
    }
    if (!HANDLED.has(event.type)) {
      this.logger.debug({ stripe_event_id: event.id, stripe_event_type: event.type }, 'webhook.ignored');
      return undefined;
    }
    const { rowCount } = await this.db.execute(sql`
      INSERT INTO stripe_events (id, type, payload) VALUES (${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    if (!rowCount) {
      this.logger.info({ stripe_event_id: event.id }, 'webhook.duplicate');
      return undefined;
    }
    this.logger.info({ stripe_event_id: event.id, stripe_event_type: event.type }, 'webhook.received');
    return event.id;
  }

  /**
   * Applies a recorded event, at most once: the event row is locked and
   * marked processed in the same transaction as its effects. Safe to call
   * again (a retry, a duplicate job).
   */
  async apply(eventId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ status: string; payload: Stripe.Event }>(
        sql`SELECT status, payload FROM stripe_events WHERE id = ${eventId} FOR UPDATE`,
      );
      const row = rows[0];
      if (!row || row.status === 'processed') return;
      const event = row.payload;
      const session = event.data.object as Stripe.Checkout.Session;
      const log = { stripe_event_id: eventId, session_id: session.id };

      const { rows: payments } = await tx.execute<PaymentRow>(sql`
        SELECT id, order_id, status, amount_cents, currency FROM payments
        WHERE stripe_checkout_session_id = ${session.id} FOR UPDATE`);
      const payment = payments[0];
      if (!payment) {
        // Not ours (another integration on the account): acknowledge and move on.
        this.logger.warn(log, 'webhook.unknown_session');
      } else {
        switch (event.type) {
          case 'checkout.session.completed':
            if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
              await this.succeed(tx, payment, session);
            } else {
              // Boleto/Pix: the outcome arrives later as async_payment_*.
              this.logger.info({ ...log, order_id: payment.order_id }, 'payment.awaiting_confirmation');
            }
            break;
          case 'checkout.session.async_payment_succeeded':
            await this.succeed(tx, payment, session);
            break;
          case 'checkout.session.async_payment_failed':
            await this.fail(tx, payment);
            break;
          case 'checkout.session.expired':
            await this.expire(tx, payment);
            break;
        }
      }
      await tx.execute(
        sql`UPDATE stripe_events SET status = 'processed', processed_at = now() WHERE id = ${eventId}`,
      );
    });
  }

  private async succeed(tx: Tx, payment: PaymentRow, session: Stripe.Checkout.Session): Promise<void> {
    if (payment.status === 'succeeded') return;
    const amount = Number(payment.amount_cents);
    const intent =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;

    if (session.amount_total !== amount || session.currency?.toLowerCase() !== payment.currency) {
      // Never fulfil an order for anything but its total.
      this.logger.error(
        {
          order_id: payment.order_id,
          expected_cents: amount,
          paid_cents: session.amount_total,
          paid_currency: session.currency,
        },
        'payment.amount_mismatch',
      );
      await setPayment(tx, payment.id, 'failed', intent);
      return;
    }
    const { rows } = await tx.execute<{ paid: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM payments WHERE order_id = ${payment.order_id} AND status = 'succeeded' AND id <> ${payment.id}) AS paid`);
    if (rows[0]?.paid) {
      // A retired session and a newer one were both paid: refund by hand.
      this.logger.error(
        {
          order_id: payment.order_id,
          amount_cents: amount,
          payment_intent_id: intent,
          reason: 'order already paid',
        },
        'payment.requires_refund',
      );
      await setPayment(tx, payment.id, 'failed', intent);
      return;
    }
    await setPayment(tx, payment.id, 'succeeded', intent);

    const order = (await lockOrder(tx, payment.order_id)) as Order;
    if (order.status !== 'pending_payment') {
      // Paid after the order closed; the money was taken, so refund by hand.
      this.logger.error(
        { order_id: order.id, order_status: order.status, amount_cents: amount, payment_intent_id: intent },
        'payment.requires_refund',
      );
      return;
    }
    await this.orders.transition(tx, order, 'paid', 'payment confirmed by Stripe');
    this.logger.info(
      { order_id: order.id, amount_cents: amount, payment_intent_id: intent },
      'payment.succeeded',
    );
  }

  private async fail(tx: Tx, payment: PaymentRow): Promise<void> {
    await setPayment(tx, payment.id, 'failed');
    this.logger.info({ order_id: payment.order_id }, 'payment.failed');
    const order = (await lockOrder(tx, payment.order_id)) as Order;
    if (order.status === 'pending_payment')
      await this.orders.transition(tx, order, 'cancelled', 'payment failed');
  }

  /** An abandoned checkout; the order stays pending so the customer can try again. */
  private async expire(tx: Tx, payment: PaymentRow): Promise<void> {
    if (payment.status !== 'pending') return;
    await setPayment(tx, payment.id, 'expired');
    this.logger.info({ order_id: payment.order_id }, 'payment.expired');
  }

  private async payable(tx: Tx, userId: string, orderId: string): Promise<Order> {
    const order = await lockOrder(tx, orderId);
    if (!order || order.userId !== userId) throw orderErrors.notFound();
    if (order.status !== 'pending_payment') throw paymentErrors.notPayable();
    return order;
  }
}

async function setPayment(
  tx: Tx,
  id: string,
  status: string,
  paymentIntentId?: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE payments SET status = ${status},
      stripe_payment_intent_id = COALESCE(${paymentIntentId ?? null}, stripe_payment_intent_id)
    WHERE id = ${id}`);
}
