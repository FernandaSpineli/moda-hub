import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id } from './types.js';

/**
 * Transactional outbox. A domain event is inserted in the same transaction
 * as the state change it describes, so it can never be lost or published for
 * a change that rolled back. A relay publishes unpublished rows to the
 * queue and stamps published_at.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    type: text().notNull(),
    aggregateId: uuid().notNull(),
    payload: jsonb().notNull(),
    // Ties the event back to the request that caused it, across processes.
    correlationId: text(),
    createdAt: createdAt(),
    publishedAt: timestamp({ withTimezone: true }),
  },
  // The relay only ever scans unpublished events, oldest first.
  (t) => [index('outbox_events_unpublished_idx').on(t.createdAt).where(sql`published_at IS NULL`)],
);

/**
 * Which consumer already handled which event. Queues deliver at least once;
 * inserting here in the consumer's transaction makes each handler run once.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    consumer: text().notNull(),
    eventId: uuid().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);
