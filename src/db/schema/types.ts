import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Case-insensitive text (emails). */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/** Full-text search document. */
export const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** UUIDv7 primary key: not enumerable, yet time-ordered for index locality. */
export const id = () => uuid().primaryKey().default(sql`uuidv7()`);

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
