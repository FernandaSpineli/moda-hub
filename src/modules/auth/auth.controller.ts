import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
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
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.register(body));
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.login(body));
  }

  @Post('refresh')
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
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.secureCookies);
  }

  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) body: { email: string }) {
    await this.auth.requestPasswordReset(body.email);
    return { message: 'If the email is registered, a reset link is on its way.' };
  }

  @Post('password/reset')
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
@Public()
@Controller('.well-known')
export class JwksController {
  constructor(private readonly tokens: TokenService) {}

  @Get('jwks.json')
  jwks() {
    return this.tokens.jwks();
  }
}
