import { Injectable } from '@nestjs/common';
import { PasswordHasher } from '../../common/auth/password-hasher.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { normalizeEmail } from '../../common/validation/contact.js';
import { type ActiveMembership, IdentityLookup } from '../../database/identity-lookup.js';
import { TenantRunner } from '../../database/tenant.js';
import { DevicesService } from '../devices/devices.service.js';
import { StaffService } from '../staff/staff.service.js';
import type { DeviceInfoDto } from './dto/device-info.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import { PurposeTokenService } from './purpose-token.service.js';
import { TokenService } from './token.service.js';

// docs/phase-a-design.md section 10.
const PASSWORD_LOCK_AFTER = 5;
const PASSWORD_LOCK_MINUTES = 15;

export interface NewDeviceSession {
  deviceId: string;
  deviceSecret: string;
  accessToken: string;
  refreshToken: string;
  membership: { id: string; businessId: string; rolePreset: string; displayName: string };
}

export type LoginResult =
  | { kind: 'session'; session: NewDeviceSession }
  | {
      kind: 'selection';
      selectionToken: string;
      memberships: { id: string; businessName: string; rolePreset: string }[];
    };

// Owner login with email and password on a new phone or after reinstall
// (docs/phase-a-design.md section 6). Unknown email, wrong password and a
// locked account all answer INVALID_CREDENTIALS after the same work: a
// lockout must never reveal whether a guess was right (decided in A3).
@Injectable()
export class LoginService {
  constructor(
    private readonly identity: IdentityLookup,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly purposeTokens: PurposeTokenService,
    private readonly tenants: TenantRunner,
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    if (dto.selection_token !== undefined) {
      const personId = await this.purposeTokens.verifySelection(dto.selection_token);
      return this.chooseMembership(personId, dto.membership_id, dto.device);
    }

    const found = await this.identity.findPersonForLogin(normalizeEmail(dto.email ?? ''));
    if (!found) {
      await this.hasher.dummyVerify(dto.password ?? '');
      throw invalidCredentials();
    }
    const now = this.clock.now();
    if (found.loginLockedUntil && found.loginLockedUntil > now) {
      // Locked: the same work and the same answer as a wrong password, and the
      // attempt is not checked at all (otherwise the lock becomes an oracle).
      await this.hasher.dummyVerify(dto.password ?? '');
      throw invalidCredentials();
    }
    const ok = await this.hasher.verify(dto.password ?? '', found.passwordHash);
    await this.identity.recordPasswordAttempt(found.personId, ok, {
      now,
      lockAfter: PASSWORD_LOCK_AFTER,
      lockForMinutes: PASSWORD_LOCK_MINUTES,
    });
    if (!ok) throw invalidCredentials();
    return this.chooseMembership(found.personId, dto.membership_id, dto.device);
  }

  private async chooseMembership(
    personId: string,
    membershipId: string | undefined,
    device: DeviceInfoDto,
  ): Promise<LoginResult> {
    const memberships = await this.identity.listActiveMemberships(personId);
    if (memberships.length === 0) {
      throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Your access to this business is not active.');
    }
    let chosen: ActiveMembership | undefined;
    if (membershipId !== undefined) {
      chosen = memberships.find((m) => m.membershipId === membershipId);
      if (!chosen) throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Your access to this business is not active.');
    } else if (memberships.length === 1) {
      chosen = memberships[0];
    } else {
      const { token } = await this.purposeTokens.signSelection(personId);
      return {
        kind: 'selection',
        selectionToken: token,
        memberships: memberships.map((m) => ({ id: m.membershipId, businessName: m.businessName, rolePreset: m.rolePreset })),
      };
    }
    return { kind: 'session', session: await this.newDeviceSession(personId, chosen, device) };
  }

  /** Registers the device, clears an owner's PIN lock, and starts a new refresh family. */
  private async newDeviceSession(personId: string, m: ActiveMembership, device: DeviceInfoDto): Promise<NewDeviceSession> {
    const now = this.clock.now();
    return this.tenants.run(m.businessId, async () => {
      const registered = await this.devices.register({
        name: device.name,
        platform: device.platform,
        registeredByMembershipId: m.membershipId,
        now,
      });
      if (m.rolePreset === 'OWNER') await this.staff.clearPinLock(m.membershipId);
      const session = await this.tokens.issueSession({
        personId,
        membershipId: m.membershipId,
        businessId: m.businessId,
        deviceId: registered.deviceId,
      });
      const membership = await this.staff.findForSession(m.membershipId);
      return {
        deviceId: registered.deviceId,
        deviceSecret: registered.deviceSecret,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        membership: {
          id: m.membershipId,
          businessId: m.businessId,
          rolePreset: m.rolePreset,
          displayName: membership?.displayName ?? '',
        },
      };
    });
  }
}

function invalidCredentials(): ApiError {
  return new ApiError(
    401,
    'INVALID_CREDENTIALS',
    'The details are not correct. If you entered a wrong password several times, wait 15 minutes and try again.',
  );
}
