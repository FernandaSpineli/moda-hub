import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('HTTP foundation', () => {
  it('serves the health check with a request ID', async () => {
    const res = await t.http.get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[a-f0-9]{32}$/);
  });

  it('reports readiness of PostgreSQL and Redis', async () => {
    const res = await t.http.get('/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('answers unknown routes with the error envelope', async () => {
    const res = await t.http.get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', request_id: res.headers['x-request-id'] },
    });
  });

  it('rejects oversized bodies', async () => {
    const res = await t.http
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
  });

  it('rejects malformed JSON with a clear error', async () => {
    const res = await t.http
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it.each([
    ['propagates a well-formed request ID', 'trace-abc_123', true],
    ['replaces one with unsafe characters', 'x" level="error', false],
    ['replaces one that is too long', 'a'.repeat(65), false],
  ])('%s', async (_name, incoming, kept) => {
    const res = await t.http.get('/health').set('X-Request-ID', incoming);
    expect(res.headers['x-request-id'] === incoming).toBe(kept);
  });

  it('logs one structured line per request, without headers or query strings', async () => {
    t.logs.length = 0;
    await t.http.get('/health?token=secret-in-query').set('Authorization', 'Bearer abc.def');
    const entry = t.logs.find((l) => l.event === 'http.request');
    expect(entry).toMatchObject({
      level: 'info',
      service: 'moda-hub',
      req: { method: 'GET', path: '/health' },
      res: { status: 200 },
    });
    expect(entry?.request_id).toEqual(expect.any(String));
    const raw = JSON.stringify(t.logs);
    expect(raw).not.toContain('secret-in-query');
    expect(raw).not.toContain('abc.def');
  });
});
