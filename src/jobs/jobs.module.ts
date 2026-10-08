import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { bullConnection, defaultJobOptions, queueNames } from './queues.js';

/** The queues, for producers (API and worker alike). Processors live in the worker. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: bullConnection(config),
        prefix: config.queuePrefix,
        defaultJobOptions: defaultJobOptions(config),
      }),
    }),
    ...queueNames.map((name) => BullModule.registerQueue({ name })),
  ],
  exports: [BullModule],
})
export class JobsModule {}
