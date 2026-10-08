import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { loggerParams } from './common/logging.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { HealthController } from './health/health.controller.js';

export interface AppOptions {
  config: AppConfig;
  /** Where logs go; tests capture them, production uses stdout. */
  logStream?: DestinationStream;
}

@Module({})
export class AppModule {
  static register({ config, logStream }: AppOptions): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [LoggerModule.forRoot(loggerParams(config, logStream))],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
      exports: [APP_CONFIG],
    };
  }
}
