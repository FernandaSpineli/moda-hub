import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext, createdAt, id, updatedAt } from './types.js';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const users = pgTable(
  'users',
  {
    id: id(),
    email: citext().notNull().unique(),
    passwordHash: text().notNull(),
    name: text().notNull(),
    role: text({ enum: ['customer', 'admin'] })
      .notNull()
      .default('customer'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('users_role_check', sql`${t.role} IN ('customer', 'admin')`),
    check('users_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
  ],
);

// Tokens are stored as SHA-256 hashes: a database leak yields nothing usable.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_id_idx').on(t.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('password_reset_tokens_user_id_idx').on(t.userId)],
);
