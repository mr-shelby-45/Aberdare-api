import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface MembershipSummary {
  id: string;
  businessId: string;
  personId: string;
  displayName: string;
  rolePreset: string;
  status: string;
}

export interface MembershipForSession {
  id: string;
  personId: string;
  displayName: string;
  rolePreset: string;
  status: string;
  extraPermissions: string[] | null;
}

export interface PinState {
  id: string;
  personId: string;
  rolePreset: string;
  status: string;
  pinHash: string | null;
  pinFailedCount: number;
  pinLockedUntil: Date | null;
}

@Injectable()
export class StaffRepository {
  async createOwner(personId: string, displayName: string, pinHash: string, now: Date): Promise<MembershipSummary> {
    return currentTx().membership.create({
      data: {
        businessId: currentBusinessId(),
        personId,
        displayName,
        rolePreset: 'OWNER',
        status: 'ACTIVE',
        pinHash,
        pinSetAt: now,
      },
      select: { id: true, businessId: true, personId: true, displayName: true, rolePreset: true, status: true },
    });
  }

  async findForSession(membershipId: string): Promise<MembershipForSession | null> {
    return currentTx().membership.findUnique({
      where: { id: membershipId },
      select: { id: true, personId: true, displayName: true, rolePreset: true, status: true, extraPermissions: true },
    });
  }

  async findPinState(membershipId: string): Promise<PinState | null> {
    return currentTx().membership.findUnique({
      where: { id: membershipId },
      select: { id: true, personId: true, rolePreset: true, status: true, pinHash: true, pinFailedCount: true, pinLockedUntil: true },
    });
  }

  /**
   * One atomic statement, so concurrent wrong PINs are all counted. Success
   * resets. A failure locks until now + lockMinutes every lockEvery-th wrong
   * try. The lock "for good" is the failure count itself (see StaffService),
   * not a special date: Prisma reads timestamptz 'infinity' as an Invalid
   * Date, which compares false with everything (found in A3).
   */
  async recordPinAttempt(
    membershipId: string,
    succeeded: boolean,
    rules: { now: Date; lockEvery: number; lockMinutes: number },
  ): Promise<{ pinFailedCount: number; pinLockedUntil: Date | null }> {
    const rows = await currentTx().$queryRaw<{ pin_failed_count: number; pin_locked_until: Date | null }[]>`
      UPDATE membership m
         SET pin_failed_count = CASE WHEN ${succeeded} THEN 0 ELSE m.pin_failed_count + 1 END,
             pin_locked_until = CASE
               WHEN ${succeeded} THEN NULL
               WHEN (m.pin_failed_count + 1) % ${rules.lockEvery}::int = 0
                 THEN ${rules.now}::timestamptz + make_interval(mins => ${rules.lockMinutes}::int)
               ELSE m.pin_locked_until
             END
       WHERE m.id = ${membershipId}::uuid
         AND m.business_id = ${currentBusinessId()}::uuid
      RETURNING m.pin_failed_count, m.pin_locked_until`;
    return { pinFailedCount: rows[0].pin_failed_count, pinLockedUntil: rows[0].pin_locked_until };
  }

