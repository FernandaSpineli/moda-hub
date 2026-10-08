import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

function controller(pgOk: boolean, redisOk: boolean) {
  const pool = {
    query: () => (pgOk ? Promise.resolve({}) : Promise.reject(new Error('ECONNREFUSED 10.0.0.7'))),
  };
  const redis = { ping: () => (redisOk ? Promise.resolve('PONG') : new Promise(() => {})) }; // hangs
  const logger = { warn: vi.fn() };
  return {
    logger,
    ctl: new HealthController(
      pool as unknown as pg.Pool,
      redis as unknown as Redis,
      logger as unknown as PinoLogger,
    ),
  };
}

function response() {
  const res = {
    statusCode: 0,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
  };
  return res;
}

describe('HealthController.ready', () => {
  it('is ready when every dependency answers', async () => {
    const res = response();
    const body = await controller(true, true).ctl.ready(res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(body).toEqual({ status: 'ok', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('answers 503 without leaking details when a dependency fails or hangs', async () => {
    vi.useFakeTimers();
    const { ctl, logger } = controller(false, false);
    const res = response();
    const pending = ctl.ready(res as unknown as Response);
    await vi.advanceTimersByTimeAsync(2_000);
    const body = await pending;
    vi.useRealTimers();

    expect(res.statusCode).toBe(503);
    expect(body).toEqual({
      status: 'unavailable',
      checks: { postgres: 'unavailable', redis: 'unavailable' },
    });
    expect(JSON.stringify(body)).not.toContain('10.0.0.7');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
