import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { passwordResetTokens, refreshTokens, users } from '../../db/schema/index.js';
import { DB, type Db, type DbOrTx } from '../../platform/database.js';
import { isUniqueViolation } from '../../platform/db-errors.js';
import type { Role } from './principal.js';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export class EmailTakenError extends Error {}

/** Credentials and tokens. Every method runs on the pool or a transaction. */
@Injectable()
export class AuthRepository {
  constructor(@Inject(DB) readonly db: Db) {}

  async createUser(
    tx: DbOrTx,
    values: { email: string; name: string; passwordHash: string },
  ): Promise<UserRecord> {
    try {
      const [user] = await tx.insert(users).values(values).returning();
      return user as UserRecord;
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_unique')) throw new EmailTakenError();
      throw err;
    }
  }

  async userByEmail(email: string): Promise<UserRecord | undefined> {
    return (await this.db.query.users.findFirst({ where: eq(users.email, email) })) as UserRecord | undefined;
  }

  async userById(tx: DbOrTx, id: string): Promise<UserRecord | undefined> {
    const [user] = await tx.select().from(users).where(eq(users.id, id));
    return user as UserRecord | undefined;
  }

  async setPassword(tx: DbOrTx, userId: string, passwordHash: string): Promise<void> {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  async setRole(email: string, role: Role): Promise<boolean> {
    const updated = await this.db
      .update(users)
      .set({ role })
      .where(eq(users.email, email))
      .returning({ id: users.id });
    return updated.length > 0;
  }

  async insertRefreshToken(tx: DbOrTx, userId: string, tokenHash: Buffer, expiresAt: Date): Promise<void> {
    await tx.insert(refreshTokens).values({ userId, tokenHash, expiresAt });
  }

  /** Loads a refresh token and locks it, so two refreshes cannot both use it. */
  async lockRefreshToken(tx: DbOrTx, tokenHash: Buffer) {
    const [row] = await tx
      .select({
        id: refreshTokens.id,
        userId: refreshTokens.userId,
        expiresAt: refreshTokens.expiresAt,
        revokedAt: refreshTokens.revokedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for('update');
    return row;
  }

  async revokeRefreshToken(tx: DbOrTx, where: { id: string } | { tokenHash: Buffer }): Promise<void> {
    const match =
      'id' in where ? eq(refreshTokens.id, where.id) : eq(refreshTokens.tokenHash, where.tokenHash);
    await tx
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(match, isNull(refreshTokens.revokedAt)));
  }

  /** Signs the user out of every session. */
  async revokeAllRefreshTokens(tx: DbOrTx, userId: string): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  /** Stores a new reset token and invalidates older ones: only the latest link works. */
  async replaceResetToken(tx: DbOrTx, userId: string, tokenHash: Buffer, expiresAt: Date): Promise<void> {
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: sql`now()` })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({ userId, tokenHash, expiresAt });
  }

  /** Marks a valid reset token used, atomically, and returns its user. */
  async consumeResetToken(tx: DbOrTx, tokenHash: Buffer, now: Date): Promise<string | undefined> {
    const [row] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    return row?.userId;
  }
}
