import type { DefaultJobOptions } from 'bullmq';
import type { AppConfig } from '../config/config.js';

/**
 * The queues and what runs on them. Each consumer of a domain event gets
 * its own job, so a slow or failing email never holds up stock alerts.
 */
export const QUEUES = {
  stripeEvents: 'stripe-events',
  notifications: 'notifications',
  orderExpiry: 'order-expiry',
  inventoryAlerts: 'inventory-alerts',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const queueNames = Object.values(QUEUES);

/** Notification emails, keyed by job name. */
export type NotificationJob =
  | 'password-reset'
  | 'order-confirmation'
  | 'payment-confirmed'
  | 'order-shipped'
  | 'order-closed';

/** What every job carries: the domain event it handles and its trace. */
export interface EventJobData {
  eventId: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
}

/**
 * Five attempts with exponential backoff (1s, 2s, 4s, 8s by default); after
 * that the job stays in the failed set for an admin to inspect and retry:
 * the dead-letter queue.
 */
export function defaultJobOptions(config: AppConfig): DefaultJobOptions {
  return {
    attempts: 5,
    backoff: { type: 'exponential', delay: config.jobRetryBaseDelayMs },
    removeOnComplete: { age: 24 * 3600, count: 1_000 },
    removeOnFail: false,
  };
}

/** BullMQ connection options from REDIS_URL. Workers need maxRetriesPerRequest: null. */
export function bullConnection(config: AppConfig) {
  const url = new URL(config.redisUrl.reveal());
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
