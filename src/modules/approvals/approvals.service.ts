import { Injectable } from '@nestjs/common';
import { PasswordHasher } from '../../common/auth/password-hasher.js';
import { type RolePreset, effectivePermissions } from '../../common/auth/permissions.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { TenantRunner } from '../../database/tenant.js';
import { AuditService } from '../audit/audit.service.js';
import { StaffService } from '../staff/staff.service.js';
import { type ApprovalPurpose, ApprovalsRepository } from './approvals.repository.js';
import type { CreateApprovalDto } from './dto/create-approval.dto.js';

// docs/phase-c-design.md section 6.
const VALID_MINUTES = 15;
const LOCK_EVERY = 5;
const LOCK_MINUTES = 15;

/** Who is asking, all from the token and the live session. */
export interface ApprovalCaller {
  businessId: string;
  membershipId: string;
  deviceId: string;
  permissions: ReadonlySet<string>;
}

// Approvals (Phase C5): an attendant gets a short-lived approval from a
// manager's or owner's PIN, then uses it once to convert stock.
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly tenants: TenantRunner,
    private readonly repo: ApprovalsRepository,
    private readonly staff: StaffService,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** GET /v1/stock/approvers: active members other than the caller who can convert. Names only. */
  async listApprovers(callerMembershipId: string): Promise<{ membershipId: string; displayName: string; rolePreset: string }[]> {
    const members = await this.staff.listActive();
    return members
      .filter((m) => m.id !== callerMembershipId && canConvert(m.rolePreset, m.extraPermissions))
      .map((m) => ({ membershipId: m.id, displayName: m.displayName, rolePreset: m.rolePreset }));
  }

  /**
   * POST /v1/stock/approvals. Runs outside the request transaction
   * (@OwnTransactions), like PIN login: a short transaction reads the
   * approver, the PIN is checked outside any transaction (scrypt is slow on
   * purpose), and a second short transaction counts the attempt and mints.
   * Every refusal is the same 403 APPROVAL_DENIED after exactly one scrypt
   * call; a locked approver's PIN is not even checked (a dummy hash), so the
   * lock is never a guessing oracle. Only real approvers are counted: naming
   * someone who cannot approve locks nobody (decided in C5).
   */
  async mint(caller: ApprovalCaller, dto: CreateApprovalDto): Promise<{ approvalId: string; validUntil: Date }> {
    if (caller.permissions.has('stock.convert')) {
      throw new ApiError(422, 'APPROVAL_NOT_NEEDED', 'You can convert stock yourself; no approval is needed.');
    }
    const now = this.clock.now();
    const approver = await this.tenants.run(caller.businessId, () => this.staff.findApproverState(dto.approver_membership_id));
    const eligible =
      approver !== null &&
      approver.status === 'ACTIVE' &&
      approver.id !== caller.membershipId &&
      approver.pinHash !== null &&
      canConvert(approver.rolePreset, approver.extraPermissions);
    const locked = eligible && approver.approvalLockedUntil !== null && approver.approvalLockedUntil > now;
    if (!eligible || locked) {
      await this.hasher.dummyVerify(dto.approver_pin);
      throw denied();
    }

    // Outside any transaction.
    const ok = await this.hasher.verify(dto.approver_pin, approver.pinHash!);

    const minted = await this.tenants.run(caller.businessId, async () => {
      const attempt = await this.staff.recordApprovalAttempt(approver.id, ok, { now, lockEvery: LOCK_EVERY, lockMinutes: LOCK_MINUTES });
      if (attempt.lockedNow) {
        await this.audit.record({
          action: 'approval.locked',
          targetType: 'membership',
          targetId: approver.id,
          metadata: { approver_membership_id: approver.id, failed_count: attempt.failedCount },
        });
      }
      if (!attempt.granted) return null;
      const purpose: ApprovalPurpose = dto.purpose;
      const approval = await this.repo.insert({
        purpose,
        requesterMembershipId: caller.membershipId,
        approverMembershipId: approver.id,
        deviceId: caller.deviceId,
        createdAt: now,
        validUntil: new Date(now.getTime() + VALID_MINUTES * 60_000),
      });
      await this.audit.record({
        action: 'approval.granted',
        targetType: 'approval',
        targetId: approval.id,
        metadata: { requester_membership_id: caller.membershipId, approver_membership_id: approver.id, purpose },
      });
      return approval;
    });
    if (!minted) throw denied();
    return { approvalId: minted.id, validUntil: minted.validUntil };
  }

  /**
   * stock.convert by a member without stock.convert: uses the approval once
   * (one atomic statement bound to the requester, the device and the time
   * limits), then re-checks the approver live. Returns the approver, or null
   * for every kind of failure. Runs in the command's savepoint, so a
   * conversion that fails afterwards leaves the approval unused.
   */
  async useForConversion(use: {
    approvalId: string;
    requesterMembershipId: string;
    deviceId: string;
    syncCommandId: string;
    occurredAt: Date;
    receivedAt: Date;
  }): Promise<string | null> {
    const approverId = await this.repo.consume({ ...use, purpose: 'STOCK_CONVERT' });
    if (!approverId) return null;
    const approver = await this.staff.findForSession(approverId);
    if (!approver || approver.status !== 'ACTIVE' || !canConvert(approver.rolePreset, approver.extraPermissions)) return null;
    return approverId;
  }
}

/** The live rule: preset plus extras, where an attendant never gets stock.convert. */
function canConvert(rolePreset: string, extras: readonly string[] | null): boolean {
  return effectivePermissions(rolePreset as RolePreset, extras).has('stock.convert');
}

function denied(): ApiError {
  return new ApiError(403, 'APPROVAL_DENIED', 'The approval was not given.');
}
