import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { from, lastValueFrom, type Observable, of } from 'rxjs';
import { REDIS } from '../platform/redis.js';
import { AppError } from './app-error.js';

const TTL_SECONDS = 24 * 60 * 60;
const HEADER = 'idempotency-key';

interface Stored {
  done: boolean;
  fingerprint: string;
  status?: number;
  location?: string;
  body?: unknown;
}

/**
 * Makes a POST safe to retry. A client sends an Idempotency-Key; the first
 * request with it runs and its successful response is kept for 24 hours, so
 * a retry (say, after a timeout) gets the same response instead of creating
 * a second order. Keys are scoped per user and bound to the request body.
 * Failed requests are not kept, so they can be retried with the same key.
 *
 * Must run after authentication (interceptors do).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('idempotency');
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.headers[HEADER];
    if (typeof key !== 'string' || key === '') return next.handle();
    if (key.length > 255) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be at most 255 characters');
    }
    return from(this.run(req, res, key, next));
  }

  private async run(req: Request, res: Response, key: string, next: CallHandler): Promise<unknown> {
    const fingerprint = createHash('sha256')
      .update(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');
    const redisKey = `idempotency:${req.user?.userId ?? 'anonymous'}:${key}`;

    const pending: Stored = { done: false, fingerprint };
    const first = await this.redis.set(redisKey, JSON.stringify(pending), 'EX', TTL_SECONDS, 'NX');
    if (first !== 'OK') return this.replay(res, redisKey, fingerprint);

    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      const stored: Stored = {
        done: true,
        fingerprint,
        status: res.statusCode,
        location: res.getHeader('location') as string | undefined,
        body,
      };
      await this.redis.set(redisKey, JSON.stringify(stored), 'EX', TTL_SECONDS);
      return body;
    } catch (err) {
      await this.redis.del(redisKey);
      throw err;
    }
  }

  private async replay(res: Response, redisKey: string, fingerprint: string): Promise<unknown> {
    const raw = await this.redis.get(redisKey);
    const stored = raw ? (JSON.parse(raw) as Stored) : undefined;
    if (!stored?.done) {
      throw new AppError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'A request with this Idempotency-Key is still being processed',
      );
    }
    if (stored.fingerprint !== fingerprint) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    }
    this.logger.info({ status: stored.status }, 'idempotency.replayed');
    res.status(stored.status ?? 200);
    res.setHeader('Idempotent-Replayed', 'true');
    if (stored.location) res.setHeader('Location', stored.location);
    return lastValueFrom(of(stored.body));
  }
}
