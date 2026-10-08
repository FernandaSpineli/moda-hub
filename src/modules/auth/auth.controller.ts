import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiZodBody } from '../../common/openapi.js';
import { RateLimit } from '../../common/rate-limit.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import {
  forgotPasswordSchema,
  type LoginInput,
  loginSchema,
  type RegisterInput,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas.js';
import { AuthService, type Session } from './auth.service.js';
import { Public } from './decorators.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie.js';
import { TokenService } from './token.service.js';

@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.secureCookies = config.baseUrl.startsWith('https://');
  }

  @Post('register')
  @ApiZodBody(registerSchema)
  @RateLimit({ name: 'register-ip', limit: 10, windowSeconds: 3600, by: 'ip' })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.register(body));
  }

  @Post('login')
  @ApiZodBody(loginSchema)
  // Per IP against one client trying many accounts; per email against many
  // clients guessing one account's password.
  @RateLimit(
    { name: 'login-ip', limit: 20, windowSeconds: 300, by: 'ip' },
    { name: 'login-email', limit: 10, windowSeconds: 900, by: 'email' },
  )
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.login(body));
  }

  @Post('refresh')
  @ApiCookieAuth('refresh_token')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const { refreshToken, ...tokens } = await this.auth.refresh(readRefreshCookie(req));
      setRefreshCookie(res, refreshToken, this.config.auth.refreshTokenTtlMs, this.secureCookies);
      return { ...tokens, tokenType: 'Bearer' };
    } catch (err) {
      clearRefreshCookie(res, this.secureCookies);
      throw err;
    }
  }

  @Post('logout')
  @ApiCookieAuth('refresh_token')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.secureCookies);
  }

  @Post('password/forgot')
  @ApiZodBody(forgotPasswordSchema)
  // Each request sends an email: cap it per IP and per inbox.
  @RateLimit(
    { name: 'forgot-ip', limit: 10, windowSeconds: 3600, by: 'ip' },
    { name: 'forgot-email', limit: 3, windowSeconds: 3600, by: 'email' },
  )
  @HttpCode(202)
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) body: { email: string }) {
    await this.auth.requestPasswordReset(body.email);
    return { message: 'If the email is registered, a reset link is on its way.' };
  }

  @Post('password/reset')
  @ApiZodBody(resetPasswordSchema)
  @RateLimit({ name: 'reset-ip', limit: 20, windowSeconds: 900, by: 'ip' })
  @HttpCode(204)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: { token: string; newPassword: string },
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.newPassword);
  }

  private respond(res: Response, { refreshToken, ...session }: Session) {
    setRefreshCookie(res, refreshToken, this.config.auth.refreshTokenTtlMs, this.secureCookies);
    return { ...session, tokenType: 'Bearer' };
  }
}

/** Publishes the token-signing public key, so other services can verify tokens. */
@ApiTags('auth')
@Public()
@Controller('.well-known')
export class JwksController {
  constructor(private readonly tokens: TokenService) {}

  @Get('jwks.json')
  jwks() {
    return this.tokens.jwks();
  }
}
