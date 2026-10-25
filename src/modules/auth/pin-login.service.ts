import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PasswordHasher } from '../../common/auth/password-hasher.js';
import { sha256 } from '../../common/auth/secrets.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { IdentityLookup } from '../../database/identity-lookup.js';
import { TenantRunner } from '../../database/tenant.js';
import { DevicesService } from '../devices/devices.service.js';
import { StaffService } from '../staff/staff.service.js';
import type { PinLoginDto } from './dto/pin-login.dto.js';
import { TokenService } from './token.service.js';

export interface PinSession {
  accessToken: string;
  refreshToken: string;
  membership: { id: string; businessId: string; rolePreset: string; displayName: string };
}

// Daily login: device id + device secret + PIN (docs/phase-a-design.md
// section 6). The device secret is what identifies the phone; the PIN only
// unlocks it. A wrong secret, an unknown device and a wrong PIN all answer
// INVALID_CREDENTIALS after the same work. A locked PIN answers ACCOUNT_LOCKED
// without checking the PIN, so the lock is never a guessing oracle.
@Injectable()
export class PinLoginService {
  constructor(
    private readonly identity: IdentityLookup,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly tenants: TenantRunner,
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: PinLoginDto): Promise<PinSession> {
    const device = await this.identity.findDevice(dto.device_id);
    if (!device || !sameSha256Hex(sha256(dto.device_secret), device.secretHash)) {
      await this.hasher.dummyVerify(dto.pin);
      throw invalidCredentials();
    }
    if (device.status !== 'ACTIVE') {
      throw new ApiError(403, 'DEVICE_REVOKED', 'This device is no longer allowed. Please log in again.');
    }

    // Short transaction 1: which membership, and its PIN state.
    const state = await this.tenants.run(device.businessId, async () => {
      const d = await this.devices.findForSession(device.deviceId);
      if (!d) return null;
      const membershipId = d.isShared ? dto.membership_id : d.registeredByMembershipId;
      if (!membershipId || (dto.membership_id !== undefined && dto.membership_id !== membershipId)) return null;
      if (!(await this.devices.belongsTo(d, membershipId))) return null;
      return this.staff.findPinState(membershipId);
    });
    if (!state || !state.pinHash) {
      await this.hasher.dummyVerify(dto.pin);
      throw invalidCredentials();
    }
    if (state.status !== 'ACTIVE') {
      throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Your access to this business is not active.');
    }
    const now = this.clock.now();
    const lock = this.staff.pinLock(state, now);
    if (lock.kind === 'for-good') throw pinLockedForGood(state.rolePreset);
    if (lock.kind === 'until') throw pinLockedUntil(lock.until, now);

    // Outside any transaction: scrypt is slow on purpose.
    const ok = await this.hasher.verify(dto.pin, state.pinHash);

    // Short transaction 2: count the attempt atomically, then issue tokens.
    const result = await this.tenants.run(device.businessId, async () => {
      const counters = await this.staff.recordPinAttempt(state.id, ok, now);
      if (!ok) return { ok: false as const, counters };
      await this.devices.touchLastSeen(device.deviceId, now);
      const session = await this.tokens.issueSession({
        personId: state.personId,
        membershipId: state.id,
        businessId: device.businessId,
        deviceId: device.deviceId,
      });
      const m = await this.staff.findForSession(state.id);
      return { ok: true as const, session, displayName: m?.displayName ?? '' };
    });
    if (!result.ok) throw invalidCredentials();
    return {
      accessToken: result.session.accessToken,
      refreshToken: result.session.refreshToken,
      membership: { id: state.id, businessId: device.businessId, rolePreset: state.rolePreset, displayName: result.displayName },
    };
  }
}

/** Constant-time comparison of two SHA-256 hex strings. */
function sameSha256Hex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

function invalidCredentials(): ApiError {
  return new ApiError(401, 'INVALID_CREDENTIALS', 'The details are not correct.');
}

function pinLockedForGood(rolePreset: string): ApiError {
  return new ApiError(
    423,
    'ACCOUNT_LOCKED',
    rolePreset === 'OWNER'
      ? 'This PIN is locked. Log in with your email and password to unlock it.'
      : 'This PIN is locked. Ask the owner to reset it.',
  );
}

function pinLockedUntil(until: Date, now: Date): ApiError {
  const seconds = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
  return new ApiError(
    423,
    'ACCOUNT_LOCKED',
    `Too many wrong PINs. Try again in ${Math.ceil(seconds / 60)} minutes.`,
    { 'retry-after': String(seconds) },
  );
}
