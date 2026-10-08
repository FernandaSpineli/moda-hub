import { generateKeyPairSync } from 'node:crypto';
import { inject } from 'vitest';
import { type AppConfig, loadConfig } from '../../src/config/config.js';

// One signing key per test process.
const signingKey = Buffer.from(
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
).toString('base64');

export const TEST_WEBHOOK_SECRET = 'whsec_test_secret';

/** Configuration for the given test database and the shared Redis, plus overrides. */
export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject('redisUrl'),
    JWT_PRIVATE_KEY: signingKey,
    APP_BASE_URL: 'http://shop.test',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ...overrides,
  });
}
