import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseDuration } from './config.js';

const required = { DATABASE_URL: 'postgres://localhost/moda', REDIS_URL: 'redis://localhost:6379' };

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
      for (const key of ['NODE_ENV', 'PORT', 'SHUTDOWN_TIMEOUT', 'DATABASE_URL', 'REDIS_URL']) {
        expect((err as Error).message).toContain(key);
      }
    }
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
