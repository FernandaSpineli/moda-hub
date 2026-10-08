import { inspect } from 'node:util';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { Secret } from './secret.js';

describe('Secret', () => {
  const secret = new Secret('postgres://app:hunter2@db/app');

  it('never leaks through formatting, JSON or logging', () => {
    const lines: string[] = [];
    const logger = pino({}, { write: (l: string) => lines.push(l) });
    logger.info({ dsn: secret, nested: { secret } }, 'config');

    for (const output of [
      String(secret),
      `${secret}`,
      JSON.stringify({ secret }),
      inspect({ secret }),
      lines.join(''),
    ]) {
      expect(output).not.toContain('hunter2');
    }
  });

  it('reveals the value on request', () => {
    expect(secret.reveal()).toBe('postgres://app:hunter2@db/app');
  });
});
