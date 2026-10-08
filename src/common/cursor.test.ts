import { describe, expect, it } from 'vitest';
import { AppError } from './app-error.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const id = '01a11699-7a06-7d19-ace9-45b3da7b647b';

describe('cursors', () => {
  it('round-trip', () => {
    const raw = encodeCursor({ sort: 'price_asc', value: 25990, id });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw, 'price_asc')).toEqual({ sort: 'price_asc', value: 25990, id });
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['another sort', encodeCursor({ sort: 'newest', value: '2026-01-01', id })],
    ['a bad id', Buffer.from(JSON.stringify(['price_asc', 1, "' OR 1=1"])).toString('base64url')],
    ['a wrong shape', Buffer.from(JSON.stringify({ sort: 'price_asc' })).toString('base64url')],
  ])('reject %s', (_name, raw) => {
    expect(() => decodeCursor(raw, 'price_asc')).toThrow(AppError);
  });
});
