import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { authErrors } from './auth.errors.js';
import { IS_PUBLIC, REQUIRED_ROLE } from './decorators.js';
import type { Role } from './principal.js';
import { TokenService } from './token.service.js';

/**
 * Global guard: every route requires a valid bearer token unless marked
 * @Public(), so forgetting a decorator closes a route instead of opening it.
 * Routes marked @RequireRole() also check the caller's role.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('auth');
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      this.logger.info({ reason: 'missing_token' }, 'auth.unauthorized');
      throw this.unauthorized(ctx, 'Authentication required');
    }

    try {
      req.user = await this.tokens.verify(token);
    } catch (err) {
      this.logger.info({ reason: 'invalid_token', detail: (err as Error).message }, 'auth.unauthorized');
      throw this.unauthorized(ctx, 'Access token is invalid or expired');
    }
    // Every later log line of this request, including the access log, gets it.
    this.logger.assign({ user_id: req.user.userId });

    const required = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, targets);
    if (required && req.user.role !== required) {
      this.logger.warn({ required_role: required, role: req.user.role }, 'auth.forbidden');
      throw authErrors.forbidden();
    }
    return true;
  }

  private unauthorized(ctx: ExecutionContext, message: string) {
    ctx.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer realm="moda-hub"');
    return authErrors.unauthorized(message);
  }
}
