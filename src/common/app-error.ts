/**
 * An error whose code and message are safe to show to API clients. Services
 * throw it for expected failures; anything else becomes a generic 500.
 */
export class AppError extends Error {
  override name = 'AppError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface FieldProblem {
  field: string;
  message: string;
}

/** A 422 listing every invalid field. */
export function validationError(problems: FieldProblem[]): AppError {
  return new AppError(422, 'VALIDATION_FAILED', 'One or more fields are invalid', problems);
}

export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
