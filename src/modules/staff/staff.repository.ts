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

  /** The owner's way out of a PIN lock: a successful password login. */
  async clearPinLock(membershipId: string): Promise<void> {
    await currentTx().membership.updateMany({
      where: { id: membershipId },
      data: { pinFailedCount: 0, pinLockedUntil: null },
    });
  }
}
