import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/db/migrate.js';

// Keep in sync with docker-compose.yml.
const POSTGRES_IMAGE = 'postgres:18-alpine';
const REDIS_IMAGE = 'redis:8-alpine';

const TEMPLATE_DATABASE = 'moda_template';

/**
 * Starts one PostgreSQL and one Redis for the whole integration run,
 * migrates a template database once, and hands the URLs to the tests
 * through Vitest's provide/inject (see test/support/database.ts).
 */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(TEMPLATE_DATABASE)
      // Durability is irrelevant for throwaway test data; trade it for speed.
      .withCommand([
        'postgres',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
      ])
      .start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const pool = new pg.Pool({ connectionString: postgres.getConnectionUri() });
  await runMigrations(pool);
  // A template must have no open connections before it can be cloned.
  await pool.end();

  project.provide('databaseUrl', postgres.getConnectionUri());
  project.provide('templateDatabase', TEMPLATE_DATABASE);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    templateDatabase: string;
    redisUrl: string;
  }
}
