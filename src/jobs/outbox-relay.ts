import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DB, type Db } from '../platform/database.js';
import { type EventJobData, QUEUES, type QueueName } from './queues.js';

interface OutboxRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  [key: string]: unknown;
}

interface Route {
  queue: QueueName;
  job: string;
  delayUntil?: string;
}

/** Which jobs each domain event fans out to. */
export function routes(type: string, payload: Record<string, unknown>): Route[] {
  switch (type) {
    case 'auth.password_reset_requested':
      return [{ queue: QUEUES.notifications, job: 'password-reset' }];
    case 'order.placed':
      return [
        { queue: QUEUES.notifications, job: 'order-confirmation' },
        // One delayed job per order, due when its reservation runs out.
        { queue: QUEUES.orderExpiry, job: 'expire', delayUntil: payload.expiresAt as string },
      ];
    case 'order.status_changed':
      switch (payload.to) {
        case 'paid':
          return [
            { queue: QUEUES.notifications, job: 'payment-confirmed' },
            { queue: QUEUES.inventoryAlerts, job: 'check-low-stock' },
          ];
        case 'shipped':
          return [{ queue: QUEUES.notifications, job: 'order-shipped' }];
        case 'cancelled':
        case 'expired':
          return [{ queue: QUEUES.notifications, job: 'order-closed' }];
        default:
          return [];
      }
    default:
      return [];
  }
}

const POLL_INTERVAL_MS = 500;
const BATCH = 100;

/**
 * Publishes outbox events to the queues. Rows are claimed with SKIP LOCKED,
 * so several workers can relay in parallel without sending an event twice;
 * job IDs derive from the event ID, so a re-publish after a crash between
 * enqueueing and marking the row is deduplicated by BullMQ, and consumers
 * are idempotent on top of that.
 */
@Injectable()
export class OutboxRelay implements OnApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
    @InjectQueue(QUEUES.notifications) notifications: Queue,
    @InjectQueue(QUEUES.orderExpiry) orderExpiry: Queue,
    @InjectQueue(QUEUES.inventoryAlerts) inventoryAlerts: Queue,
    @InjectQueue(QUEUES.stripeEvents) stripeEvents: Queue,
  ) {
    logger.setContext('outbox');
    this.queues = {
      [QUEUES.notifications]: notifications,
      [QUEUES.orderExpiry]: orderExpiry,
      [QUEUES.inventoryAlerts]: inventoryAlerts,
      [QUEUES.stripeEvents]: stripeEvents,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Publishes one batch; returns how many events it published. */
  async relayOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<OutboxRow>(sql`
        SELECT id, type, payload, correlation_id FROM outbox_events
        WHERE published_at IS NULL ORDER BY created_at LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`);
      for (const event of rows) {
        for (const route of routes(event.type, event.payload)) {
          const data: EventJobData = {
            eventId: event.id,
            correlationId: event.correlation_id,
            payload: event.payload,
          };
          const opts: JobsOptions = { jobId: `${event.id}.${route.job}` };
          if (route.delayUntil) opts.delay = Math.max(new Date(route.delayUntil).getTime() - Date.now(), 0);
          await this.queues[route.queue].add(route.job, data, opts);
        }
      }
      if (rows.length > 0) {
        await tx.execute(sql`
          UPDATE outbox_events SET published_at = now()
          WHERE id = ANY(${sql.param(rows.map((r) => r.id))}::uuid[])`);
        this.logger.debug({ events: rows.length }, 'outbox.published');
      }
      return rows.length;
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if ((await this.relayOnce()) === BATCH) continue; // more waiting: go again at once
      } catch (err) {
        this.logger.error({ err }, 'outbox.relay_failed');
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}
