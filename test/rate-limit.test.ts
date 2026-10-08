import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS } from '../src/platform/redis.js';
import { startTestApp, type TestApp } from './support/app.js';
import { testConfig } from './support/config.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ env: { RATE_LIMIT: 'on', TRUST_PROXY: 'loopback' } });
});
afterAll(() => t.close());

const login = (email: string, ip: string) =>
  t.http.post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'wrong-password' });

describe('rate limits', () => {
  it('stop guessing one account from many addresses', async () => {
    const email = 'alvo@example.com';
    for (let i = 0; i < 10; i++) expect((await login(email, `203.0.113.${i}`)).status).toBe(401);
    const blocked = await login(email, '203.0.113.200').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(900);
    // Other accounts are unaffected.
    await login('outra@example.com', '203.0.113.201').expect(401);
  });

  it('stop one address from trying many accounts', async () => {
    for (let i = 0; i < 20; i++) await login(`conta${i}@example.com`, '198.51.100.7').expect(401);
    await login('conta-final@example.com', '198.51.100.7').expect(429);
    await login('conta-final@example.com', '198.51.100.8').expect(401);
  });

  it('cap password reset emails per inbox', async () => {
    const forgot = (ip: string) =>
      t.http
        .post('/api/v1/auth/password/forgot')
        .set('X-Forwarded-For', ip)
        .send({ email: 'caixa@example.com' });
    for (let i = 0; i < 3; i++) await forgot(`192.0.2.${i}`).expect(202);
    await forgot('192.0.2.99').expect(429);
  });

  it('never store the email or address in clear', async () => {
    const keys = await t.app.get<Redis>(REDIS).keys('*ratelimit*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toMatch(/@|203\.0\.113|198\.51/);
  });
});

describe('TRUST_PROXY', () => {
  it.each([
    ['1', 1],
    ['loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
  ])('accepts %j', (value, parsed) => {
    expect(testConfig('postgres://x', { TRUST_PROXY: value }).trustProxy).toEqual(parsed);
  });

  it('refuses "true", which lets clients choose their own IP', () => {
    expect(() => testConfig('postgres://x', { TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });
});
