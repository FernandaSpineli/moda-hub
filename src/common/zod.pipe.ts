import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { type FieldProblem, validationError } from './app-error.js';

/**
 * Validates and parses input with a Zod schema. Invalid input becomes a 422
 * listing every problem by field; valid input comes out typed and
 * normalised (trimmed, lower-cased, defaults applied) by the schema.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw validationError(
      result.error.issues.map(
        (issue): FieldProblem => ({
          field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
          message: issue.message,
        }),
      ),
    );
  }
}
