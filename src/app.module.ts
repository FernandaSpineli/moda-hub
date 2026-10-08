import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { loggerParams } from './common/logging.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HASH_OPTIONS, type HashOptions } from './modules/auth/password-hasher.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { DatabaseModule } from './platform/database.js';
import { RedisModule } from './platform/redis.js';

export interface AppOptions {
  config: AppConfig;
  /** Where logs go; tests capture them, production uses stdout. */
  logStream?: DestinationStream;
  /** argon2 cost; tests lower it for speed. Defaults to the library's. */
  hashOptions?: HashOptions;
}

@Module({})
export class AppModule implements NestModule {
  static register({ config, logStream, hashOptions = {} }: AppOptions): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot(loggerParams(config, logStream)),
        DatabaseModule,
        RedisModule,
        AuthModule,
        CatalogModule,
        CartModule,
        OrdersModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: HASH_OPTIONS, useValue: hashOptions },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
      exports: [APP_CONFIG, HASH_OPTIONS],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
