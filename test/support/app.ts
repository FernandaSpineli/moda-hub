import 'reflect-metadata';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { testConfig } from './config.js';
import { createTestDatabase } from './database.js';

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  /** Direct database access for setup and assertions. */
  sql: pg.Pool;
  /** Every log line written so far, parsed. */
  logs: Record<string, unknown>[];
  close: () => Promise<void>;
}

/** The real application, wired as in production, on a fresh database. */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const db = await createTestDatabase();
  const logs: Record<string, unknown>[] = [];
  const logStream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).trim().split('\n')) if (line) logs.push(JSON.parse(line));
      done();
    },
  });
  const app = await createApp({
    config: testConfig(db.url, overrides),
    logStream,
    // argon2's production cost (64 MiB per hash) would make the suite slow.
    hashOptions: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
  });
  await app.init();
  const sql = new pg.Pool({ connectionString: db.url, max: 2 });
  return {
    app,
    http: request(app.getHttpServer()),
    sql,
    logs,
    close: async () => {
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
