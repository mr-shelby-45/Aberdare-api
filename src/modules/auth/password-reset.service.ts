import { Injectable } from '@nestjs/common';
import { PasswordHasher } from '../../common/auth/password-hasher.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { normalizeEmail } from '../../common/validation/contact.js';
import { IdentityLookup } from '../../database/identity-lookup.js';
import { TenantRunner } from '../../database/tenant.js';
import { EmailSender } from '../../integrations/email/email.sender.js';
import { AuditService } from '../audit/audit.service.js';
import { RefreshTokensService } from '../sessions/refresh-tokens.service.js';
import { ChallengeService } from './challenge.service.js';
import type { PasswordForgotDto } from './dto/password-forgot.dto.js';
import type { PasswordResetDto } from './dto/password-reset.dto.js';
import { passwordMatchesEmail } from './password-rules.js';

// How long a verified code may wait before the reset uses it. The reset
// verifies and uses the code in the same request, so this is generous.
const PROOF_MAX_AGE_SECONDS = 10 * 60;

// Owner password reset (docs/phase-a-design.md section 6). Never reveals
// whether an email has an account: forgot always answers 202, and every
// failed reset answers OTP_INVALID, whether the email is unknown or the code
// is wrong, expired or used up. (A separate OTP_EXPIRED would leak: anyone
// can request a code for any email and wait for it to expire.)
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly identity: IdentityLookup,
    private readonly challenges: ChallengeService,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly tenants: TenantRunner,
    private readonly refreshTokens: RefreshTokensService,
    private readonly audit: AuditService,
    private readonly emails: EmailSender,
  ) {}

  /** Sends a code only to an email with a password. A send limit is silent too. */
  async forgot(dto: PasswordForgotDto): Promise<void> {
    const email = normalizeEmail(dto.email);
    const person = await this.identity.findPersonForLogin(email);
    if (!person) return;
    const { code } = await this.challenges.create({ channel: 'EMAIL', target: email, purpose: 'PASSWORD_RESET' });
    if (code) {
      await this.emails.send(email, `Your Aberdare password reset code is ${code}. It expires in 10 minutes.`);
    }
  }

  /**
   * Checks the code, sets the new password, clears the password lockout, then
   * ends every session of the person in every business they belong to.
   */
  async reset(dto: PasswordResetDto): Promise<void> {
    const email = normalizeEmail(dto.email);
    if (passwordMatchesEmail(dto.new_password, email)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The password is too easy to guess.');
    }
    // scrypt first: slow on purpose, outside any transaction, and the same
    // work whether or not the email exists.
    const passwordHash = await this.hasher.hash(dto.new_password);

    const verified = await this.challenges.verify(
      { channel: 'EMAIL', target: email, purpose: 'PASSWORD_RESET' },
      dto.code,
    );
    if (verified.outcome !== 'VERIFIED' || !verified.challengeId) throw codeInvalid();

    const now = this.clock.now();
    const personId = await this.identity.resetPassword(email, verified.challengeId, passwordHash, {
      now,
      proofMaxAgeSeconds: PROOF_MAX_AGE_SECONDS,
    });
    if (!personId) throw codeInvalid();

    // One short transaction per business. The password is already changed at
    // this point; if one of these fails, the owner asks for a new code.
    for (const m of await this.identity.listActiveMemberships(personId)) {
      await this.tenants.run(m.businessId, async () => {
        const revoked = await this.refreshTokens.revokeForMembership(m.membershipId, now);
        await this.audit.record({
          action: 'password.reset',
          targetType: 'membership',
          targetId: m.membershipId,
          metadata: { revoked_count: revoked },
          actorMembershipId: null,
        });
      });
    }
  }
}

function codeInvalid(): ApiError {
  return new ApiError(400, 'OTP_INVALID', 'The code is not correct or has expired. Please request a new code.');
}
