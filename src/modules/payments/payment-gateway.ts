import Stripe from 'stripe';

/** Creates hosted checkout pages. An interface so tests run without the network. */
export interface PaymentGateway {
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Every amount comes from the stored order, never from the client. */
export interface CheckoutRequest {
  orderId: string;
  customerEmail: string;
  currency: string;
  lines: { name: string; unitPriceCents: number; quantity: number }[];
  shippingCents: number;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
}

export class PaymentProviderError extends Error {
  override name = 'PaymentProviderError';
}

/** The PaymentGateway backed by Stripe Checkout. */
export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;

  /** `api` points the client at another server (a fake one in tests). */
  constructor(secretKey: string, api?: { host: string; port: number; protocol: 'http' | 'https' }) {
    this.stripe = new Stripe(secretKey, {
      // Network failures are retried, reusing the idempotency key, so a
      // retry can never create a second session.
      maxNetworkRetries: 2,
      telemetry: false,
      ...api,
    });
  }

  async createCheckoutSession(req: CheckoutRequest): Promise<CheckoutSession> {
    try {
      const session = await this.stripe.checkout.sessions.create(checkoutParams(req), {
        idempotencyKey: req.idempotencyKey,
      });
      return { id: session.id, url: session.url as string, expiresAt: new Date(session.expires_at * 1000) };
    } catch (err) {
      const e = err as {
        type?: string;
        raw?: { type?: string };
        code?: string;
        statusCode?: number;
        requestId?: string;
        message?: string;
      };
      // Type, code, status and request ID are what support needs; the message
      // from Stripe never contains the full key.
      throw new PaymentProviderError(
        `stripe: ${e.message} (type=${e.raw?.type ?? e.type} code=${e.code} status=${e.statusCode} request_id=${e.requestId})`,
        { cause: err },
      );
    }
  }
}

function checkoutParams(req: CheckoutRequest): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'payment',
    client_reference_id: req.orderId,
    customer_email: req.customerEmail,
    success_url: req.successUrl,
    cancel_url: req.cancelUrl,
    expires_at: Math.floor(req.expiresAt.getTime() / 1000),
    metadata: { order_id: req.orderId },
    line_items: req.lines.map((l) => ({
      quantity: l.quantity,
      price_data: { currency: req.currency, unit_amount: l.unitPriceCents, product_data: { name: l.name } },
    })),
    // Shipping is part of the order total, so Stripe must charge it too.
    ...(req.shippingCents > 0 && {
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: 'Entrega padrão',
            type: 'fixed_amount',
            fixed_amount: { amount: req.shippingCents, currency: req.currency },
          },
        },
      ],
    }),
  };
}
