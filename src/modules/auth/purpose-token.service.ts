import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app.config.js';

const SIGNUP_TOKEN_SECONDS = 10 * 60;
const SELECTION_TOKEN_SECONDS = 5 * 60;

export interface SignupClaims {
  phoneChallengeId: string;
  emailChallengeId: string;
  phone: string;
  email: string;
}

// Short-lived signed tokens for one step of a flow (signup now; selection and
// setup tokens in A3 and A4). Each kind has its own audience, so a token made
// for one purpose (or an access token) is refused for any other.
@Injectable()
export class PurposeTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async signSignup(claims: SignupClaims): Promise<{ token: string; expiresInSeconds: number }> {
    const iat = this.nowSeconds();
    const token = await this.jwt.signAsync(
      { pc: claims.phoneChallengeId, ec: claims.emailChallengeId, ph: claims.phone, em: claims.email, iat, exp: iat + SIGNUP_TOKEN_SECONDS },
      { secret: this.config.jwtSecret, algorithm: 'HS256', audience: 'signup' },
    );
    return { token, expiresInSeconds: SIGNUP_TOKEN_SECONDS };
  }

  /** The claims, or ApiError TOKEN_EXPIRED / TOKEN_INVALID. */
  async verifySignup(token: string): Promise<SignupClaims> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        audience: 'signup',
        clockTimestamp: this.nowSeconds(),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw new ApiError(401, 'TOKEN_EXPIRED', 'This step took too long. Please start again.');
      }
      throw new ApiError(401, 'TOKEN_INVALID', 'Please start again.');
    }
    const { pc, ec, ph, em } = payload;
    if (typeof pc !== 'string' || typeof ec !== 'string' || typeof ph !== 'string' || typeof em !== 'string') {
      throw new ApiError(401, 'TOKEN_INVALID', 'Please start again.');
    }
    return { phoneChallengeId: pc, emailChallengeId: ec, phone: ph, email: em };
  }

  /** For a person with several businesses: lets the second login call choose one without the password. */
  async signSelection(personId: string): Promise<{ token: string; expiresInSeconds: number }> {
    const iat = this.nowSeconds();
    const token = await this.jwt.signAsync(
      { sub: personId, iat, exp: iat + SELECTION_TOKEN_SECONDS },
      { secret: this.config.jwtSecret, algorithm: 'HS256', audience: 'selection' },
    );
    return { token, expiresInSeconds: SELECTION_TOKEN_SECONDS };
  }

  /** The person id, or ApiError TOKEN_EXPIRED / TOKEN_INVALID. */
  async verifySelection(token: string): Promise<string> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        audience: 'selection',
        clockTimestamp: this.nowSeconds(),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw new ApiError(401, 'TOKEN_EXPIRED', 'This step took too long. Please log in again.');
      }
      throw new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
    }
    if (typeof payload.sub !== 'string') throw new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
    return payload.sub;
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }
}
