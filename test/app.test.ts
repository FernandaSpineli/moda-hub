import 'reflect-metadata';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig } from './support/config.js';

let app: INestApplication;
const lines: Record<string, unknown>[] = [];
const logStream = new Writable({
  write(chunk, _enc, done) {
    for (const line of String(chunk).trim().split('\n')) lines.push(JSON.parse(line));
    done();
  },
});

beforeAll(async () => {
  app = await createApp({ config: testConfig(), logStream });
  await app.init();
});
afterAll(() => app.close());

describe('HTTP foundation', () => {
  it('serves the health check with a request ID', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[a-f0-9]{32}$/);
  });

  it('reports readiness of PostgreSQL and Redis', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('answers unknown routes with the error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', request_id: res.headers['x-request-id'] },
    });
  });

  it('rejects oversized bodies', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/nope')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
  });

  it('rejects malformed JSON with a clear error', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/nope')
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it.each([
    ['propagates a well-formed request ID', 'trace-abc_123', true],
    ['replaces one with unsafe characters', 'x" level="error', false],
    ['replaces one that is too long', 'a'.repeat(65), false],
  ])('%s', async (_name, incoming, kept) => {
    const res = await request(app.getHttpServer()).get('/health').set('X-Request-ID', incoming);
    expect(res.headers['x-request-id'] === incoming).toBe(kept);
  });

  it('logs one structured line per request, without headers', async () => {
    lines.length = 0;
    await request(app.getHttpServer())
      .get('/health?token=secret-in-query')
      .set('Authorization', 'Bearer abc.def');
    const entry = lines.find((l) => l.event === 'http.request');
    expect(entry).toMatchObject({
      level: 'info',
      service: 'moda-hub',
      req: { method: 'GET', path: '/health' },
      res: { status: 200 },
    });
    expect(entry?.request_id).toEqual(expect.any(String));
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain('secret-in-query');
    expect(raw).not.toContain('abc.def');
  });
});
