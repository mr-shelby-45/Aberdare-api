import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { Public } from '../../common/auth/public.decorator.js';
import { sha256 } from '../../common/auth/secrets.js';
import { AUTH_ROUTE_RATE_LIMIT } from '../../common/http/auth-rate-limit.js';
import { IdentityLookup } from '../../database/identity-lookup.js';
import { ActivateDto } from './dto/activate.dto.js';
import { FirstLoginDto } from './dto/first-login.dto.js';
import { FirstLoginService } from './first-login.service.js';

// Public routes for staff: first login, activation, and the shared-tablet
// "Who is selling?" list. Each has its own per-IP limit.
@Public()
@Controller('v1/auth')
export class FirstLoginController {
  constructor(
    private readonly firstLogins: FirstLoginService,
    private readonly identity: IdentityLookup,
  ) {}

  @Post('first-login')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async firstLogin(@Body() dto: FirstLoginDto) {
    const r = await this.firstLogins.firstLogin(dto);
    return { setup_token: r.setupToken, expires_in: r.expiresInSeconds };
  }

  @Post('staff/activate')
  @HttpCode(200)
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async activate(@Body() dto: ActivateDto) {
    const s = await this.firstLogins.activate(dto);
    return {
      device_id: s.deviceId,
      device_secret: s.deviceSecret,
      access_token: s.accessToken,
      refresh_token: s.refreshToken,
      membership: { id: s.membership.id, business_id: s.membership.businessId, role_preset: s.membership.rolePreset, display_name: s.membership.displayName },
    };
  }

  /**
   * Display names and membership ids for one shared device. Any bad
   * credential gets the same 200 with an empty list, so it cannot be probed.
   */
  @Get('device-members')
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async deviceMembers(@Headers('x-device-id') deviceId?: string, @Headers('x-device-secret') secret?: string) {
    if (typeof deviceId !== 'string' || typeof secret !== 'string' || secret.length > 128) return { members: [] };
    const members = await this.identity.listDeviceMembers(deviceId, sha256(secret));
    return { members: members.map((m) => ({ membership_id: m.membershipId, display_name: m.displayName })) };
  }
}
