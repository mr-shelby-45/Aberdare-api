import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
