import { Injectable } from '@nestjs/common';
import {
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
  constructor(private readonly repo: StaffRepository) {}

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

  async recordPinAttempt(membershipId: string, succeeded: boolean, now: Date) {
    return this.repo.recordPinAttempt(membershipId, succeeded, {
      now,
      lockEvery: PIN_LOCK_EVERY,
      lockMinutes: PIN_LOCK_MINUTES,
    });
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
