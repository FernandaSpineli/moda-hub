import { describe, expect, it } from 'vitest';
import { isCheckViolation, isUniqueViolation } from './db-errors.js';

describe('db error helpers', () => {
  const pgErr = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'users_email_unique' });

  it('recognise a driver error and one wrapped by Drizzle', () => {
    expect(isUniqueViolation(pgErr)).toBe(true);
    expect(isUniqueViolation(new Error('query failed', { cause: pgErr }), 'users_email_unique')).toBe(true);
  });

  it('match the constraint when given', () => {
    expect(isUniqueViolation(pgErr, 'products_slug_unique')).toBe(false);
    expect(isCheckViolation(pgErr)).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
