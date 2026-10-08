import { inject } from 'vitest';
import { type AppConfig, loadConfig } from '../../src/config/config.js';

/** Configuration pointing at the test containers, plus overrides. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    ...overrides,
  });
}
