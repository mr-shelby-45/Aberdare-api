import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { AUTH_ROUTE_RATE_LIMIT } from '../../common/http/auth-rate-limit.js';
import { SignupStartDto } from './dto/signup-start.dto.js';
import { SignupVerifyDto } from './dto/signup-verify.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { SignupService } from './signup.service.js';

// Public routes: no access token. Each has its own per-IP limit.
@Controller('v1/auth')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post('signup/start')
  @HttpCode(202)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async start(@Body() dto: SignupStartDto) {
    await this.signup.start(dto);
    return { status: 'CODES_SENT' };
  }

  @Post('signup/verify')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async verify(@Body() dto: SignupVerifyDto) {
    const result = await this.signup.verify(dto);
    return { signup_token: result.signupToken, expires_in: result.expiresInSeconds };
  }

  @Post('signup')
  @HttpCode(201)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async complete(@Body() dto: SignupDto) {
    const r = await this.signup.signup(dto);
    return {
      device_id: r.deviceId,
      device_secret: r.deviceSecret,
      access_token: r.accessToken,
      refresh_token: r.refreshToken,
      membership: {
        id: r.membership.id,
        business_id: r.membership.businessId,
        role_preset: r.membership.rolePreset,
        display_name: r.membership.displayName,
      },
    };
  }
}
