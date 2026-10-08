import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { withCorrelationId } from '../common/request-context.js';
import { DB, type Db } from '../platform/database.js';
import { JOB_METRICS, type JobMetrics } from '../platform/metrics.js';
import type { EventJobData } from './queues.js';

/**
 * Runs a job inside its own logging and correlation context, so every log
 * line it causes — including those of reused services — carries the queue,
 * job ID, attempt and the ID of the request that started the chain.
 */
@Injectable()
export class JobRunner {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
    @Inject(JOB_METRICS) private readonly metrics: JobMetrics,
  ) {}

  run<T>(job: Job<EventJobData>, fn: () => Promise<T>): Promise<T> {
    const bindings = {
      queue: job.queueName,
      job_id: job.id,
      job_name: job.name,
      attempt: job.attemptsMade + 1,
      correlation_id: job.data.correlationId ?? undefined,
    };
    return this.logger.runInContext(
      () =>
        withCorrelationId(job.data.correlationId ?? undefined, async () => {
          const labels = { queue: job.queueName, name: job.name };
          const stop = this.metrics.duration.startTimer(labels);
          try {
            const started = Date.now();
            const result = await fn();
            stop();
            this.metrics.jobs.inc({ ...labels, outcome: 'completed' });
            this.logger.info({ duration_ms: Date.now() - started }, 'job.completed');
            return result;
          } catch (err) {
            const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
            this.metrics.jobs.inc({ ...labels, outcome: final ? 'dead_lettered' : 'failed' });
            throw err;
          }
        }),
      { bindings },
    );
  }

  /**
   * For consumers whose side effect is outside the database (email): skip
   * an event this consumer already handled. Queues deliver at least once;
   * the window between sending and recording is the only place a duplicate
   * can slip through.
   */
  async once(job: Job<EventJobData>, consumer: string, fn: () => Promise<void>): Promise<void> {
    return this.run(job, async () => {
      const { rows } = await this.db.execute(sql`
        SELECT 1 FROM processed_events WHERE consumer = ${consumer} AND event_id = ${job.data.eventId}`);
      if (rows.length > 0) {
        this.logger.info({ consumer }, 'job.duplicate_skipped');
        return;
      }
      await fn();
      await this.db.execute(sql`
        INSERT INTO processed_events (consumer, event_id) VALUES (${consumer}, ${job.data.eventId})
        ON CONFLICT DO NOTHING`);
    });
  }
}
