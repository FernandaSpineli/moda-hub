import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';
import { ConfigError, loadConfig } from './config/config.js';
import { OutboxRelay } from './jobs/outbox-relay.js';
import { ExpirySweepScheduler } from './jobs/processors.js';
import { WorkerModule, type WorkerOptions } from './worker.module.js';

/** Starts the worker: queue processors, the outbox relay and the expiry sweep. */
export async function createWorker(options: WorkerOptions): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule.register(options), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.get(ExpirySweepScheduler).schedule();
  app.get(OutboxRelay).start();
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const worker = await createWorker({ config });
  (await worker.resolve(PinoLogger)).info({ queue_prefix: config.queuePrefix }, 'worker.started');
}

// Run only when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `moda-hub worker: ${err instanceof ConfigError ? err.message : String((err as Error)?.stack ?? err)}\n`,
    );
    process.exit(1);
  });
}
