import { Injectable } from '@nestjs/common';
import { signedCents } from '../../common/money/cents.js';
import { NotificationsService } from './notifications.service.js';

// The events of Phase F4 (docs/phase-f-design.md section 6): who is told what,
// in one place. Each is called by its command, in the command's transaction,
// after the command's own writes; notify() never fails the command. Data holds
// ids, counts, enums and flags only.
@Injectable()
export class NotificationEvents {
  constructor(private readonly notifications: NotificationsService) {}

  /** sale.create ended FLAGGED: active owners, except the member who made the sale (section 5: never the cause). */
  async saleFlagged(sale: { saleId: string; saleNumber: number; flags: readonly string[] }, actorMembershipId: string): Promise<void> {
    if (sale.flags.length === 0) return;
    await this.notifications.notify(
      { type: 'sale.flagged', dedupeKey: `sale.flagged:${sale.saleId}`, data: { sale_id: sale.saleId, sale_number: sale.saleNumber, flags: [...sale.flags] } },
      [{ to: 'OWNERS', channels: ['IN_APP'] }],
      { exclude: [actorMembershipId] },
    );
  }

  /** stock.convert accepted: active owners except the converter. */
  async stockConverted(conversionId: string, converterMembershipId: string): Promise<void> {
    await this.notifications.notify(
      { type: 'stock.converted', dedupeKey: `stock.converted:${conversionId}`, data: { conversion_id: conversionId, converter_membership_id: converterMembershipId } },
      [{ to: 'OWNERS', channels: ['IN_APP'] }],
      { exclude: [converterMembershipId] },
    );
  }

  /**
   * A PIN approval was used (stock.convert or sale.void): the approver in-app
   * and by push; owners other than the approver and the requester in-app.
   */
  async approvalUsed(a: { approvalId: string; purpose: string; requesterMembershipId: string; approverMembershipId: string; targetId: string }): Promise<void> {
    await this.notifications.notify(
      {
        type: 'approval.used',
        dedupeKey: `approval.used:${a.approvalId}`,
        data: { approval_id: a.approvalId, purpose: a.purpose, requester_membership_id: a.requesterMembershipId, approver_membership_id: a.approverMembershipId, target_id: a.targetId },
      },
      [
        { to: [a.approverMembershipId], channels: ['IN_APP', 'PUSH'] },
        { to: 'OWNERS', channels: ['IN_APP'] },
      ],
      { exclude: [a.requesterMembershipId] },
    );
  }

  /**
   * Phase F5, the stale-device job: active owners, in-app. The key holds the
   * last sync time (or "never"), so the job running twice notifies once and a
   * device that syncs and goes stale again is a new episode.
   */
  async deviceStale(d: { deviceId: string; membershipId: string; lastSyncAt: Date | null; days: number }): Promise<void> {
    await this.notifications.notify(
      { type: 'device.stale', dedupeKey: `device.stale:${d.deviceId}:${d.lastSyncAt ? d.lastSyncAt.toISOString() : 'never'}`, data: { device_id: d.deviceId, membership_id: d.membershipId, days: d.days } },
      [{ to: 'OWNERS', channels: ['IN_APP'] }],
    );
  }

  /** settlement.close with a cash or line variance: active owners except the closer, in-app and by push. */
  async settlementVariance(s: { settlementId: string; attendantMembershipId: string; closerMembershipId: string; cashVariance: string; linesWithVariance: number }): Promise<void> {
    if (signedCents(s.cashVariance) === 0n && s.linesWithVariance === 0) return;
    await this.notifications.notify(
      {
        type: 'settlement.variance',
        dedupeKey: `settlement.variance:${s.settlementId}`,
        data: { settlement_id: s.settlementId, attendant_membership_id: s.attendantMembershipId, cash_variance: s.cashVariance, lines_with_variance: s.linesWithVariance },
      },
      [{ to: 'OWNERS', channels: ['IN_APP', 'PUSH'] }],
      { exclude: [s.closerMembershipId] },
    );
  }
}
