import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { QUEUES, queueNames } from '../../src/jobs/queues.js';
import type { PaymentGateway } from '../../src/modules/payments/payment-gateway.js';
import { createWorker } from '../../src/worker.js';
import { testConfig } from './config.js';
import { createTestDatabase } from './database.js';
import { FakeGateway } from './fake-gateway.js';
import { FakeMailer } from './fake-mailer.js';

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  /** Direct database access for setup and assertions. */
  sql: pg.Pool;
  /** Every log line written so far, parsed. */
  logs: Record<string, unknown>[];
  /** The stand-in for Stripe (null when payments are disabled). */
  gateway: FakeGateway | null;
  /** Email the worker "sent". */
  mailer: FakeMailer;
  /** The worker, when started with { worker: true }. */
  worker?: INestApplicationContext;
  /** Resolves once the outbox is drained and no job is waiting or running. */
  idle: (timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

/** The real application, wired as in production, on a fresh database. */
export async function startTestApp(
  options: { env?: Record<string, string>; paymentGateway?: PaymentGateway | null; worker?: boolean } = {},
): Promise<TestApp> {
  const gateway = options.paymentGateway === undefined ? new FakeGateway() : options.paymentGateway;
  const db = await createTestDatabase();
  const logs: Record<string, unknown>[] = [];
  const logStream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).trim().split('\n')) if (line) logs.push(JSON.parse(line));
      done();
    },
  });
  // Each test file gets its own queues in the shared Redis.
  const config = testConfig(db.url, {
    QUEUE_PREFIX: `test-${randomBytes(4).toString('hex')}`,
    JOB_RETRY_BASE_DELAY: '20ms',
    WORKER_PORT: '0', // any free port
    // Tests sign up many accounts from one IP; test/rate-limit.test.ts turns limits on.
    RATE_LIMIT: 'off',
    ...options.env,
  });
  const hashOptions = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
  const mailer = new FakeMailer();
  const app = await createApp({
    config,
    paymentGateway: gateway,
    logStream,
    // argon2's production cost (64 MiB per hash) would make the suite slow.
    hashOptions,
  });
  // Listen on a real port: supertest then connects to it instead of starting
  // the server itself for every request, which concurrent tests would pile up.
  await app.listen(0, '127.0.0.1');
  const worker: INestApplicationContext | undefined = options.worker
    ? await createWorker({ config, logStream, hashOptions, paymentGateway: gateway, mailer })
    : undefined;
  const sql = new pg.Pool({ connectionString: db.url, max: 2 });
  return {
    app,
    http: request(app.getHttpServer()),
    sql,
    logs,
    gateway: gateway instanceof FakeGateway ? gateway : null,
    mailer,
    worker,
    idle: async (timeoutMs = 15_000) => {
      if (!worker) throw new Error('start the app with { worker: true } to process jobs');
      const queues = queueNames.map((n) => app.get<Queue>(getQueueToken(n)));
      const deadline = Date.now() + timeoutMs;
      let quietChecks = 0;
      while (quietChecks < 2) {
        if (Date.now() > deadline) throw new Error('jobs did not settle in time');
        const { rows } = await sql.query(
          'SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL',
        );
        const counts = await Promise.all(
          // Retries wait in "delayed" (backoff), so count those too — except
          // expiry jobs, which are legitimately delayed until the reservation ends.
          queues.map((q) =>
            q.getJobCounts(
              'waiting',
              'active',
              'prioritized',
              ...(q.name === QUEUES.orderExpiry ? [] : (['delayed'] as const)),
            ),
          ),
        );
        const busy =
          rows[0].n +
          counts.reduce(
            (n, c) => n + (c.waiting ?? 0) + (c.active ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0),
            0,
          );
        quietChecks = busy === 0 ? quietChecks + 1 : 0;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close: async () => {
      await worker?.close();
      await app.close();
      await sql.end();
      await db.drop();
    },
  };
}

let seq = 0;

/** Registers a fresh account and returns its access token and refresh cookie. */
export async function signUp(t: TestApp, role: 'customer' | 'admin' = 'customer') {
  seq += 1;
  const email = `${role}${seq}-${process.pid}@example.com`;
  const res = await t.http
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123', name: 'Test User' });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (role === 'admin') {
    await t.sql.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
    const login = await t.http.post('/api/v1/auth/login').send({ email, password: 'password123' });
    return {
      email,
      userId: login.body.user.id as string,
      token: login.body.accessToken as string,
      cookie: refreshCookie(login),
    };
  }
  return {
    email,
    userId: res.body.user.id as string,
    token: res.body.accessToken as string,
    cookie: refreshCookie(res),
  };
}

/** The "refresh_token=..." pair from a response's Set-Cookie header. */
export function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const cookie = cookies.find((c) => c.startsWith('refresh_token='));
  return cookie?.split(';')[0] ?? '';
}
