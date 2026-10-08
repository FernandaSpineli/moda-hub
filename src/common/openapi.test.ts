import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openApiSchema } from './openapi.js';

describe('openApiSchema', () => {
  it('describes the input a schema accepts, without the JSON Schema dialect marker', () => {
    const json = openApiSchema(
      z.strictObject({
        email: z.string().trim().pipe(z.email()),
        limit: z.coerce.number().int().min(1).max(60).default(24),
        sort: z.enum(['newest', 'name']).optional(),
      }),
    );
    expect(json).not.toHaveProperty('$schema');
    expect(json.required).toEqual(['email']);
    expect(json.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 60, default: 24 });
    expect(json.properties?.sort).toMatchObject({ enum: ['newest', 'name'] });
    expect(json.additionalProperties).toBe(false);
  });
});
