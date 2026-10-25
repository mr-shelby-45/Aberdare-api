import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RequestAuth } from '../../common/auth/request-auth.js';
import { randomSecret, sha256 } from '../../common/auth/secrets.js';
import { Clock } from '../../common/time/clock.js';
import { AccessTokenService } from './access-token.service.js';
import { RefreshTokensService } from '../sessions/refresh-tokens.service.js';

const REFRESH_TOKEN_DAYS = 30;

export type SessionIds = RequestAuth;

// Issues session tokens (docs/phase-a-design.md section 7): an access token
// and a refresh token (32 random bytes, stored as SHA-256, 30 days). Must run
// inside the tenant transaction of the session's business.
@Injectable()
export class TokenService {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly clock: Clock,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  /**
   * A new session (new refresh family), or, with familyId, the next token in
   * an existing family (refresh rotation).
   */
  async issueSession(ids: SessionIds, options: { familyId?: string } = {}): Promise<{ accessToken: string; refreshToken: string }> {
    const now = this.clock.now();
    const accessToken = await this.accessTokens.sign(ids);
    const refreshToken = randomSecret();
    await this.refreshTokens.create({
      membershipId: ids.membershipId,
      deviceId: ids.deviceId,
      familyId: options.familyId ?? randomUUID(),
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86_400_000),
    });
    return { accessToken, refreshToken };
  }
}
