import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

  it('hashes with argon2id and verifies', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong horse battery')).resolves.toBe(false);
  });

  it('fails for an unknown account (null hash) after doing the same work', async () => {
    await expect(hasher.verify(null, 'anything-at-all')).resolves.toBe(false);
  });
});
