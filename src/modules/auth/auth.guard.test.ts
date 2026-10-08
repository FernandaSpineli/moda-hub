import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../common/app-error.js';
import { AuthGuard } from './auth.guard.js';
import { IS_PUBLIC, REQUIRED_ROLE } from './decorators.js';
import type { Principal, Role } from './principal.js';
import type { TokenService } from './token.service.js';

function run(opts: { metadata?: Record<string, unknown>; header?: string; principal?: Principal }) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => opts.metadata?.[key as string]);
  const tokens = {
    verify: vi.fn(async () => {
      if (!opts.principal) throw new Error('bad token');
      return opts.principal;
    }),
  } as unknown as TokenService;
  const logger = {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    assign: vi.fn(),
  } as unknown as PinoLogger;
  const req: { headers: Record<string, string>; user?: Principal } = {
    headers: opts.header ? { authorization: opts.header } : {},
  };
  const res = { setHeader: vi.fn() };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { result: new AuthGuard(reflector, tokens, logger).canActivate(ctx), req, logger };
}

const customer: Principal = { userId: 'u1', role: 'customer' };
const admin: Principal = { userId: 'u2', role: 'admin' };
const status = async (p: Promise<boolean>) =>
  p.then(
    () => 200,
    (e: AppError) => e.status,
  );

describe('AuthGuard', () => {
  it('lets public routes through without a token', async () => {
    await expect(run({ metadata: { [IS_PUBLIC]: true } }).result).resolves.toBe(true);
  });

  it.each<[string, Role | undefined, Principal | undefined, string | undefined, number]>([
    ['no token', undefined, undefined, undefined, 401],
    ['invalid token', undefined, undefined, 'Bearer x', 401],
    ['customer on a customer route', undefined, customer, 'Bearer x', 200],
    ['customer on an admin route', 'admin', customer, 'Bearer x', 403],
    ['admin on an admin route', 'admin', admin, 'Bearer x', 200],
  ])('%s', async (_name, role, principal, header, expected) => {
    const { result, req } = run({ metadata: { [REQUIRED_ROLE]: role }, principal, header });
    expect(await status(result)).toBe(expected);
    if (expected === 200) expect(req.user).toEqual(principal);
  });

  it('logs forbidden attempts', async () => {
    const { result, logger } = run({
      metadata: { [REQUIRED_ROLE]: 'admin' },
      principal: customer,
      header: 'Bearer x',
    });
    await expect(result).rejects.toBeInstanceOf(AppError);
    expect(logger.warn).toHaveBeenCalledWith({ required_role: 'admin', role: 'customer' }, 'auth.forbidden');
  });
});
