import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseDuration } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      env: 'development',
      port: 3000,
      logLevel: 'info',
      shutdownTimeoutMs: 15_000,
    });
  });

  it('reads overrides and treats empty strings as unset', () => {
    const cfg = loadConfig({
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
  });

  it('reports every invalid variable at once', () => {
    const load = () => loadConfig({ NODE_ENV: 'staging', PORT: 'http', SHUTDOWN_TIMEOUT: 'soon' });
    expect(load).toThrow(ConfigError);
    try {
      load();
    } catch (err) {
      for (const key of ['NODE_ENV', 'PORT', 'SHUTDOWN_TIMEOUT'])
        expect((err as Error).message).toContain(key);
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
