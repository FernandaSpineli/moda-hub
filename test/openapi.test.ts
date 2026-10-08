import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('OpenAPI', () => {
  it('documents every route, with request schemas taken from the Zod validators', async () => {
    const doc = (await t.http.get('/docs/openapi.json').expect(200)).body;
    expect(doc.openapi).toMatch(/^3\./);
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/register',
        '/api/v1/products',
        '/api/v1/products/{slug}',
        '/api/v1/cart/items',
        '/api/v1/orders',
        '/api/v1/orders/{id}/checkout',
        '/api/v1/payments/webhook',
        '/api/v1/admin/products',
        '/api/v1/admin/jobs/failed',
        '/health',
        '/.well-known/jwks.json',
      ]),
    );

    const register = doc.paths['/api/v1/auth/register'].post.requestBody.content['application/json'].schema;
    expect(register.required).toEqual(expect.arrayContaining(['email', 'password', 'name']));
    expect(register.additionalProperties).toBe(false);

    const list = doc.paths['/api/v1/products'].get.parameters as { name: string; in: string }[];
    expect(list.map((p) => p.name)).toEqual(
      expect.arrayContaining(['q', 'size', 'color', 'cursor', 'limit']),
    );

    const placeOrder = doc.paths['/api/v1/orders'].post;
    expect(placeOrder.security).toEqual([{ bearer: [] }]);
    expect(placeOrder.parameters.map((p: { name: string }) => p.name)).toContain('Idempotency-Key');
  });

  it('serves the interactive docs without authentication', async () => {
    const res = await t.http.get('/docs').redirects(1).expect(200);
    expect(res.text).toContain('swagger');
  });
});
