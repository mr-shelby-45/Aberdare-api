import { Controller, Get, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { SessionService } from './session.service.js';

@Controller('v1/me')
export class MeController {
  constructor(private readonly sessions: SessionService) {}

  /** Membership, business, device and effective permissions, read live this request. */
  @Get()
  async me(@Req() request: AuthedRequest) {
    return this.sessions.me(request.session!);
  }
}
