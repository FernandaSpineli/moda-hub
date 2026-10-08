import { type DynamicModule, Module } from '@nestjs/common';
import { JobRunner } from './jobs/job-runner.js';
import { OutboxRelay } from './jobs/outbox-relay.js';
import {
  ExpirySweepScheduler,
  InventoryAlertsProcessor,
  NotificationsProcessor,
  OrderExpiryProcessor,
  StripeEventsProcessor,
} from './jobs/processors.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { MAILER, type Mailer, SmtpMailer } from './platform/mailer.js';
import { PlatformModule, type PlatformOptions } from './platform/platform.module.js';

export interface WorkerOptions extends PlatformOptions {
  /** Replaces SMTP (tests capture mail). */
  mailer?: Mailer;
}

/** The background worker: outbox relay and queue processors, no HTTP. */
@Module({})
export class WorkerModule {
  static register({ mailer, ...platform }: WorkerOptions): DynamicModule {
    const { config } = platform;
    return {
      module: WorkerModule,
      imports: [PlatformModule.register(platform), AuthModule, OrdersModule, PaymentsModule],
      providers: [
        {
          provide: MAILER,
          useValue: mailer ?? new SmtpMailer(config.mail.smtpUrl.reveal(), config.mail.from),
        },
        JobRunner,
        OutboxRelay,
        ExpirySweepScheduler,
        StripeEventsProcessor,
        OrderExpiryProcessor,
        NotificationsProcessor,
        InventoryAlertsProcessor,
      ],
    };
  }
}
