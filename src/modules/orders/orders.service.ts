import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { AppError, conflict, notFound } from '../../common/app-error.js';
import { decodeCursor, encodeCursor, type Page } from '../../common/cursor.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { DB, type Db, type DbOrTx, type Tx } from '../../platform/database.js';
import { OutboxService } from '../../platform/outbox.js';
import { cartLines, clearCart, lockCartForCheckout } from '../cart/cart.service.js';
import { priceLines } from '../cart/pricing.js';
import { commit, InsufficientStockError, release, reserve } from '../inventory/reservations.js';
import { InvalidTransitionError, type OrderStatus, stockEffect } from './order-status.js';

export interface OrderItem {
  variantId: string;
  productName: string;
  sku: string;
  size: string;
  color: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  expiresAt: Date | null;
  items: OrderItem[];
  statusHistory: { from: OrderStatus | null; to: OrderStatus; reason: string; at: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

export type OrderSummary = Omit<Order, 'items' | 'statusHistory' | 'userId'> & {
  userId: string;
  itemCount: number;
};

export const orderErrors = {
  notFound: () => notFound('ORDER_NOT_FOUND', 'Order not found'),
  cartEmpty: () => new AppError(422, 'CART_EMPTY', 'Add items to the cart before placing an order'),
  unavailable: (variantIds: string[]) =>
    conflict('CART_HAS_UNAVAILABLE_ITEMS', 'Some items in the cart are no longer for sale', { variantIds }),
  paymentInProgress: () =>
    conflict('PAYMENT_IN_PROGRESS', 'A checkout for this order is still open; try again once it has closed'),
  invalidTransition: (e: InvalidTransitionError) =>
    conflict('INVALID_STATUS_TRANSITION', `An order cannot move from ${e.from} to ${e.to}`),
};

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    logger.setContext('orders');
  }

