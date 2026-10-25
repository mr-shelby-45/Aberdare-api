import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { currentTxIfAny } from './tenant.js';

// The only code that calls the identity functions of the non-tenant access
// path (docs/phase-a-design.md section 5, migration *_a1_identity_functions).
// They run as identity_owner and each takes one exact key, so they can be
// called before any business is known (login). Inside a tenant transaction
// (for example staff creation) they run on that transaction so the work stays
// atomic; outside one they run on their own connection.

export interface PersonByPhone {
  personId: string;
  phoneVerified: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
}

export interface PersonForLogin {
  personId: string;
  passwordHash: string;
  failedLoginCount: number;
  loginLockedUntil: Date | null;
}

export interface LoginCounters {
  failedLoginCount: number;
  loginLockedUntil: Date | null;
}

export interface ActiveMembership {
  membershipId: string;
  businessId: string;
  businessName: string;
  rolePreset: string;
  status: string;
}

export interface InviteCandidate {
  membershipId: string;
  businessId: string;
  tempPinHash: string;
  tempPinExpiresAt: Date | null;
  tempPinFailedCount: number;
}

export interface DeviceForLogin {
  deviceId: string;
  businessId: string;
  secretHash: string;
  status: string;
  isShared: boolean;
}

export interface DeviceMember {
  membershipId: string;
  displayName: string;
}

export type RefreshClaimOutcome = 'CLAIMED' | 'ALREADY_USED' | 'REVOKED' | 'EXPIRED';

export interface RefreshClaim {
  refreshTokenId: string;
  businessId: string;
  membershipId: string;
  deviceId: string;
  familyId: string;
  outcome: RefreshClaimOutcome;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class IdentityLookup {
  constructor(private readonly prisma: PrismaService) {}

  private client() {
    return currentTxIfAny() ?? this.prisma;
  }

  async findPersonByPhone(phone: string): Promise<PersonByPhone | null> {
    const rows = await this.client().$queryRaw<
      { person_id: string; phone_verified: boolean; email_verified: boolean; has_password: boolean }[]
    >`SELECT * FROM identity_find_person_by_phone(${phone})`;
    const r = rows[0];
    return r
      ? {
          personId: r.person_id,
          phoneVerified: r.phone_verified,
          emailVerified: r.email_verified,
          hasPassword: r.has_password,
        }
      : null;
  }

  async findPersonForLogin(email: string): Promise<PersonForLogin | null> {
    const rows = await this.client().$queryRaw<
      { person_id: string; password_hash: string; failed_login_count: number; login_locked_until: Date | null }[]
    >`SELECT * FROM identity_find_person_for_login(${email})`;
    const r = rows[0];
    return r
      ? {
          personId: r.person_id,
          passwordHash: r.password_hash,
          failedLoginCount: r.failed_login_count,
          loginLockedUntil: r.login_locked_until,
        }
      : null;
  }

  /**
   * One atomic update. A failure adds 1 and locks the person until
   * now + lockForMinutes once the count reaches lockAfter; a success resets.
   * Returns null for an unknown person.
   */
  async recordPasswordAttempt(
    personId: string,
    succeeded: boolean,
    limits: { now: Date; lockAfter: number; lockForMinutes: number },
  ): Promise<LoginCounters | null> {
    if (!UUID.test(personId)) return null;
    const rows = await this.client().$queryRaw<
      { failed_login_count: number; login_locked_until: Date | null }[]
    >`SELECT * FROM identity_record_password_attempt(
        ${personId}::uuid, ${succeeded}, ${limits.now}::timestamptz,
        ${limits.lockAfter}::int, make_interval(mins => ${limits.lockForMinutes}::int))`;
    const r = rows[0];
    return r
      ? { failedLoginCount: r.failed_login_count, loginLockedUntil: r.login_locked_until }
      : null;
  }

  async listActiveMemberships(personId: string): Promise<ActiveMembership[]> {
    if (!UUID.test(personId)) return [];
    const rows = await this.client().$queryRaw<
      { membership_id: string; business_id: string; business_name: string; role_preset: string; status: string }[]
    >`SELECT * FROM identity_list_active_memberships(${personId}::uuid)`;
    return rows.map((r) => ({
      membershipId: r.membership_id,
      businessId: r.business_id,
      businessName: r.business_name,
      rolePreset: r.role_preset,
      status: r.status,
    }));
  }

  async findInvitesByPhone(phone: string): Promise<InviteCandidate[]> {
    const rows = await this.client().$queryRaw<
      {
        membership_id: string;
        business_id: string;
        temp_pin_hash: string;
        temp_pin_expires_at: Date | null;
        temp_pin_failed_count: number;
      }[]
    >`SELECT * FROM identity_find_invites_by_phone(${phone})`;
    return rows.map((r) => ({
      membershipId: r.membership_id,
      businessId: r.business_id,
      tempPinHash: r.temp_pin_hash,
      tempPinExpiresAt: r.temp_pin_expires_at,
      tempPinFailedCount: r.temp_pin_failed_count,
    }));
  }

  async findDevice(deviceId: string): Promise<DeviceForLogin | null> {
    // A device id from the phone is untrusted: not a UUID means no device.
    if (!UUID.test(deviceId)) return null;
    const rows = await this.client().$queryRaw<
      { device_id: string; business_id: string; secret_hash: string; status: string; is_shared: boolean }[]
    >`SELECT * FROM identity_find_device(${deviceId}::uuid)`;
    const r = rows[0];
    return r
      ? {
          deviceId: r.device_id,
          businessId: r.business_id,
          secretHash: r.secret_hash,
          status: r.status,
          isShared: r.is_shared,
        }
      : null;
  }

  /** Display names and ids only, and only when the secret hash matches a shared, active device. */
  async listDeviceMembers(deviceId: string, secretHash: string): Promise<DeviceMember[]> {
    if (!UUID.test(deviceId)) return [];
    const rows = await this.client().$queryRaw<{ membership_id: string; display_name: string }[]>`
      SELECT * FROM identity_list_device_members(${deviceId}::uuid, ${secretHash})`;
    return rows.map((r) => ({ membershipId: r.membership_id, displayName: r.display_name }));
  }

  /** Marks a refresh token used, atomically. null: unknown token. */
  async claimRefreshToken(tokenHash: string, now: Date): Promise<RefreshClaim | null> {
    const rows = await this.client().$queryRaw<
      {
        refresh_token_id: string;
        business_id: string;
        membership_id: string;
        device_id: string;
        family_id: string;
        outcome: RefreshClaimOutcome;
      }[]
    >`SELECT * FROM identity_claim_refresh_token(${tokenHash}, ${now}::timestamptz)`;
    const r = rows[0];
    return r
      ? {
          refreshTokenId: r.refresh_token_id,
          businessId: r.business_id,
          membershipId: r.membership_id,
          deviceId: r.device_id,
          familyId: r.family_id,
          outcome: r.outcome,
        }
      : null;
  }

  /** Creates the person for an E.164 phone if missing. Never changes an existing person. */
  async ensurePerson(phone: string, now: Date): Promise<{ personId: string; created: boolean }> {
    const rows = await this.client().$queryRaw<{ person_id: string; created: boolean }[]>`
      SELECT * FROM identity_ensure_person(${phone}, ${now}::timestamptz)`;
    return { personId: rows[0].person_id, created: rows[0].created };
  }
}
