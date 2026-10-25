import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { Public } from '../../common/auth/public.decorator.js';
import { AUTH_ROUTE_RATE_LIMIT } from '../../common/http/auth-rate-limit.js';
import { PasswordForgotDto } from './dto/password-forgot.dto.js';
import { PasswordResetDto } from './dto/password-reset.dto.js';
import { PasswordResetService } from './password-reset.service.js';

// Public routes for owners who forgot their password. Each has its own per-IP limit.
@Public()
@Controller('v1/auth/password')
export class PasswordController {
  constructor(private readonly resets: PasswordResetService) {}

  @Post('forgot')
  @HttpCode(202)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async forgot(@Body() dto: PasswordForgotDto) {
    await this.resets.forgot(dto);
    return { status: 'CODE_SENT_IF_ACCOUNT_EXISTS' };
  }

  @Post('reset')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async reset(@Body() dto: PasswordResetDto) {
    await this.resets.reset(dto);
    return { status: 'PASSWORD_RESET' };
  }
}