  /**
   * Places an order for the whole cart in one transaction: re-checks every
   * line, reserves the stock, snapshots the items, records order.placed in
   * the outbox and empties the cart. If anything fails, nothing changes.
   */
  async place(userId: string): Promise<Order> {
    const orderId = await this.db.transaction(async (tx) => {
      await lockCartForCheckout(tx, userId);
      const lines = await cartLines(tx, userId);
      if (lines.length === 0) throw orderErrors.cartEmpty();
      const unavailable = lines.filter((l) => !l.purchasable).map((l) => l.variantId);
      if (unavailable.length > 0) throw orderErrors.unavailable(unavailable);

      try {
        await reserve(tx, lines);
      } catch (err) {
        if (err instanceof InsufficientStockError) throw err.toAppError();
        throw err;
      }

      const totals = priceLines(lines);
      const expiresAt = new Date(Date.now() + this.config.orderReservationTtlMs);
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO orders (user_id, currency, subtotal_cents, shipping_cents, total_cents, expires_at)
        VALUES (${userId}, 'brl', ${totals.subtotalCents}, ${totals.shippingCents}, ${totals.totalCents}, ${expiresAt})
        RETURNING id`);
      const id = (rows[0] as { id: string }).id;
      for (const l of lines) {
        await tx.execute(sql`
          INSERT INTO order_items (order_id, variant_id, product_name, sku, size, color, unit_price_cents, quantity)
          VALUES (${id}, ${l.variantId}, ${l.productName}, ${l.sku}, ${l.size}, ${l.color}, ${l.unitPriceCents}, ${l.quantity})`);
      }
      await recordStatus(tx, id, null, 'pending_payment', 'order placed');
      await this.outbox.record(tx, 'order.placed', id, {
        orderId: id,
        userId,
        totalCents: totals.totalCents,
        expiresAt: expiresAt.toISOString(),
      });
      await clearCart(tx, userId);
      return id;
    });

    const order = await loadOrder(this.db, orderId);
    this.logger.info(
      { order_id: orderId, total_cents: order?.totalCents, items: order?.items.length },
      'order.placed',
    );
    return order as Order;
  }

  /** One of the user's orders; someone else's is reported as not found. */
  async get(userId: string | null, orderId: string): Promise<Order> {
    const order = await loadOrder(this.db, orderId);
    if (!order || (userId !== null && order.userId !== userId)) throw orderErrors.notFound();
    return order;
  }

  /** Orders newest first, paged by cursor. */
  async list(filter: { userId?: string; status?: OrderStatus }, cursor: string | undefined, limit: number) {
    const where = [sql`true`];
    if (filter.userId) where.push(sql`o.user_id = ${filter.userId}`);
    if (filter.status) where.push(sql`o.status = ${filter.status}`);
    if (cursor) {
      const c = decodeCursor(cursor, 'newest');
      where.push(sql`(o.created_at, o.id) < (${c.value}::timestamptz, ${c.id}::uuid)`);
    }
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT o.*, (SELECT COALESCE(sum(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count
      FROM orders o WHERE ${sql.join(where, sql` AND `)}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit).map(toSummary);
    const last = page.at(-1);
    return {
      data: page,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ sort: 'newest', value: last.createdAt.toISOString(), id: last.id })
          : null,
    } satisfies Page<OrderSummary>;
  }

  /** Cancels one of the user's unpaid orders and releases its stock. */
  cancel(userId: string, orderId: string): Promise<Order> {
    return this.changeStatus(orderId, 'cancelled', 'cancelled by customer', userId);
  }

  /** Sets shipped, delivered or cancelled, subject to the state machine. */
  adminSetStatus(orderId: string, to: OrderStatus, reason: string): Promise<Order> {
    return this.changeStatus(orderId, to, reason, null);
  }

  /**
   * Applies a status change to a locked order inside tx: its effect on
   * stock, the status itself, the audit trail and an order.status_changed
   * event. Payments and expiry use it in their own transactions.
   */
  async transition(tx: Tx, order: Order, to: OrderStatus, reason: string): Promise<void> {
    const effect = stockEffect(order.status, to);
    const lines = order.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    if (effect === 'commit') await commit(tx, lines);
    if (effect === 'release') await release(tx, lines);

    await tx.execute(sql`
      UPDATE orders SET status = ${to}, expires_at = CASE WHEN ${to} = 'pending_payment' THEN expires_at END
      WHERE id = ${order.id}`);
    await recordStatus(tx, order.id, order.status, to, reason);
    await this.outbox.record(tx, 'order.status_changed', order.id, {
      orderId: order.id,
      userId: order.userId,
      from: order.status,
      to,
      reason,
    });
    this.logger.info({ order_id: order.id, from: order.status, to, reason }, 'order.status_changed');
  }

  private async changeStatus(orderId: string, to: OrderStatus, reason: string, ownerId: string | null) {
    await this.db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || (ownerId !== null && order.userId !== ownerId)) throw orderErrors.notFound();
      if (to === 'cancelled' && (await hasOpenCheckout(tx, orderId))) throw orderErrors.paymentInProgress();
      try {
        await this.transition(tx, order, to, reason);
      } catch (err) {
        if (err instanceof InvalidTransitionError) throw orderErrors.invalidTransition(err);
        throw err;
      }
    });
    return loadOrder(this.db, orderId) as Promise<Order>;
  }
}

/** Loads an order and locks its row until tx ends. */
export async function lockOrder(tx: Tx, orderId: string): Promise<Order | undefined> {
  await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`);
  return loadOrder(tx, orderId);
}

/**
 * Cancelling while the customer may still be paying would take their money
 * for a cancelled order; once the Stripe session closes it is allowed.
 */
async function hasOpenCheckout(tx: Tx, orderId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ open: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM payments WHERE order_id = ${orderId} AND status = 'pending' AND expires_at > now()) AS open`);
  return Boolean(rows[0]?.open);
}

async function recordStatus(
  tx: Tx,
  orderId: string,
  from: OrderStatus | null,
  to: OrderStatus,
  reason: string,
) {
  await tx.execute(sql`
    INSERT INTO order_status_history (order_id, from_status, to_status, reason)
    VALUES (${orderId}, ${from}, ${to}, ${reason})`);
}

export async function loadOrder(db: DbOrTx, orderId: string): Promise<Order | undefined> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`SELECT * FROM orders WHERE id = ${orderId}`);
  const row = rows[0];
  if (!row) return undefined;
  const [items, history] = await Promise.all([
    db.execute<Record<string, unknown>>(
      sql`SELECT * FROM order_items WHERE order_id = ${orderId} ORDER BY sku`,
    ),
    db.execute<Record<string, unknown>>(
      sql`SELECT from_status, to_status, reason, created_at FROM order_status_history WHERE order_id = ${orderId} ORDER BY id`,
    ),
  ]);
  return {
    ...toSummary(row),
    items: items.rows.map((i) => ({
      variantId: i.variant_id as string,
      productName: i.product_name as string,
      sku: i.sku as string,
      size: i.size as string,
      color: i.color as string,
      unitPriceCents: Number(i.unit_price_cents),
      quantity: Number(i.quantity),
      lineTotalCents: Number(i.line_total_cents),
    })),
    statusHistory: history.rows.map((h) => ({
      from: (h.from_status as OrderStatus | null) ?? null,
      to: h.to_status as OrderStatus,
      reason: h.reason as string,
      at: new Date(h.created_at as string),
    })),
  };
}

function toSummary(r: Record<string, unknown>): OrderSummary & { itemCount: number } {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    status: r.status as OrderStatus,
    currency: r.currency as string,
    subtotalCents: Number(r.subtotal_cents),
    shippingCents: Number(r.shipping_cents),
    totalCents: Number(r.total_cents),
    expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
    itemCount: Number(r.item_count ?? 0),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}
