import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { loggerParams } from '../common/logging.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { HASH_OPTIONS, type HashOptions } from '../modules/auth/password-hasher.js';
import { PAYMENT_GATEWAY, type PaymentGateway, StripeGateway } from '../modules/payments/payment-gateway.js';
import { DatabaseModule } from './database.js';
import { OutboxService } from './outbox.js';
import { RedisModule } from './redis.js';

export interface PlatformOptions {
  config: AppConfig;
  /** Where logs go; tests capture them, production uses stdout. */
  logStream?: DestinationStream;
  /** argon2 cost; tests lower it for speed. Defaults to the library's. */
  hashOptions?: HashOptions;
  /** Replaces Stripe (tests use a fake); null disables payments. */
  paymentGateway?: PaymentGateway | null;
}

/**
 * Infrastructure shared by the API and the worker: configuration, logging,
 * PostgreSQL, Redis, the queues and the outbox.
 */
@Module({})
export class PlatformModule {
  static register({ config, logStream, hashOptions = {}, paymentGateway }: PlatformOptions): DynamicModule {
    const gateway =
      paymentGateway !== undefined
        ? paymentGateway
        : config.stripe
          ? new StripeGateway(config.stripe.secretKey.reveal())
          : null;
    return {
      module: PlatformModule,
      global: true,
      imports: [
        LoggerModule.forRoot(loggerParams(config, logStream)),
        DatabaseModule,
        RedisModule,
        JobsModule,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: HASH_OPTIONS, useValue: hashOptions },
        { provide: PAYMENT_GATEWAY, useValue: gateway },
        OutboxService,
      ],
      exports: [APP_CONFIG, HASH_OPTIONS, PAYMENT_GATEWAY, OutboxService, JobsModule],
    };
  }
}
