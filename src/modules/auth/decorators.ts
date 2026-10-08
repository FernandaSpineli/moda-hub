import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal, Role } from './principal.js';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLE = 'auth:role';

/** Opts a route out of authentication; everything else requires it. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts a route to one role (e.g. admin). */
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

/** The authenticated caller. Only valid on routes that are not @Public(). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const user = ctx.switchToHttp().getRequest<Request>().user;
  if (!user) throw new Error('CurrentUser used on a public route');
  return user;
});
