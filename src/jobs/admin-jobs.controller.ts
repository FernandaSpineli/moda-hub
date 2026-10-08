import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { notFound } from '../common/app-error.js';
import { ApiZodQuery } from '../common/openapi.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { RequireRole } from '../modules/auth/decorators.js';
import { QUEUES, type QueueName, queueNames } from './queues.js';

const listSchema = z.strictObject({
  queue: z.enum(queueNames as [QueueName, ...QueueName[]]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The dead-letter queue: jobs that used up their retries, for an admin to inspect and retry. */
@ApiTags('admin: jobs')
@ApiBearerAuth()
@RequireRole('admin')
@Controller('admin/jobs')
export class AdminJobsController {
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    private readonly logger: PinoLogger,
    @InjectQueue(QUEUES.notifications) notifications: Queue,
    @InjectQueue(QUEUES.orderExpiry) orderExpiry: Queue,
    @InjectQueue(QUEUES.inventoryAlerts) inventoryAlerts: Queue,
    @InjectQueue(QUEUES.stripeEvents) stripeEvents: Queue,
  ) {
    logger.setContext('jobs');
    this.queues = {
      [QUEUES.notifications]: notifications,
      [QUEUES.orderExpiry]: orderExpiry,
      [QUEUES.inventoryAlerts]: inventoryAlerts,
      [QUEUES.stripeEvents]: stripeEvents,
    };
  }

  @Get('failed')
  @ApiZodQuery(listSchema)
  async failed(@Query(new ZodValidationPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const names = q.queue ? [q.queue] : queueNames;
    const jobs = (await Promise.all(names.map((n) => this.queues[n].getFailed(0, q.limit - 1)))).flat();
    return {
      data: jobs.map((j) => ({
        queue: j.queueName,
        id: j.id,
        name: j.name,
        attemptsMade: j.attemptsMade,
        failedReason: j.failedReason,
        failedAt: j.finishedOn ? new Date(j.finishedOn) : null,
        // Job data holds IDs only (never tokens or addresses), so it is safe to show.
        data: j.data,
      })),
    };
  }

  @Post(':queue/:id/retry')
  @HttpCode(202)
  async retry(@Param('queue') queue: string, @Param('id') id: string) {
    const q = this.queues[queue as QueueName];
    const job = q ? await q.getJob(id) : undefined;
    if (!job || !(await job.isFailed()))
      throw notFound('JOB_NOT_FOUND', 'No failed job with that ID in that queue');
    await job.retry('failed');
    this.logger.info({ queue, job_id: id }, 'job.retried_by_admin');
    return { status: 'queued' };
  }
}
