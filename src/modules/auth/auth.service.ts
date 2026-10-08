import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { validationError } from '../../common/app-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { DbOrTx } from '../../platform/database.js';
import { OutboxService } from '../../platform/outbox.js';
import { authErrors } from './auth.errors.js';
import { AuthRepository, EmailTakenError, type UserRecord } from './auth.repository.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { PasswordHasher } from './password-hasher.js';
import type { Principal } from './principal.js';
import { hashToken, opaqueToken, TokenService } from './token.service.js';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
}

export interface Session {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  /** Goes to an HttpOnly cookie, never into a response body. */
  refreshToken: string;
}

export const toPublicUser = ({ id, email, name, role, createdAt }: UserRecord): PublicUser => ({
  id,
  email,
  name,
  role,
  createdAt,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    logger.setContext('auth');
  }

  async register(input: RegisterInput): Promise<Session> {
    const passwordHash = await this.hasher.hash(input.password);
    try {
      const session = await this.repo.db.transaction(async (tx) => {
        const user = await this.repo.createUser(tx, { email: input.email, name: input.name, passwordHash });
        return this.startSession(tx, user);
      });
      this.logger.info({ user_id: session.user.id }, 'auth.user.registered');
      return session;
    } catch (err) {
      if (err instanceof EmailTakenError) throw authErrors.emailTaken();
      throw err;
    }
  }

  /** Unknown emails and wrong passwords fail the same way, in the same time. */
  async login(input: LoginInput): Promise<Session> {
    const user = await this.repo.userByEmail(input.email);
    if (!(await this.hasher.verify(user?.passwordHash ?? null, input.password)) || !user) {
      // The email is not logged: it is personal data and may be someone else's.
      this.logger.info(
        { reason: user ? 'wrong_password' : 'unknown_email', user_id: user?.id },
        'auth.login.failed',
      );
      throw authErrors.invalidCredentials();
    }
    const session = await this.startSession(this.repo.db, user);
    this.logger.info({ user_id: user.id }, 'auth.login.succeeded');
    return session;
  }

  /**
   * Rotates a refresh token. Presenting one that was already rotated means
   * it was copied, so every session of that user is revoked.
   */
  async refresh(refreshToken: string | undefined): Promise<Omit<Session, 'user'>> {
    if (!refreshToken) throw authErrors.invalidRefreshToken();
    let reuseBy: string | undefined;
    const result = await this.repo.db.transaction(async (tx) => {
      const token = await this.repo.lockRefreshToken(tx, hashToken(refreshToken));
      if (!token) return undefined;
      if (token.revokedAt) {
        reuseBy = token.userId;
        // Committed despite the error below: the revocation must stick.
        await this.repo.revokeAllRefreshTokens(tx, token.userId);
        return undefined;
      }
      if (token.expiresAt.getTime() <= Date.now()) return undefined;
      await this.repo.revokeRefreshToken(tx, { id: token.id });
      const user = await this.repo.userById(tx, token.userId);
      return user && this.startSession(tx, user);
    });
    if (reuseBy) this.logger.warn({ user_id: reuseBy }, 'auth.refresh_token.reuse_detected');
    if (!result) throw authErrors.invalidRefreshToken();
    const { user: _user, ...tokens } = result;
    return tokens;
  }

  /** Unknown or missing tokens are ignored: logout reveals nothing. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken)
      await this.repo.revokeRefreshToken(this.repo.db, { tokenHash: hashToken(refreshToken) });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    await this.repo.db.transaction(async (tx) => {
      const user = await this.repo.userById(tx, userId);
      if (!user) throw authErrors.userNotFound();
      if (!(await this.hasher.verify(user.passwordHash, current))) {
        // 422 rather than 401: the caller is signed in, and a 401 makes most
        // clients drop the session.
        throw validationError([{ field: 'currentPassword', message: 'is incorrect' }]);
      }
      await this.setPasswordAndSignOut(tx, userId, next);
    });
    this.logger.info({ user_id: userId }, 'auth.password.changed');
  }

  /**
   * Records that a reset was requested. The email (and the token in it) is
   * produced by the notifications worker from the outbox event, so the
   * plain token is never stored anywhere. Unknown emails are accepted
   * silently, so this cannot be used to discover accounts.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.repo.userByEmail(email);
    if (!user) {
      this.logger.info({ account_exists: false }, 'auth.password_reset.requested');
      return;
    }
    await this.repo.db.transaction((tx) =>
      this.outbox.record(tx, 'auth.password_reset_requested', user.id, { userId: user.id }),
    );
    this.logger.info({ account_exists: true, user_id: user.id }, 'auth.password_reset.requested');
  }

  /** Creates a single-use reset token for the email; called by the worker. */
  async issuePasswordResetToken(userId: string): Promise<{ token: string; user: UserRecord } | undefined> {
    const user = await this.repo.userById(this.repo.db, userId);
    if (!user) return undefined;
    const { token, hash } = opaqueToken();
    await this.repo.replaceResetToken(
      this.repo.db,
      userId,
      hash,
      new Date(Date.now() + this.config.auth.passwordResetTtlMs),
    );
    return { token, user };
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const userId = await this.repo.db.transaction(async (tx) => {
      const id = await this.repo.consumeResetToken(tx, hashToken(token), new Date());
      if (!id) throw authErrors.invalidResetToken();
      await this.setPasswordAndSignOut(tx, id, password);
      return id;
    });
    this.logger.info({ user_id: userId }, 'auth.password_reset.completed');
  }

  /** Grants admin; exposed through the CLI only, never over HTTP. */
  promoteToAdmin(email: string): Promise<boolean> {
    return this.repo.setRole(email, 'admin');
  }

  private async setPasswordAndSignOut(tx: DbOrTx, userId: string, password: string): Promise<void> {
    await this.repo.setPassword(tx, userId, await this.hasher.hash(password));
    await this.repo.revokeAllRefreshTokens(tx, userId);
  }

  private async startSession(tx: DbOrTx, user: UserRecord): Promise<Session> {
    const principal: Principal = { userId: user.id, role: user.role };
    const { token, hash } = opaqueToken();
    await this.repo.insertRefreshToken(
      tx,
      user.id,
      hash,
      new Date(Date.now() + this.config.auth.refreshTokenTtlMs),
    );
    return {
      user: toPublicUser(user),
      accessToken: await this.tokens.issue(principal),
      expiresIn: this.tokens.ttlSeconds,
      refreshToken: token,
    };
  }
}
