import { createPrivateKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { Secret } from './secret.js';

/** Parses durations such as "500ms", "30s", "15m" or "720h" into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}" (use e.g. 30s, 15m, 720h)`);
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

const duration = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v, ctx) => {
      try {
        return parseDuration(v);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_TIMEOUT: duration('15s'),
  DATABASE_URL: z.string({ error: 'required' }).startsWith('postgres', 'must be a postgres:// URL'),
  REDIS_URL: z.string({ error: 'required' }).startsWith('redis', 'must be a redis:// URL'),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  JWT_PRIVATE_KEY: z
    .string({ error: 'required (generate one with: node scripts/generate-jwt-key.mjs)' })
    .transform((v, ctx) => {
      try {
        const key = createPrivateKey(Buffer.from(v, 'base64').toString('utf8'));
        if (key.asymmetricKeyType !== 'ed25519')
          throw new Error(`expected an Ed25519 key, got ${key.asymmetricKeyType}`);
        return key;
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: `invalid key: ${(err as Error).message}` });
        return z.NEVER;
      }
    }),
  ACCESS_TOKEN_TTL: duration('15m'),
  REFRESH_TOKEN_TTL: duration('720h'),
  PASSWORD_RESET_TTL: duration('30m'),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  shutdownTimeoutMs: number;
  databaseUrl: Secret;
  redisUrl: Secret;
  /** Public URL of the shop, used in emails and Stripe redirects. */
  baseUrl: string;
  auth: {
    /** Ed25519 key that signs access tokens; its public half is published as a JWKS. */
    signingKey: KeyObject;
    accessTokenTtlMs: number;
    refreshTokenTtlMs: number;
    passwordResetTtlMs: number;
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Builds the configuration from environment variables. Every invalid
 * variable is reported at once, so a misconfigured deploy fails with one
 * complete message.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // Empty strings mean "unset", as with an empty line in .env.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT,
    databaseUrl: new Secret(e.DATABASE_URL),
    redisUrl: new Secret(e.REDIS_URL),
    baseUrl: e.APP_BASE_URL.replace(/\/$/, ''),
    auth: {
      signingKey: e.JWT_PRIVATE_KEY,
      accessTokenTtlMs: e.ACCESS_TOKEN_TTL,
      refreshTokenTtlMs: e.REFRESH_TOKEN_TTL,
      passwordResetTtlMs: e.PASSWORD_RESET_TTL,
    },
  };
}

/** Injection token for AppConfig. */
export const APP_CONFIG = Symbol('APP_CONFIG');
