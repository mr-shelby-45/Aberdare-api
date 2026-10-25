import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PasswordHasher } from '../../common/auth/password-hasher.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { normalizeEmail, normalizeKenyanPhone } from '../../common/validation/contact.js';
import { isUniqueViolation } from '../../database/db-errors.js';
import { IdentityLookup } from '../../database/identity-lookup.js';
import { TenantRunner } from '../../database/tenant.js';
import { EmailSender } from '../../integrations/email/email.sender.js';
import { SmsSender } from '../../integrations/sms/sms.sender.js';
import { BusinessService } from '../business/business.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { StaffService } from '../staff/staff.service.js';
import { ChallengeService } from './challenge.service.js';
import type { SignupStartDto } from './dto/signup-start.dto.js';
import type { SignupVerifyDto } from './dto/signup-verify.dto.js';
import type { SignupDto } from './dto/signup.dto.js';
import { passwordIsTooPersonal } from './password-rules.js';
import { PurposeTokenService } from './purpose-token.service.js';
import { TokenService } from './token.service.js';

// How long a verified code may wait for the final signup step (the signup
// token lives as long).
const PROOF_MAX_AGE_SECONDS = 10 * 60;

export interface SignupResult {
  deviceId: string;
  deviceSecret: string;
  accessToken: string;
  refreshToken: string;
  membership: { id: string; businessId: string; rolePreset: string; displayName: string };
}

// Owner signup (docs/phase-a-design.md section 6): start, verify, signup.
// Never reveals whether a phone or email already exists until both codes are
// proven: start and verify do the same work and answer the same way for any
// phone and email.
@Injectable()
export class SignupService {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly purposeTokens: PurposeTokenService,
    private readonly tokens: TokenService,
    private readonly identity: IdentityLookup,
    private readonly tenants: TenantRunner,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly business: BusinessService,
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
    private readonly sms: SmsSender,
    private readonly email: EmailSender,
  ) {}

  /** Creates both codes, then sends them. Answers the same for every phone and email. */
  async start(dto: SignupStartDto): Promise<void> {
    const phone = this.phoneOrReject(dto.phone);
    const email = normalizeEmail(dto.email);

    // Each create is its own committed statement; sending happens after.
    const bySms = await this.challenges.create({ channel: 'SMS', target: phone, purpose: 'SIGNUP' });
    const byEmail = await this.challenges.create({ channel: 'EMAIL', target: email, purpose: 'SIGNUP' });

    if (bySms.code) {
      await this.sms.send(phone, `Your Aberdare signup code is ${bySms.code}. It expires in 5 minutes.`);
    }
    if (byEmail.code) {
      await this.email.send(email, `Your Aberdare signup code is ${byEmail.code}. It expires in 10 minutes.`);
    }
    if (!bySms.code || !byEmail.code) {
      throw new ApiError(429, 'OTP_RATE_LIMITED', 'Too many codes requested. Please wait and try again.');
    }
  }

  /** Checks both codes (both attempts always count) and returns a signup token. */
  async verify(dto: SignupVerifyDto): Promise<{ signupToken: string; expiresInSeconds: number }> {
    const phone = this.phoneOrReject(dto.phone);
    const email = normalizeEmail(dto.email);

    const byPhone = await this.challenges.verify({ channel: 'SMS', target: phone, purpose: 'SIGNUP' }, dto.phone_code);
    const byEmail = await this.challenges.verify({ channel: 'EMAIL', target: email, purpose: 'SIGNUP' }, dto.email_code);

    if (byPhone.outcome === 'VERIFIED' && byEmail.outcome === 'VERIFIED' && byPhone.challengeId && byEmail.challengeId) {
      const { token, expiresInSeconds } = await this.purposeTokens.signSignup({
        phoneChallengeId: byPhone.challengeId,
        emailChallengeId: byEmail.challengeId,
        phone,
        email,
      });
      return { signupToken: token, expiresInSeconds };
    }
    // Never say which of the two codes was wrong.
    if (byPhone.outcome === 'EXPIRED' || byEmail.outcome === 'EXPIRED') {
      throw new ApiError(400, 'OTP_EXPIRED', 'A code has expired. Please request new codes.');
    }
    throw new ApiError(400, 'OTP_INVALID', 'The codes are not correct.');
  }

  /**
   * One transaction: consume both proven codes and create or complete the
   * person, then the business, the owner membership, the device and the
   * tokens. Any failure undoes all of it, including the consumed codes.
   */
  async signup(dto: SignupDto): Promise<SignupResult> {
    const claims = await this.purposeTokens.verifySignup(dto.signup_token);
    if (passwordIsTooPersonal(dto.password, claims.phone, claims.email)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The password is too easy to guess.');
    }

    // scrypt is slow on purpose; do it before the transaction opens.
    const passwordHash = await this.hasher.hash(dto.password);
    const pinHash = await this.hasher.hash(dto.pin);
    const businessId = randomUUID();
    const now = this.clock.now();

    try {
      return await this.tenants.run(businessId, async () => {
        const person = await this.identity.completeOwnerSignup(
          {
            phone: claims.phone,
            email: claims.email,
            passwordHash,
            phoneChallengeId: claims.phoneChallengeId,
            emailChallengeId: claims.emailChallengeId,
          },
          { now, proofMaxAgeSeconds: PROOF_MAX_AGE_SECONDS },
        );
        // ACCOUNT_EXISTS first: it also comes back without a person id.
        if (person.outcome === 'ACCOUNT_EXISTS') {
          throw this.accountExists();
        }
        if (person.outcome === 'PROOF_INVALID' || !person.personId) {
          // Replayed, already used, too old, or not these codes.
          throw new ApiError(401, 'TOKEN_INVALID', 'Please start again.');
        }

        await this.business.createForSignup(dto.business_name, dto.business_type);
        const membership = await this.staff.createOwner(person.personId, dto.owner_name, pinHash, now);
        const device = await this.devices.register({
          name: dto.device.name,
          platform: dto.device.platform,
          registeredByMembershipId: membership.id,
          now,
        });
        const session = await this.tokens.issueSession({
          personId: person.personId,
          membershipId: membership.id,
          businessId,
          deviceId: device.deviceId,
        });
        return {
          deviceId: device.deviceId,
          deviceSecret: device.deviceSecret,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          membership: {
            id: membership.id,
            businessId: membership.businessId,
            rolePreset: membership.rolePreset,
            displayName: membership.displayName,
          },
        };
      });
    } catch (err) {
      // A concurrent signup took this phone or email after the check.
      if (isUniqueViolation(err)) throw this.accountExists();
      throw err;
    }
  }

  private accountExists(): ApiError {
    return new ApiError(409, 'ACCOUNT_EXISTS', 'An account already exists. Please log in.');
  }

  private phoneOrReject(input: string): string {
    const phone = normalizeKenyanPhone(input);
    if (!phone) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: phone');
    return phone;
  }
}
