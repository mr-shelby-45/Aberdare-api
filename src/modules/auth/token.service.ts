import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { randomSecret, sha256 } from '../../common/auth/secrets.js';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app.config.js';
import { RefreshTokenRepository } from './refresh-token.repository.js';

const ACCESS_TOKEN_SECONDS = 15 * 60;
const REFRESH_TOKEN_DAYS = 30;

export interface SessionIds {
  personId: string;
  membershipId: string;
  businessId: string;
  deviceId: string;
}

// Issues the tokens for a new session (docs/phase-a-design.md section 7).
// A2 issues only; checking tokens, refresh and logout come in A3.
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  /**
   * An access token (JWT, 15 minutes, ids only: no permissions, no names) and
   * a new refresh token family. Must run inside the tenant transaction of the
   * session's business: the refresh token row is written there.
   */
  async issueSession(ids: SessionIds): Promise<{ accessToken: string; refreshToken: string }> {
    const now = this.clock.now();
    const iat = Math.floor(now.getTime() / 1000);
    const accessToken = await this.jwt.signAsync(
      { sub: ids.personId, mid: ids.membershipId, bid: ids.businessId, did: ids.deviceId, iat, exp: iat + ACCESS_TOKEN_SECONDS },
      { secret: this.config.jwtSecret, algorithm: 'HS256', audience: 'access' },
    );

    const refreshToken = randomSecret();
    await this.refreshTokens.create({
      membershipId: ids.membershipId,
      deviceId: ids.deviceId,
      familyId: randomUUID(),
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86_400_000),
    });
    return { accessToken, refreshToken };
  }
}
