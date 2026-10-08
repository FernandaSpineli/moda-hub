import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

/**
 * Creates a database cloned from the migrated template (CREATE DATABASE ...
 * TEMPLATE takes milliseconds), so every test file gets the real schema and
 * no shared state. Call drop() when done.
 */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new URL(inject('databaseUrl'));
  admin.pathname = '/postgres';
  const name = `test_${randomBytes(6).toString('hex')}`;

  await exec(admin.toString(), `CREATE DATABASE ${name} TEMPLATE ${inject('templateDatabase')}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => exec(admin.toString(), `DROP DATABASE ${name} WITH (FORCE)`),
  };
}

async function exec(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
