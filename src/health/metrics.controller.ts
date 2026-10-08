import { getQueueToken } from '@nestjs/bullmq';
import { Controller, Get, Header, Inject, type OnModuleInit, Req } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Gauge, type Registry } from '@prometheus-io/client';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import type pg from 'pg';
import { AppError } from '../common/app-error.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { queueNames } from '../jobs/queues.js';
import { Public } from '../modules/auth/decorators.js';
import { PG_POOL } from '../platform/database.js';
import { METRICS_REGISTRY, metricsAuthorized } from '../platform/metrics.js';

const JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/** Prometheus scrape endpoint for the API, plus queue and outbox gauges read at scrape time. */
@Public()
@Controller()
export class MetricsController implements OnModuleInit {
  constructor(
    @Inject(METRICS_REGISTRY) private readonly registry: Registry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    const queues = queueNames.map((name) =>
      this.moduleRef.get<Queue>(getQueueToken(name), { strict: false }),
    );
    new Gauge({
      name: 'moda_queue_jobs',
      help: 'Jobs per queue and state; a growing "failed" count is the dead-letter queue',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
      collect: async function () {
        for (const q of queues) {
          const counts = await q.getJobCounts(...JOB_STATES);
          for (const state of JOB_STATES) this.set({ queue: q.name, state }, counts[state] ?? 0);
        }
      },
    });
    const pool = this.pool;
    new Gauge({
      name: 'moda_outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox event (0 when the outbox is empty)',
      registers: [this.registry],
      collect: async function () {
        const { rows } = await pool.query(
          'SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0) AS lag FROM outbox_events WHERE published_at IS NULL',
        );
        this.set(Number(rows[0].lag));
      },
    });
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Req() req: Request) {
    if (!metricsAuthorized(this.config, req.headers.authorization)) {
      throw new AppError(401, 'UNAUTHORIZED', 'A valid metrics token is required');
    }
    req.res?.type(this.registry.contentType);
    return this.registry.metrics();
  }
}
