import { Body, Controller, Get, HttpCode, Inject, Patch, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiZodBody } from '../../common/openapi.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { users } from '../../db/schema/index.js';
import { DB, type Db } from '../../platform/database.js';
import { authErrors } from '../auth/auth.errors.js';
import { changePasswordSchema, nameSchema } from '../auth/auth.schemas.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';

// Email changes need a verified flow of their own and are deliberately not
// accepted here: with a stolen access token, changing the email would be one
// password reset away from an account takeover.
export const updateProfileSchema = z.strictObject({ name: nameSchema.optional() });

const profileColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

@ApiTags('profile')
@ApiBearerAuth()
@Controller('users/me')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async me(@CurrentUser() user: Principal) {
    const [profile] = await this.db.select(profileColumns).from(users).where(eq(users.id, user.userId));
    if (!profile) throw authErrors.userNotFound();
    return profile;
  }

  @Patch()
  @ApiZodBody(updateProfileSchema)
  async update(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: z.infer<typeof updateProfileSchema>,
  ) {
    if (body.name === undefined) return this.me(user);
    const [profile] = await this.db
      .update(users)
      .set({ name: body.name })
      .where(eq(users.id, user.userId))
      .returning(profileColumns);
    if (!profile) throw authErrors.userNotFound();
    return profile;
  }

  @Put('password')
  @ApiZodBody(changePasswordSchema)
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ): Promise<void> {
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
  }
}
