import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.js';
import { createdAt, id, updatedAt } from './types.js';

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    stripeCheckoutSessionId: text().notNull().unique(),
    stripePaymentIntentId: text().unique(),
    status: text({ enum: ['pending', 'succeeded', 'failed', 'expired'] })
      .notNull()
      .default('pending'),
    amountCents: bigint({ mode: 'number' }).notNull(),
    currency: text().notNull(),
    checkoutUrl: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('payments_status_check', sql`${t.status} IN ('pending', 'succeeded', 'failed', 'expired')`),
    check('payments_amount_positive', sql`${t.amountCents} > 0`),
    index('payments_order_id_idx').on(t.orderId),
    // At most one open checkout and one successful payment per order.
    uniqueIndex('payments_one_pending_per_order').on(t.orderId).where(sql`status = 'pending'`),
    uniqueIndex('payments_one_succeeded_per_order').on(t.orderId).where(sql`status = 'succeeded'`),
  ],
);

/**
 * Every Stripe webhook, recorded when it arrives and before it is applied.
 * The primary key deduplicates redeliveries; the payload lets a worker
 * apply it later, and retry, without asking Stripe again.
 */
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: text().primaryKey(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    status: text({ enum: ['received', 'processed'] })
      .notNull()
      .default('received'),
    receivedAt: createdAt(),
    processedAt: timestamp({ withTimezone: true }),
  },
  (t) => [check('stripe_events_status_check', sql`${t.status} IN ('received', 'processed')`)],
);
