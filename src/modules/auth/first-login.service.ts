import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { CodeHasher } from '../../common/auth/code-hasher.js';
import { PasswordHasher } from '../../common/auth/password-hasher.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { normalizeKenyanPhone } from '../../common/validation/contact.js';
import { IdentityLookup, type InviteCandidate } from '../../database/identity-lookup.js';
import { TenantRunner } from '../../database/tenant.js';
import { SmsSender } from '../../integrations/sms/sms.sender.js';
import { DevicesService } from '../devices/devices.service.js';
import { StaffService, TEMP_PIN_MAX_FAILURES } from '../staff/staff.service.js';
import { tempPinHashInput } from '../staff/temp-pin.js';
import { ChallengeService } from './challenge.service.js';
import type { ActivateDto } from './dto/activate.dto.js';
import type { FirstLoginDto } from './dto/first-login.dto.js';
import type { NewDeviceSession } from './login.service.js';
import { PurposeTokenService } from './purpose-token.service.js';
import { TokenService } from './token.service.js';

const PROOF_MAX_AGE_SECONDS = 10 * 60;

// Staff first login and activation (docs/phase-a-design.md section 6).
// A wrong temp PIN, an unknown phone and an expired or killed invite all
// answer INVALID_CREDENTIALS.
@Injectable()
export class FirstLoginService {
  constructor(
    private readonly identity: IdentityLookup,
    private readonly codes: CodeHasher,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly tenants: TenantRunner,
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
    private readonly challenges: ChallengeService,
    private readonly purposeTokens: PurposeTokenService,
    private readonly tokens: TokenService,
    private readonly sms: SmsSender,
  ) {}

  /** Matches the temp PIN against the phone's invites, then sends an SMS code. */
  async firstLogin(dto: FirstLoginDto): Promise<{ setupToken: string; expiresInSeconds: number }> {
    const phone = normalizeKenyanPhone(dto.phone);
    const invites = phone ? await this.identity.findInvitesByPhone(phone) : [];
    const now = this.clock.now();
    const live = invites.filter((i) => i.tempPinFailedCount < TEMP_PIN_MAX_FAILURES);
    const matches = live.filter(
      (i) => i.tempPinExpiresAt !== null && i.tempPinExpiresAt > now && this.matches(i, dto.temp_pin),
    );

    if (matches.length === 0) {
      // Count it against every live invite for this phone, each in its own
      // business, so guesses cannot be spread across businesses.
      for (const invite of live) {
        await this.tenants.run(invite.businessId, () => this.staff.recordTempPinFailure(invite.membershipId));
      }
      throw invalidCredentials();
    }
    if (matches.length > 1) {
      throw new ApiError(409, 'AMBIGUOUS_INVITE', 'Please ask the owner to send you a new invite.');
    }

    const [invite] = matches;
    const created = await this.challenges.create({ channel: 'SMS', target: phone!, purpose: 'STAFF_ACTIVATE' });
    if (!created.code) {
      throw new ApiError(429, 'OTP_RATE_LIMITED', 'Too many codes requested. Please wait and try again.');
    }
    await this.sms.send(phone!, `Your Aberdare activation code is ${created.code}. It expires in 5 minutes.`);
    const { token, expiresInSeconds } = await this.purposeTokens.signSetup({
      membershipId: invite.membershipId,
      businessId: invite.businessId,
      phone: phone!,
    });
    return { setupToken: token, expiresInSeconds };
  }

  /**
   * Checks the SMS code, then in one transaction: claims the invite (status
   * ACTIVE, the new PIN, temp PIN gone), consumes the code and marks the
   * phone verified, registers the device, issues tokens.
   */
  async activate(dto: ActivateDto): Promise<NewDeviceSession> {
    const claims = await this.purposeTokens.verifySetup(dto.setup_token);
    const verified = await this.challenges.verify(
      { channel: 'SMS', target: claims.phone, purpose: 'STAFF_ACTIVATE' },
      dto.code,
    );
    if (verified.outcome !== 'VERIFIED' || !verified.challengeId) {
      if (verified.outcome === 'EXPIRED') throw new ApiError(400, 'OTP_EXPIRED', 'The code has expired. Please start again.');
      throw new ApiError(400, 'OTP_INVALID', 'The code is not correct.');
    }
    const challengeId = verified.challengeId;
    const pinHash = await this.hasher.hash(dto.new_pin);
    const now = this.clock.now();

    return this.tenants.run(claims.businessId, async () => {
      const claimed = await this.staff.claimInvite(claims.membershipId, pinHash, now);
      if (!claimed) throw tokenInvalid();
      const phoneOk = await this.identity.activatePhone(claimed.personId, challengeId, {
        now,
        proofMaxAgeSeconds: PROOF_MAX_AGE_SECONDS,
      });
      if (!phoneOk) throw tokenInvalid(); // rolls back the claim too

      const device = await this.devices.register({
        name: dto.device.name,
        platform: dto.device.platform,
        registeredByMembershipId: claims.membershipId,
        now,
      });
      const session = await this.tokens.issueSession({
        personId: claimed.personId,
        membershipId: claims.membershipId,
        businessId: claims.businessId,
        deviceId: device.deviceId,
      });
      return {
        deviceId: device.deviceId,
        deviceSecret: device.deviceSecret,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        membership: {
          id: claims.membershipId,
          businessId: claims.businessId,
          rolePreset: claimed.rolePreset,
          displayName: claimed.displayName,
        },
      };
    });
  }

  /** Constant-time comparison against this invite's own HMAC. */
  private matches(invite: InviteCandidate, tempPin: string): boolean {
    const expected = Buffer.from(invite.tempPinHash, 'hex');
    const actual = Buffer.from(this.codes.hash(tempPinHashInput(invite.membershipId, tempPin)), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

function invalidCredentials(): ApiError {
  return new ApiError(401, 'INVALID_CREDENTIALS', 'The details are not correct.');
}

function tokenInvalid(): ApiError {
  return new ApiError(401, 'TOKEN_INVALID', 'Please start again.');
}
