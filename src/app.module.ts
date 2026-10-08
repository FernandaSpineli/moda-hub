import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { HttpMetricsMiddleware } from './common/http-metrics.middleware.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './health/metrics.controller.js';
import { AdminJobsController } from './jobs/admin-jobs.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { createRegistry, HTTP_METRICS, httpMetrics, METRICS_REGISTRY } from './platform/metrics.js';
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
      controllers: [HealthController, MetricsController, AdminJobsController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: METRICS_REGISTRY, useFactory: () => createRegistry('api') },
        { provide: HTTP_METRICS, inject: [METRICS_REGISTRY], useFactory: httpMetrics },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, HttpMetricsMiddleware).forRoutes('*path');
  }
}
