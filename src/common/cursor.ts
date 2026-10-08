import { AppError } from './app-error.js';

/**
 * Keyset pagination cursors. A cursor is the sort key of the last row of a
 * page plus its ID (the tie-breaker), encoded as opaque base64url JSON and
 * bound to the sort it was produced for. Unlike OFFSET, pages stay correct
 * when rows are inserted meanwhile, and deep pages cost the same as the first.
 */
export interface Cursor<S extends string = string> {
  sort: S;
  value: string | number;
  id: string;
}

export function encodeCursor<S extends string>(cursor: Cursor<S>): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.value, cursor.id])).toString('base64url');
}

export function decodeCursor<S extends string>(raw: string, expectedSort: S): Cursor<S> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 3) {
      const [sort, value, id] = parsed;
      if (
        sort === expectedSort &&
        (typeof value === 'string' || typeof value === 'number') &&
        typeof id === 'string' &&
        /^[0-9a-f-]{36}$/.test(id)
      ) {
        return { sort: expectedSort, value, id };
      }
    }
  } catch {
    // fall through
  }
  throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid or belongs to a different sort order');
}

export interface Page<T> {
  data: T[];
  /** Pass as ?cursor= to get the next page; null on the last page. */
  nextCursor: string | null;
}
