import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { createdAt, id, updatedAt } from './types.js';
import { users } from './users.js';

export const orderStatuses = [
  'pending_payment',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
  'expired',
] as const;

export const orders = pgTable(
  'orders',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text({ enum: orderStatuses }).notNull().default('pending_payment'),
    currency: text().notNull(),
    subtotalCents: bigint({ mode: 'number' }).notNull(),
    shippingCents: bigint({ mode: 'number' }).notNull(),
    totalCents: bigint({ mode: 'number' }).notNull(),
    // Stock for an unpaid order stays reserved until this moment.
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'orders_status_check',
      sql`${t.status} IN ('pending_payment', 'paid', 'shipped', 'delivered', 'cancelled', 'expired')`,
    ),
    check('orders_currency_format', sql`${t.currency} ~ '^[a-z]{3}$'`),
    check('orders_amounts_non_negative', sql`${t.subtotalCents} > 0 AND ${t.shippingCents} >= 0`),
    check('orders_total_is_sum', sql`${t.totalCents} = ${t.subtotalCents} + ${t.shippingCents}`),
    check('orders_pending_has_expiry', sql`${t.status} <> 'pending_payment' OR ${t.expiresAt} IS NOT NULL`),
    // Keyset pagination of a user's history: (created_at, id) descending.
    index('orders_user_id_created_at_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    index('orders_status_created_at_idx').on(t.status, t.createdAt.desc()),
  ],
);

/** Name, size, colour and price are snapshots taken when the order was placed. */
export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    productName: text().notNull(),
    sku: text().notNull(),
    size: text().notNull(),
    color: text().notNull(),
    unitPriceCents: bigint({ mode: 'number' }).notNull(),
    quantity: integer().notNull(),
    lineTotalCents: bigint({ mode: 'number' }).generatedAlwaysAs(sql`unit_price_cents * quantity`),
  },
  (t) => [
    unique('order_items_order_variant_key').on(t.orderId, t.variantId),
    check('order_items_price_positive', sql`${t.unitPriceCents} > 0`),
    check('order_items_quantity_positive', sql`${t.quantity} > 0`),
    index('order_items_variant_id_idx').on(t.variantId),
  ],
);

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text({ enum: orderStatuses }),
    toStatus: text({ enum: orderStatuses }).notNull(),
    reason: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('order_status_history_order_id_idx').on(t.orderId, t.id)],
);