  /** Every membership of the current business, with the phone (never any hash). */
  async list() {
    return currentTx().membership.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        displayName: true,
        rolePreset: true,
        status: true,
        extraPermissions: true,
        createdAt: true,
        person: { select: { phone: true } },
      },
    });
  }

  async findById(membershipId: string) {
    return currentTx().membership.findUnique({
      where: { id: membershipId },
      select: { id: true, personId: true, displayName: true, rolePreset: true, status: true, extraPermissions: true },
    });
  }

  async findByPerson(personId: string) {
    return currentTx().membership.findFirst({
      where: { personId },
      select: { id: true, status: true },
    });
  }

  async createInvite(invite: {
    id: string;
    personId: string;
    displayName: string;
    rolePreset: 'MANAGER' | 'ATTENDANT';
    extraPermissions: string[];
    tempPinHash: string;
    tempPinExpiresAt: Date;
    createdByMembershipId: string;
  }): Promise<void> {
    await currentTx().membership.create({
      data: { businessId: currentBusinessId(), status: 'INVITED', ...invite },
      select: { id: true },
    });
  }

  /** A REMOVED member invited again: same row, fresh invite. Returns false if it was not REMOVED. */
  async reinvite(
    membershipId: string,
    invite: { displayName: string; rolePreset: 'MANAGER' | 'ATTENDANT'; extraPermissions: string[]; tempPinHash: string; tempPinExpiresAt: Date },
  ): Promise<boolean> {
    const { count } = await currentTx().membership.updateMany({
      where: { id: membershipId, status: 'REMOVED' },
      data: {
        ...invite,
        status: 'INVITED',
        tempPinFailedCount: 0,
        pinHash: null,
        pinSetAt: null,
        pinFailedCount: 0,
        pinLockedUntil: null,
      },
    });
    return count === 1;
  }

  async update(membershipId: string, fields: { displayName?: string; rolePreset?: 'MANAGER' | 'ATTENDANT'; extraPermissions?: string[] }): Promise<void> {
    await currentTx().membership.updateMany({ where: { id: membershipId }, data: fields });
  }

  /** Moves the status only from one of `from`. Returns false if it was in another state. */
  async setStatus(membershipId: string, from: string[], to: 'ACTIVE' | 'SUSPENDED' | 'REMOVED'): Promise<boolean> {
    const { count } = await currentTx().membership.updateMany({
      where: { id: membershipId, status: { in: from as ('INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED')[] } },
      data: { status: to },
    });
    return count === 1;
  }

  /** PIN reset: back to INVITED with a new temp PIN; the old PIN and its counters are gone. */
  async resetToInvite(membershipId: string, tempPinHash: string, tempPinExpiresAt: Date): Promise<void> {
    await currentTx().membership.updateMany({
      where: { id: membershipId },
      data: {
        status: 'INVITED',
        tempPinHash,
        tempPinExpiresAt,
        tempPinFailedCount: 0,
        pinHash: null,
        pinSetAt: null,
        pinFailedCount: 0,
        pinLockedUntil: null,
      },
    });
  }

  /** One atomic statement: a wrong temp PIN; at `killAt` the temp PIN stops working. */
  async recordTempPinFailure(membershipId: string, killAt: number): Promise<void> {
    await currentTx().$executeRaw`
      UPDATE membership m
         SET temp_pin_failed_count = m.temp_pin_failed_count + 1,
             temp_pin_hash = CASE WHEN m.temp_pin_failed_count + 1 >= ${killAt}::int THEN NULL ELSE m.temp_pin_hash END
       WHERE m.id = ${membershipId}::uuid
         AND m.business_id = ${currentBusinessId()}::uuid
         AND m.status = 'INVITED'
         AND m.temp_pin_hash IS NOT NULL`;
  }

  /**
   * Activation, in one atomic statement: only a live invite becomes ACTIVE,
   * so a second activation (or a replayed setup token) changes nothing.
   */
  async claimInvite(membershipId: string, pinHash: string, now: Date): Promise<{ personId: string; displayName: string; rolePreset: string } | null> {
    const rows = await currentTx().$queryRaw<{ person_id: string; display_name: string; role_preset: string }[]>`
      UPDATE membership m
         SET status = 'ACTIVE', pin_hash = ${pinHash}, pin_set_at = ${now}::timestamptz,
             pin_failed_count = 0, pin_locked_until = NULL,
             temp_pin_hash = NULL, temp_pin_expires_at = NULL, temp_pin_failed_count = 0
       WHERE m.id = ${membershipId}::uuid
         AND m.business_id = ${currentBusinessId()}::uuid
         AND m.status = 'INVITED'
         AND m.temp_pin_hash IS NOT NULL
         AND m.temp_pin_expires_at > ${now}::timestamptz
      RETURNING m.person_id, m.display_name, m.role_preset::text AS role_preset`;
    const r = rows[0];
    return r ? { personId: r.person_id, displayName: r.display_name, rolePreset: r.role_preset } : null;
  }

  /** The owner's way out of a PIN lock: a successful password login. */
  async clearPinLock(membershipId: string): Promise<void> {
    await currentTx().membership.updateMany({
      where: { id: membershipId },
      data: { pinFailedCount: 0, pinLockedUntil: null },
    });
  }
}
