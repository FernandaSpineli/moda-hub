import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

// Keep in sync with docker-compose.yml.
const POSTGRES_IMAGE = 'postgres:18-alpine';
const REDIS_IMAGE = 'redis:8-alpine';

/**
 * Starts one PostgreSQL and one Redis for the whole integration run and
 * hands their URLs to the tests through Vitest's provide/inject.
 */
export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('moda_test')
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
  project.provide('databaseUrl', pg.getConnectionUri());
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}
