import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type pg from 'pg';
import { Public } from '../modules/auth/decorators.js';
import { PG_POOL } from '../platform/database.js';
import { REDIS } from '../platform/redis.js';

const CHECK_TIMEOUT_MS = 2_000;

@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {}

  /** Liveness: the process is up and serving requests. */
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /**
   * Readiness: every dependency answers. Failures are logged but only
   * "unavailable" is returned, so the endpoint reveals no infrastructure
   * details.
   */
  @Get('ready')
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, () => Promise<unknown>> = {
      postgres: () => this.pool.query('SELECT 1'),
      redis: () => this.redis.ping(),
    };
    const results: Record<string, 'ok' | 'unavailable'> = {};
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          results[name] = 'ok';
        } catch (err) {
          this.logger.warn({ dependency: name, reason: (err as Error).message }, 'readiness.check_failed');
          results[name] = 'unavailable';
        }
      }),
    );
    const ok = Object.values(results).every((r) => r === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: results };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
