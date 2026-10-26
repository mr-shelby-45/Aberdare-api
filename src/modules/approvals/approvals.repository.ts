import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export type ApprovalPurpose = 'STOCK_CONVERT';

// approval SQL (docs/phase-c-design.md sections 3 and 6), on the current
// tenant transaction. app_user may update only consumed_at and
// consumed_by_sync_command_id, and never delete. Minting since Phase C5.
@Injectable()
export class ApprovalsRepository {
  /** A new, unused approval. Times come from the caller (the Clock). */
  async insert(approval: {
    purpose: ApprovalPurpose;
    requesterMembershipId: string;
    approverMembershipId: string;
    deviceId: string;
    createdAt: Date;
    validUntil: Date;
  }): Promise<{ id: string; validUntil: Date }> {
    return currentTx().approval.create({
      data: { businessId: currentBusinessId(), ...approval },
      select: { id: true, validUntil: true },
    });
  }

  /**
   * Uses an approval once, in one atomic statement: of any number of
   * concurrent attempts exactly one gets the row (a concurrent one waits for
   * the row lock and then sees consumed_at set). It must be unused, for this
   * purpose, requested by this member on this device, and within its time
   * limits: the phone time within the validity window (at most 5 minutes
   * before creation, to allow a slow phone clock), and received at most 24
   * hours after creation. Returns the approver, or null for any failure, so
   * every failure looks the same. The caller re-checks the approver live.
   */
  async consume(use: {
    approvalId: string;
    purpose: ApprovalPurpose;
    requesterMembershipId: string;
    deviceId: string;
    syncCommandId: string;
    occurredAt: Date;
    receivedAt: Date;
  }): Promise<string | null> {
    const rows = await currentTx().$queryRaw<{ approver_membership_id: string }[]>`
      UPDATE approval
         SET consumed_at = ${use.receivedAt}::timestamptz,
             consumed_by_sync_command_id = ${use.syncCommandId}::uuid
       WHERE id = ${use.approvalId}::uuid
         AND business_id = ${currentBusinessId()}::uuid
         AND purpose = ${use.purpose}
         AND consumed_at IS NULL
         AND requester_membership_id = ${use.requesterMembershipId}::uuid
         AND device_id = ${use.deviceId}::uuid
         AND ${use.occurredAt}::timestamptz <= valid_until
         AND ${use.occurredAt}::timestamptz >= created_at - interval '5 minutes'
         AND ${use.receivedAt}::timestamptz <= created_at + interval '24 hours'
      RETURNING approver_membership_id`;
    return rows[0]?.approver_membership_id ?? null;
  }
}
