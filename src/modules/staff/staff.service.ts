import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  type ApproverState,
  type MembershipForSession,
  type MembershipSummary,
  type PinState,
  StaffRepository,
} from './staff.repository.js';

// PIN rules (docs/phase-a-design.md section 10): 5 wrong tries lock the
// membership for 15 minutes; 10 in a row need an owner reset (staff) or a
// password login (owner).
const PIN_LOCK_EVERY = 5;
const PIN_LOCK_MINUTES = 15;
const PIN_HARD_LOCK_AFTER = 10;
export const TEMP_PIN_MAX_FAILURES = 5;

@Injectable()
export class StaffService {
  constructor(
    private readonly repo: StaffRepository,
    private readonly audit: AuditService,
  ) {}

  /** The owner membership created at signup: ACTIVE, with the owner's PIN (already hashed). */
  async createOwner(personId: string, displayName: string, pinHash: string, now: Date): Promise<MembershipSummary> {
    return this.repo.createOwner(personId, displayName, pinHash, now);
  }

  async findForSession(membershipId: string): Promise<MembershipForSession | null> {
    return this.repo.findForSession(membershipId);
  }

  async findPinState(membershipId: string): Promise<PinState | null> {
    return this.repo.findPinState(membershipId);
  }

  /** Counts the attempt atomically. The failure that starts a lock is audited (a system event). */
  async recordPinAttempt(membershipId: string, succeeded: boolean, now: Date) {
    const counters = await this.repo.recordPinAttempt(membershipId, succeeded, {
      now,
      lockEvery: PIN_LOCK_EVERY,
      lockMinutes: PIN_LOCK_MINUTES,
    });
    if (!succeeded && counters.pinFailedCount % PIN_LOCK_EVERY === 0) {
      await this.audit.record({
        action: 'pin.locked',
        targetType: 'membership',
        targetId: membershipId,
        metadata: {
          lock: counters.pinFailedCount >= PIN_HARD_LOCK_AFTER ? 'for_good' : 'timed',
          failed_count: counters.pinFailedCount,
        },
        actorMembershipId: null,
      });
    }
    return counters;
  }

  /**
   * The PIN's lock right now: locked for good after 10 failures in a row
   * (until an owner reset or, for the owner, a password login), or for
   * 15 minutes after every 5th failure.
   */
  pinLock(state: PinState, now: Date): { kind: 'none' } | { kind: 'for-good' } | { kind: 'until'; until: Date } {
    if (state.pinFailedCount >= PIN_HARD_LOCK_AFTER) return { kind: 'for-good' };
    if (state.pinLockedUntil && state.pinLockedUntil > now) return { kind: 'until', until: state.pinLockedUntil };
    return { kind: 'none' };
  }

  /** Phase C5: active members, names and roles only. */
  async listActive() {
    return this.repo.listActive();
  }

  /** Display names by membership id, any status; unknown ids are absent (Phase E4). */
  async displayNames(ids: string[]): Promise<Map<string, string>> {
    return new Map((await this.repo.displayNames([...new Set(ids)])).map((m) => [m.id, m.displayName]));
  }

  /** Phase C5: a member's approving state (PIN hash, role, status, approval lock). */
  async findApproverState(membershipId: string): Promise<ApproverState | null> {
    return this.repo.findApproverState(membershipId);
  }

  /**
   * Counts one checked approval PIN (decided in C5). The row is locked first,
   * so concurrent attempts are counted exactly. A wrong PIN always counts;
   * every lockEvery-th one starts a lock, unless one is already running.
   * A right PIN resets the count, unless a lock is running (then it is
   * refused like the rest). Never touches the PIN login counters.
   * granted: the approval may be issued. lockedNow: this attempt started a lock.
   */
  async recordApprovalAttempt(
    membershipId: string,
    succeeded: boolean,
    rules: { now: Date; lockEvery: number; lockMinutes: number },
  ): Promise<{ granted: boolean; lockedNow: boolean; failedCount: number }> {
    const current = await this.repo.lockApprovalCounters(membershipId);
    if (!current) return { granted: false, lockedNow: false, failedCount: 0 };
    const locked = current.lockedUntil !== null && current.lockedUntil > rules.now;
    if (succeeded) {
      if (locked) return { granted: false, lockedNow: false, failedCount: current.failedCount };
      if (current.failedCount !== 0) await this.repo.setApprovalCounters(membershipId, 0, current.lockedUntil);
      return { granted: true, lockedNow: false, failedCount: 0 };
    }
    const failedCount = current.failedCount + 1;
    const lockedNow = !locked && failedCount % rules.lockEvery === 0;
    const lockedUntil = lockedNow ? new Date(rules.now.getTime() + rules.lockMinutes * 60_000) : current.lockedUntil;
    await this.repo.setApprovalCounters(membershipId, failedCount, lockedUntil);
    return { granted: false, lockedNow, failedCount };
  }

  async clearPinLock(membershipId: string): Promise<void> {
    await this.repo.clearPinLock(membershipId);
  }

  // Data operations for the team module (staff lifecycle) and first login.
  list() {
    return this.repo.list();
  }

  findById(membershipId: string) {
    return this.repo.findById(membershipId);
  }

  findByPerson(personId: string) {
    return this.repo.findByPerson(personId);
  }

  createInvite(invite: Parameters<StaffRepository['createInvite']>[0]) {
    return this.repo.createInvite(invite);
  }

  reinvite(membershipId: string, invite: Parameters<StaffRepository['reinvite']>[1]) {
    return this.repo.reinvite(membershipId, invite);
  }

  update(membershipId: string, fields: Parameters<StaffRepository['update']>[1]) {
    return this.repo.update(membershipId, fields);
  }

  setStatus(membershipId: string, from: string[], to: 'ACTIVE' | 'SUSPENDED' | 'REMOVED') {
    return this.repo.setStatus(membershipId, from, to);
  }

  resetToInvite(membershipId: string, tempPinHash: string, tempPinExpiresAt: Date) {
    return this.repo.resetToInvite(membershipId, tempPinHash, tempPinExpiresAt);
  }

  /** A wrong temp PIN. The 5th kills it (docs/phase-a-design.md section 10). */
  recordTempPinFailure(membershipId: string) {
    return this.repo.recordTempPinFailure(membershipId, TEMP_PIN_MAX_FAILURES);
  }

  claimInvite(membershipId: string, pinHash: string, now: Date) {
    return this.repo.claimInvite(membershipId, pinHash, now);
  }
}
