/** PostgreSQL error codes the services translate into API errors. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const CHECK_VIOLATION = '23514';

interface PgError {
  code?: string;
  constraint?: string;
}

/** Drizzle wraps driver errors; look at the error and its cause. */
function pgError(err: unknown): PgError | undefined {
  for (
    let e = err as { cause?: unknown } & PgError, depth = 0;
    e && depth < 3;
    e = e.cause as typeof e, depth++
  ) {
    if (typeof e.code === 'string') return e;
  }
  return undefined;
}

function is(code: string) {
  return (err: unknown, constraint?: string): boolean => {
    const e = pgError(err);
    return e?.code === code && (constraint === undefined || e.constraint === constraint);
  };
}

export const isUniqueViolation = is(UNIQUE_VIOLATION);
export const isForeignKeyViolation = is(FOREIGN_KEY_VIOLATION);
export const isRestrictViolation = is(RESTRICT_VIOLATION);
export const isCheckViolation = is(CHECK_VIOLATION);
