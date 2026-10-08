import 'reflect-metadata';
import pg from 'pg';
import pino from 'pino';
import { baseLoggerOptions } from './common/logging.js';
import { ConfigError, loadConfig } from './config/config.js';
import { runMigrations } from './db/migrate.js';

const usage = 'usage: node dist/cli.js migrate';

/** Operational commands, run as one-off containers (see docker-compose.yml). */
async function main(args: string[]): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino(baseLoggerOptions(config));
  const pool = new pg.Pool({ connectionString: config.databaseUrl.reveal(), max: 1 });
  try {
    switch (args[0]) {
      case 'migrate': {
        const started = Date.now();
        await runMigrations(pool);
        logger.info({ duration_ms: Date.now() - started }, 'db.migrations.applied');
        break;
      }
      default:
        throw new ConfigError(usage);
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(
    `moda-hub: ${err instanceof ConfigError ? err.message : String((err as Error)?.stack ?? err)}\n`,
  );
  process.exit(1);
});
