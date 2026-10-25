import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { Public } from '../../common/auth/public.decorator.js';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { AUTH_ROUTE_RATE_LIMIT } from '../../common/http/auth-rate-limit.js';
import { LoginDto } from './dto/login.dto.js';
import { PinLoginDto } from './dto/pin-login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { LoginService } from './login.service.js';
import { PinLoginService } from './pin-login.service.js';
import { SessionService } from './session.service.js';

@Controller('v1/auth')
export class LoginController {
  constructor(
    private readonly logins: LoginService,
    private readonly pins: PinLoginService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async login(@Body() dto: LoginDto) {
    const r = await this.logins.login(dto);
    if (r.kind === 'selection') {
      return {
        requires_selection: true,
        selection_token: r.selectionToken,
        memberships: r.memberships.map((m) => ({ id: m.id, business_name: m.businessName, role_preset: m.rolePreset })),
      };
    }
    const s = r.session;
    return {
      device_id: s.deviceId,
      device_secret: s.deviceSecret,
      access_token: s.accessToken,
      refresh_token: s.refreshToken,
      membership: { id: s.membership.id, business_id: s.membership.businessId, role_preset: s.membership.rolePreset, display_name: s.membership.displayName },
    };
  }

  @Public()
  @Post('pin')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async pin(@Body() dto: PinLoginDto) {
    const s = await this.pins.login(dto);
    return {
      access_token: s.accessToken,
      refresh_token: s.refreshToken,
      membership: { id: s.membership.id, business_id: s.membership.businessId, role_preset: s.membership.rolePreset, display_name: s.membership.displayName },
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async refresh(@Body() dto: RefreshDto) {
    const t = await this.sessions.refresh(dto.refresh_token);
    return { access_token: t.accessToken, refresh_token: t.refreshToken };
  }

  // Protected: needs a valid access token; runs in the request's tenant transaction.
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: AuthedRequest) {
    await this.sessions.logout(request.auth!);
  }
}
