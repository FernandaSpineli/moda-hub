import { z } from 'zod';

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
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  shutdownTimeoutMs: number;
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
  };
}

/** Injection token for AppConfig. */
export const APP_CONFIG = Symbol('APP_CONFIG');
