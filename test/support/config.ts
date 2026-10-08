import { inject } from 'vitest';
import { type AppConfig, loadConfig } from '../../src/config/config.js';

/** Configuration for the given test database and the shared Redis, plus overrides. */
export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject('redisUrl'),
    ...overrides,
  });
}
