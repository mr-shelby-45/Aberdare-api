import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AppConfig } from '../../config/app.config.js';

// Hashes short codes (SMS and email codes, temp PINs) with HMAC-SHA256 keyed by
// the server pepper (docs/phase-a-design.md section 7). The channel, target and
// purpose are part of the input, so a code sent for one phone or purpose is
// worthless for another.
@Injectable()
export class CodeHasher {
  constructor(private readonly config: AppConfig) {}

  hash(parts: { channel: string; target: string; purpose: string; code: string }): string {
    return createHmac('sha256', this.config.authPepper)
      .update([parts.channel, parts.target, parts.purpose, parts.code].join('|'), 'utf8')
      .digest('hex');
  }
}
