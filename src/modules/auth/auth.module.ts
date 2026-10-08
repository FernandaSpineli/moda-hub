import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OutboxService } from '../../platform/outbox.js';
import { UsersController } from '../users/users.controller.js';
import { AuthController, JwksController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { PasswordHasher } from './password-hasher.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController, JwksController, UsersController],
  providers: [
    AuthRepository,
    AuthService,
    PasswordHasher,
    TokenService,
    OutboxService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
