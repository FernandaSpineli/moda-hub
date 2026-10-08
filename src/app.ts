import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppOptions } from './app.module.js';

/**
 * Builds the HTTP application. main.ts and the API tests both use it, so
 * tests exercise the real wiring and middleware.
 */
export async function createApp(options: AppOptions): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    bufferLogs: true,
    // Stripe signs the exact bytes of a webhook body.
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  app.useBodyParser('json', { limit: '1mb' });
  app.disable('x-powered-by');
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready', 'metrics', '.well-known/jwks.json'] });
  app.enableShutdownHooks();
  return app;
}
