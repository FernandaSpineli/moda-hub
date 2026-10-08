import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import pino, { type DestinationStream } from 'pino';
import { baseLoggerOptions } from './common/logging.js';
import { ConfigError, loadConfig } from './config/config.js';
import { runMigrations } from './db/migrate.js';
import * as schema from './db/schema/index.js';
import { AuthRepository } from './modules/auth/auth.repository.js';

const usage = 'usage: node dist/cli.js migrate | user promote <email>';

/**
 * Operational commands, run as one-off containers (see docker-compose.yml).
 * Exported so the tests run the same code against their database.
 */
export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  logStream?: DestinationStream,
): Promise<void> {
  const config = loadConfig(env);
  const logger = logStream ? pino(baseLoggerOptions(config), logStream) : pino(baseLoggerOptions(config));
  const pool = new pg.Pool({ connectionString: config.databaseUrl.reveal(), max: 1 });
  try {
    switch (args[0]) {
      case 'migrate': {
        const started = Date.now();
        await runMigrations(pool);
        logger.info({ duration_ms: Date.now() - started }, 'db.migrations.applied');
        break;
      }
      case 'user': {
        const email = args[2]?.trim().toLowerCase();
        if (args[1] !== 'promote' || !email) throw new ConfigError(usage);
        // Admins are only ever created here, never over HTTP.
        const repo = new AuthRepository(drizzle(pool, { schema, casing: 'snake_case' }));
        if (!(await repo.setRole(email, 'admin'))) throw new ConfigError(`no account with email ${email}`);
        logger.info({ role: 'admin' }, 'auth.user.promoted');
        break;
      }
      default:
        throw new ConfigError(usage);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2), process.env).catch((err: unknown) => {
    process.stderr.write(
      `moda-hub: ${err instanceof ConfigError ? err.message : String((err as Error)?.stack ?? err)}\n`,
    );
    process.exit(1);
  });
}
