import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PinoLogger } from 'nestjs-pino';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import * as schema from '../db/schema/index.js';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;

/**
 * Opens the PostgreSQL pool and verifies the database is reachable before
 * the application starts: a misconfigured deploy fails at boot, not on the
 * first request.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG, PinoLogger],
      useFactory: async (config: AppConfig, logger: PinoLogger) => {
        const pool = new pg.Pool({
          connectionString: config.databaseUrl.reveal(),
          max: 10,
          connectionTimeoutMillis: 5_000,
        });
        // Without a listener, an idle client dropped by the server would
        // crash the process.
        pool.on('error', (err) => logger.warn({ err }, 'db.pool.error'));
        await pool.query('SELECT 1');
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      // snake_case columns in SQL, camelCase in TypeScript.
      useFactory: (pool: pg.Pool): Db => drizzle(pool, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
