import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseDuration } from './config.js';

const pem = (type: 'ed25519' | 'rsa') =>
  Buffer.from(
    (type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ed25519')
    ).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string,
  ).toString('base64');

const required = {
  DATABASE_URL: 'postgres://localhost/moda',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: pem('ed25519'),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(required)).toMatchObject({
      env: 'development',
      port: 3000,
      logLevel: 'info',
      shutdownTimeoutMs: 15_000,
    });
  });

  it('reads overrides and treats empty strings as unset', () => {
    const cfg = loadConfig({
      ...required,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      SHUTDOWN_TIMEOUT: '',
    });
    expect(cfg).toMatchObject({
      env: 'production',
      port: 8080,
      logLevel: 'debug',
      shutdownTimeoutMs: 15_000,
    });
    expect(cfg.databaseUrl.reveal()).toBe('postgres://localhost/moda');
  });

  it('reports every invalid variable at once', () => {
    const load = () =>
      loadConfig({ NODE_ENV: 'staging', PORT: 'http', SHUTDOWN_TIMEOUT: 'soon', REDIS_URL: 'http://x' });
    expect(load).toThrow(ConfigError);
    try {
      load();
    } catch (err) {
      for (const key of [
        'NODE_ENV',
        'PORT',
        'SHUTDOWN_TIMEOUT',
        'DATABASE_URL',
        'REDIS_URL',
        'JWT_PRIVATE_KEY',
      ]) {
        expect((err as Error).message).toContain(key);
      }
    }
  });
});

describe('JWT_PRIVATE_KEY', () => {
  it('accepts an Ed25519 key', () => {
    expect(loadConfig(required).auth.signingKey.asymmetricKeyType).toBe('ed25519');
  });

  it.each([
    ['an RSA key', () => pem('rsa'), 'expected an Ed25519 key'],
    ['garbage', () => 'bm90IGEga2V5', 'invalid key'],
  ])('rejects %s', (_name, value, message) => {
    expect(() => loadConfig({ ...required, JWT_PRIVATE_KEY: value() })).toThrow(message);
  });
});

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['720h', 2_592_000_000],
  ])('%s = %i ms', (input, ms) => expect(parseDuration(input)).toBe(ms));

  it.each(['', '15', '1d', '-5m', 'soon'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow();
  });
});

describe('Stripe keys', () => {
  it.each([
    ['not configured outside production', {}, null],
    ['test keys', { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }, null],
    ['missing in production', { NODE_ENV: 'production' }, 'required in production'],
    ['only one of the pair', { STRIPE_SECRET_KEY: 'sk_test_1' }, 'set together'],
    [
      'a publishable key',
      { STRIPE_SECRET_KEY: 'pk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' },
      'secret or restricted',
    ],
    [
      'a live key outside production',
      { STRIPE_SECRET_KEY: 'sk_live_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' },
      'live keys',
    ],
    ['a bad webhook secret', { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'nope' }, 'whsec_'],
  ])('%s', (_name, vars, error) => {
    const load = () => loadConfig({ ...required, ...vars });
    if (error) expect(load).toThrow(error as string);
    else expect(load).not.toThrow();
  });

  it('accepts live keys in production and keeps them secret', () => {
    const cfg = loadConfig({
      ...required,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
    });
    expect(cfg.stripe?.secretKey.reveal()).toBe('sk_live_1');
    expect(JSON.stringify(cfg)).not.toContain('sk_live_1');
  });
});
