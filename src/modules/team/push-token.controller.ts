import { Body, Controller, HttpCode, Put, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { DevicesService } from '../devices/devices.service.js';
import { SetPushTokenDto } from './dto/set-push-token.dto.js';

// The phone sets its own push token (Phase F3). Any active member, for the
// device in their access token only; never another device. The token is never
// returned by any route and never logged.
@Controller('v1/devices/me')
export class PushTokenController {
  constructor(private readonly devices: DevicesService) {}

  @Put('push-token')
  @HttpCode(204)
  async set(@Req() request: AuthedRequest, @Body() body: SetPushTokenDto): Promise<void> {
    await this.devices.setPushToken(request.session!.device.id, body.push_token);
  }
}
