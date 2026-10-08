import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { HealthController } from './health/health.controller.js';
import { AdminJobsController } from './jobs/admin-jobs.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PlatformModule, type PlatformOptions } from './platform/platform.module.js';

export type AppOptions = PlatformOptions;

/** The HTTP API. */
@Module({})
export class AppModule implements NestModule {
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.register(options),
        AuthModule,
        CatalogModule,
        CartModule,
        OrdersModule,
        PaymentsModule,
      ],
      controllers: [HealthController, AdminJobsController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
