import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { RequestAuth } from '../../common/auth/request-auth.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app.config.js';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Access tokens (docs/phase-a-design.md section 7): JWT, 15 minutes, ids only.
// Audience "access" and HS256 are pinned on every check, so a purpose token
// (signup, selection) or a token with another algorithm is never accepted.
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async sign(ids: RequestAuth): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return this.jwt.signAsync(
      { sub: ids.personId, mid: ids.membershipId, bid: ids.businessId, did: ids.deviceId, iat, exp: iat + ACCESS_TOKEN_SECONDS },
      { secret: this.config.jwtSecret, algorithm: 'HS256', audience: 'access' },
    );
  }

  /** The ids in a valid token, or ApiError TOKEN_EXPIRED / TOKEN_INVALID. */
  async verify(token: string): Promise<RequestAuth> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        audience: 'access',
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw new ApiError(401, 'TOKEN_EXPIRED', 'Your session has expired.');
      }
      throw invalid();
    }
    const { sub, mid, bid, did } = payload;
    if (![sub, mid, bid, did].every((v) => typeof v === 'string' && UUID.test(v))) throw invalid();
    return { personId: sub as string, membershipId: mid as string, businessId: bid as string, deviceId: did as string };
  }
}

function invalid(): ApiError {
  return new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
}
