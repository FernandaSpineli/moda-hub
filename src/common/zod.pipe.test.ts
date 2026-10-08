import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './app-error.js';
import { ZodValidationPipe } from './zod.pipe.js';

const schema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  quantity: z.number().int().min(1),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns parsed, normalised data', () => {
    expect(pipe.transform({ email: '  Ana@Example.COM ', quantity: 2 })).toEqual({
      email: 'ana@example.com',
      quantity: 2,
    });
  });

  it('reports every invalid field as a 422', () => {
    try {
      pipe.transform({ email: 'nope', quantity: 0, admin: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.status).toBe(422);
      expect(e.code).toBe('VALIDATION_FAILED');
      const fields = (e.details as { field: string }[]).map((d) => d.field);
      expect(fields).toEqual(['email', 'quantity', 'admin']);
      expect((e.details as { message: string }[])[2]?.message).toBe('is not allowed');
    }
  });

  it('treats a missing body as an empty object', () => {
    expect(() => pipe.transform(undefined)).toThrow(AppError);
  });
});
