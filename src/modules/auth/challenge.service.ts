import { Injectable } from '@nestjs/common';
import { CodeHasher } from '../../common/auth/code-hasher.js';
import { randomDigits } from '../../common/auth/secrets.js';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app.config.js';
import {
  type CreateChallengeOutcome,
  IdentityLookup,
  type OtpChannel,
  type OtpPurpose,
  type VerifyOtpOutcome,
} from '../../database/identity-lookup.js';

// Limits from docs/phase-a-design.md section 10. Send limits count every
// purpose for a target (decided in A2).
const LIMITS: Record<OtpChannel, { ttlSeconds: number }> = {
  SMS: { ttlSeconds: 5 * 60 },
  EMAIL: { ttlSeconds: 10 * 60 },
};
const MIN_GAP_SECONDS = 60;
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 10;
const MAX_ATTEMPTS = 5;
const DEV_FIXED_CODE = '123456';

export interface Challenge {
  channel: OtpChannel;
  target: string;
  purpose: OtpPurpose;
}

// Creates and checks SMS and email codes. Only hashes are stored. Sending is
// the caller's job, after its writes (never inside a transaction).
@Injectable()
export class ChallengeService {
  constructor(
    private readonly identity: IdentityLookup,
    private readonly hasher: CodeHasher,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  /** A new code, or the send limit that stopped it. The code itself is returned only to be sent. */
  async create(challenge: Challenge): Promise<{ outcome: CreateChallengeOutcome; code: string | null }> {
    const code = this.newCode(challenge.target);
    const { outcome } = await this.identity.createOtpChallenge(
      { ...challenge, codeHash: this.hasher.hash({ ...challenge, code }) },
      {
        now: this.clock.now(),
        ttlSeconds: LIMITS[challenge.channel].ttlSeconds,
        minGapSeconds: MIN_GAP_SECONDS,
        maxPerHour: MAX_PER_HOUR,
        maxPerDay: MAX_PER_DAY,
      },
    );
    return { outcome, code: outcome === 'CREATED' ? code : null };
  }

  /** One attempt; every attempt counts, right or wrong. */
  async verify(challenge: Challenge, code: string): Promise<{ challengeId: string | null; outcome: VerifyOtpOutcome }> {
    return this.identity.verifyOtp(
      { ...challenge, codeHash: this.hasher.hash({ ...challenge, code }) },
      { now: this.clock.now(), maxAttempts: MAX_ATTEMPTS },
    );
  }

  private newCode(target: string): string {
    if (this.config.authDevFixedCodes && this.config.authDevCodeAllowlist.includes(target)) {
      return DEV_FIXED_CODE;
    }
    return randomDigits(6);
  }
}
