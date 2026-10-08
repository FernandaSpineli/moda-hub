import { createHash } from 'node:crypto';
import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { REDIS } from '../platform/redis.js';
import { AppError } from './app-error.js';

export interface RateLimitRule {
  /** Names the counter, e.g. "login-ip". */
  name: string;
  limit: number;
  windowSeconds: number;
  /** What is counted: the client IP, or the account the request targets. */
  by: 'ip' | 'email';
}

const RULES = Symbol('RATE_LIMIT_RULES');

/**
 * Fixed-window limits kept in Redis, so every API instance shares them.
 * A request over any rule gets 429 with Retry-After.
 */
export const RateLimit = (...rules: RateLimitRule[]) =>
  applyDecorators(SetMetadata(RULES, rules), UseGuards(RateLimitGuard));

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('rate-limit');
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.config.rateLimit) return true;
    const rules = this.reflector.get<RateLimitRule[]>(RULES, ctx.getHandler()) ?? [];
    const req = ctx.switchToHttp().getRequest<Request>();
    const now = Date.now();
    for (const rule of rules) {
      const subject = this.subject(rule, req);
      if (subject === undefined) continue;
      const windowMs = rule.windowSeconds * 1000;
      const window = Math.floor(now / windowMs);
      // Hashed: Redis never holds an email or IP in clear.
      const id = createHash('sha256').update(subject).digest('base64url').slice(0, 22);
      const key = `${this.config.queuePrefix}:ratelimit:${rule.name}:${window}:${id}`;
      let count: number;
      try {
        const results = await this.redis.multi().incr(key).expire(key, rule.windowSeconds, 'NX').exec();
        count = Number(results?.[0]?.[1]);
      } catch (err) {
        // Fail open: an outage of Redis must not lock everyone out of their account.
        this.logger.warn({ err, rule: rule.name }, 'rate_limit.unavailable');
        return true;
      }
      if (count > rule.limit) {
        const retryAfter = Math.ceil(((window + 1) * windowMs - now) / 1000);
        ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfter));
        this.logger.warn({ rule: rule.name, retry_after_s: retryAfter }, 'rate_limit.exceeded');
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests; try again later');
      }
    }
    return true;
  }

  private subject(rule: RateLimitRule, req: Request): string | undefined {
    if (rule.by === 'ip') return req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' && email !== '' ? email.trim().toLowerCase() : undefined;
  }
}
