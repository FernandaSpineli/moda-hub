import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { ConfigError } from '../src/config/config.js';
import { testConfig } from './support/config.js';
import { createTestDatabase } from './support/database.js';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: pg.Pool;
let env: NodeJS.ProcessEnv;
const logs: Record<string, unknown>[] = [];
const stream = new Writable({
  write(chunk, _e, done) {
    logs.push(JSON.parse(String(chunk)));
    done();
  },
});

beforeAll(async () => {
  db = await createTestDatabase();
  sql = new pg.Pool({ connectionString: db.url });
  const cfg = testConfig(db.url);
  env = {
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    REDIS_URL: cfg.redisUrl.reveal(),
    JWT_PRIVATE_KEY: Buffer.from(
      cfg.auth.signingKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    ).toString('base64'),
  };
});
afterAll(async () => {
  await sql.end();
  await db.drop();
});

describe('cli', () => {
  it('applies migrations idempotently', async () => {
    await runCli(['migrate'], env, stream); // the template is already migrated: nothing to do
    expect(logs.at(-1)).toMatchObject({ event: 'db.migrations.applied' });
    const { rows } = await sql.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect(rows[0].n).toBe(3);
  });

  it('promotes an existing account to admin, case-insensitively', async () => {
    await sql.query(`INSERT INTO users (email, password_hash, name) VALUES ('ana@example.com', 'x', 'Ana')`);
    await runCli(['user', 'promote', '  ANA@example.com '], env, stream);
    const { rows } = await sql.query(`SELECT role FROM users WHERE email = 'ana@example.com'`);
    expect(rows[0].role).toBe('admin');
    expect(JSON.stringify(logs)).not.toContain('ana@example.com');
  });

  it.each([
    [['user', 'promote', 'nobody@example.com'], 'no account'],
    [['user', 'demote', 'ana@example.com'], 'usage'],
    [['user', 'promote'], 'usage'],
    [['drop-database'], 'usage'],
  ])('refuses %j', async (args, message) => {
    await expect(runCli(args, env, stream)).rejects.toThrow(ConfigError);
    await expect(runCli(args, env, stream)).rejects.toThrow(message);
  });
});
