import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { templates } from '../modules/notifications/templates.js';
import { loadOrder, lockOrder, type Order, OrdersService } from '../modules/orders/orders.service.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { DB, type Db } from '../platform/database.js';
import { MAILER, type Mailer } from '../platform/mailer.js';
import { JobRunner } from './job-runner.js';
import { type EventJobData, type NotificationJob, QUEUES } from './queues.js';

/** Logs jobs that failed, and whether they will be retried or are now dead-lettered. */
abstract class LoggedProcessor extends WorkerHost {
  constructor(protected readonly logger: PinoLogger) {
    super();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const final = (job?.attemptsMade ?? 0) >= attempts;
    this.logger[final ? 'error' : 'warn'](
      {
        queue: job?.queueName,
        job_id: job?.id,
        job_name: job?.name,
        attempt: job?.attemptsMade,
        reason: err.message,
      },
      final ? 'job.dead_lettered' : 'job.failed_will_retry',
    );
  }
}

/** Applies Stripe webhooks recorded by the API, with retries if the database hiccups. */
@Processor(QUEUES.stripeEvents, { concurrency: 5 })
export class StripeEventsProcessor extends LoggedProcessor {
  constructor(
    logger: PinoLogger,
    private readonly runner: JobRunner,
    private readonly payments: PaymentsService,
  ) {
    super(logger);
  }

  process(job: Job<EventJobData>): Promise<void> {
    return this.runner.run(job, () => this.payments.apply(job.data.eventId));
  }
}

/**
 * Expires unpaid orders when their reservation runs out. Each order has a
 * delayed job due at its expiry; if checkout extended the reservation
 * meanwhile, the job reschedules itself. A periodic sweep catches any order
 * whose job was lost.
 */
@Processor(QUEUES.orderExpiry)
export class OrderExpiryProcessor extends LoggedProcessor {
  constructor(
    logger: PinoLogger,
    private readonly runner: JobRunner,
    private readonly orders: OrdersService,
    @Inject(DB) private readonly db: Db,
    @InjectQueue(QUEUES.orderExpiry) private readonly queue: Queue,
  ) {
    super(logger);
  }

  process(job: Job<EventJobData>): Promise<void> {
    if (job.name === 'sweep') return this.runner.run(job, () => this.sweep());
    return this.runner.run(job, () => this.expire(job.data.payload.orderId as string, job.data));
  }

  private async expire(orderId: string, data: EventJobData): Promise<void> {
    await this.db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (order?.status !== 'pending_payment') return; // gone, paid or closed meanwhile
      const due = order.expiresAt?.getTime() ?? 0;
      if (due > Date.now()) {
        await this.queue.add('expire', data, { delay: due - Date.now(), jobId: `${orderId}.expire.${due}` });
        this.logger.info({ order_id: orderId, expires_at: order.expiresAt }, 'order.expiry_rescheduled');
        return;
      }
      await this.orders.transition(tx, order, 'expired', 'payment window elapsed');
    });
  }

  private async sweep(): Promise<void> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at <= now() ORDER BY expires_at LIMIT 100`);
    for (const { id } of rows) await this.expire(id, { eventId: id, payload: { orderId: id } });
    if (rows.length > 0) this.logger.warn({ expired: rows.length }, 'order.expiry_sweep_caught_up');
  }
}

/** Transactional email, one job per event and template. */
@Processor(QUEUES.notifications, { concurrency: 5 })
export class NotificationsProcessor extends LoggedProcessor {
  constructor(
    logger: PinoLogger,
    private readonly runner: JobRunner,
    private readonly auth: AuthService,
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super(logger);
  }

  process(job: Job<EventJobData>): Promise<void> {
    const name = job.name as NotificationJob;
    return this.runner.once(job, `notifications:${name}`, async () => {
      const email = await this.compose(name, job.data.payload);
      if (!email) return;
      await this.mailer.send(email);
      // Recipients are personal data: log the template and user, never the address.
      this.logger.info({ template: name, user_id: job.data.payload.userId }, 'mail.sent');
    });
  }

  private async compose(name: NotificationJob, payload: Record<string, unknown>) {
    const user = await this.user(payload.userId as string);
    if (!user) return undefined;
    if (name === 'password-reset') {
      // The token is created here, only to be put in the email: it is never
      // stored in plain text, not in the outbox and not in the queue.
      const issued = await this.auth.issuePasswordResetToken(user.id);
      if (!issued) return undefined;
      const link = `${this.config.baseUrl}/reset-password?token=${encodeURIComponent(issued.token)}`;
      return templates.passwordReset(
        user.email,
        user.name,
        link,
        Math.round(this.config.auth.passwordResetTtlMs / 60_000),
      );
    }
    const order = (await loadOrder(this.db, payload.orderId as string)) as Order;
    switch (name) {
      case 'order-confirmation':
        return templates.orderConfirmation(
          user.email,
          user.name,
          order,
          `${this.config.baseUrl}/orders/${order.id}`,
        );
      case 'payment-confirmed':
        return templates.paymentConfirmed(user.email, user.name, order);
      case 'order-shipped':
        return templates.orderShipped(user.email, user.name, order, String(payload.reason ?? ''));
      case 'order-closed':
        return templates.orderClosed(user.email, user.name, order, payload.to as 'cancelled' | 'expired');
    }
  }

  private async user(id: string) {
    const { rows } = await this.db.execute<{ id: string; email: string; name: string }>(
      sql`SELECT id, email, name FROM users WHERE id = ${id}`,
    );
    return rows[0];
  }
}

/** After a sale, warns admins about variants at or below their low-stock threshold. */
@Processor(QUEUES.inventoryAlerts)
export class InventoryAlertsProcessor extends LoggedProcessor {
  constructor(
    logger: PinoLogger,
    private readonly runner: JobRunner,
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {
    super(logger);
  }

  process(job: Job<EventJobData>): Promise<void> {
    return this.runner.once(job, 'inventory-alerts', async () => {
      const { rows: low } = await this.db.execute<{
        sku: string;
        product_name: string;
        available: number;
      }>(sql`
        SELECT oi.sku, oi.product_name, i.on_hand - i.reserved AS available
        FROM order_items oi JOIN inventory i ON i.variant_id = oi.variant_id
        WHERE oi.order_id = ${job.data.payload.orderId} AND i.on_hand - i.reserved <= i.low_stock_threshold
        ORDER BY oi.sku`);
      if (low.length === 0) return;
      const { rows: admins } = await this.db.execute<{ email: string }>(
        sql`SELECT email FROM users WHERE role = 'admin'`,
      );
      const items = low.map((r) => ({
        sku: r.sku,
        productName: r.product_name,
        available: Number(r.available),
      }));
      for (const admin of admins) await this.mailer.send(templates.lowStock(admin.email, items));
      this.logger.warn({ skus: items.map((i) => i.sku), admins: admins.length }, 'inventory.low_stock');
    });
  }
}

/** Registers the safety-net sweep for expired orders. */
@Injectable()
export class ExpirySweepScheduler {
  constructor(@InjectQueue(QUEUES.orderExpiry) private readonly queue: Queue) {}

  async schedule(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expiry-sweep',
      { every: 5 * 60_000 },
      { name: 'sweep', data: { eventId: 'sweep', payload: {} } },
    );
  }
}
