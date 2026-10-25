import {
  Body,
  Controller,
  Get,
  Post,
  type RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../src/common/auth/public.decorator.js';
import { IpAllowlistGuard } from '../../src/common/security/ip-allowlist.guard.js';
import { SpikeCarelessDto } from './spike-careless.dto.js';
import { SpikeItemDto } from './spike-item.dto.js';
import { SpikeLoginDto } from './spike-login.dto.js';

// Fake ranges from RFC 5737 (documentation addresses), never real Safaricom ones.
export const TEST_ALLOWLIST = ['192.0.2.0/24'];

// Spike step 5 only. Lives under test/ so none of it ships.
@Public()
@Controller('spike')
export class SpikeController {
  @Get('ip')
  ip(@Req() request: FastifyRequest) {
    return { ip: request.ip };
  }

  @Post('raw')
  raw(@Req() request: RawBodyRequest<FastifyRequest>) {
    const bytes = request.rawBody ?? Buffer.alloc(0);
    return {
      length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  @Post('validate')
  validate(@Body() item: SpikeItemDto) {
    return { ok: true, name: item.name };
  }

  @Get('boom')
  boom(): never {
    // Like a driver error that quotes the data it was writing.
    throw new Error('insert failed for pin 4321 at /internal/secret/path');
  }

  @Post('login')
  login(@Req() request: FastifyRequest, @Body() body: SpikeLoginDto) {
    // A deliberate mistake: logging the whole body. Redaction must catch it.
    request.log.info({ body }, 'login attempt');
    return { ok: true };
  }

  @Post('careless')
  careless(@Req() request: FastifyRequest, @Body() body: SpikeCarelessDto): never {
    // Phase A5 test 3: two deliberate mistakes. Log every credential (nested
    // too), then fail with them in the error message. Neither may reach a log.
    request.log.info({ body, nested: { body } }, 'careless handler');
    throw new Error(`failed with ${JSON.stringify(body)}`);
  }

  @Get('allowlist/log')
  @UseGuards(new IpAllowlistGuard({ allowlist: TEST_ALLOWLIST, mode: 'log' }))
  allowlistLog() {
    return { passed: true };
  }

  @Get('allowlist/enforce')
  @UseGuards(new IpAllowlistGuard({ allowlist: TEST_ALLOWLIST, mode: 'enforce' }))
  allowlistEnforce() {
    return { passed: true };
  }
}
