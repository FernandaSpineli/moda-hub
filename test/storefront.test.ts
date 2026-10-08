import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

describe('storefront', () => {
  it.each(['/', '/checkout/success?order_id=x', '/checkout/cancel?order_id=x', '/reset-password?token=x'])(
    'serves the shop at %s',
    async (path) => {
      const res = await t.http.get(path).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.text).toContain('<title>Moda Hub</title>');
    },
  );

  it('allows only its own inline script', async () => {
    const res = await t.http.get('/').expect(200);
    const script = /<script>([\s\S]*?)<\/script>/.exec(res.text)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('stays out of the API namespace and docs', async () => {
    await t.http.get('/api/v1/').expect(404);
    const doc = (await t.http.get('/docs/openapi.json').expect(200)).body;
    expect(Object.keys(doc.paths)).not.toContain('/');
  });
});
