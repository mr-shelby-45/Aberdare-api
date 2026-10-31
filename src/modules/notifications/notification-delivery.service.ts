import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { NOTIFY_CLAIM_BATCH, NOTIFY_LEASE_MS, NOTIFY_MAX_ATTEMPTS, NOTIFY_RETRY_DELAYS_MS, PUSH_SEND_TIMEOUT_MS } from '../../config/app.config.js';
import { ErrorEventLog } from '../../database/error-event-log.js';
import { TenantRunner } from '../../database/tenant.js';
import { type PushResult, PushSender } from '../../integrations/push/push.sender.js';
import { DevicesService } from '../devices/devices.service.js';
import { notificationMessage } from './notification-messages.js';
import { type ClaimedPush, NotificationsRepository } from './notifications.repository.js';

/** One device's answer: the provider's, or our own when it threw or did not answer in time. */
type SendOutcome = PushResult | 'THROWN' | 'TIMEOUT';

export interface DispatchResult {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  // A full batch was claimed: there may be more due now.
  more: boolean;
}

// Push delivery (Phase F3, docs/phase-f-design.md section 5), run by the
// worker for one business at a time. Three steps, never a sender inside a
// transaction: (1) claim in a short tenant transaction and commit, (2) send
// with no transaction open, (3) save the results in a new short transaction.
@Injectable()
export class NotificationDeliveryService {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly devices: DevicesService,
    private readonly push: PushSender,
    private readonly tenants: TenantRunner,
    private readonly errors: ErrorEventLog,
    private readonly clock: Clock,
  ) {}

  async dispatchBusiness(businessId: string): Promise<DispatchResult> {
    const claimedAt = this.clock.now();
    const { claimed, targets } = await this.tenants.run(businessId, async () => {
      const rows = await this.repo.claimDuePush(claimedAt, new Date(claimedAt.getTime() + NOTIFY_LEASE_MS), NOTIFY_CLAIM_BATCH);
      return { claimed: rows, targets: await this.devices.pushTargetsOf(rows.map((r) => r.recipientMembershipId)) };
    });
    const result: DispatchResult = { claimed: claimed.length, sent: 0, retried: 0, dead: 0, more: claimed.length === NOTIFY_CLAIM_BATCH };
    if (claimed.length === 0) return result;

    // (2) No transaction is open here.
    const sends = await Promise.all(
      claimed.map(async (row) => {
        const devices = targets.filter((t) => t.membershipId === row.recipientMembershipId);
        const outcomes = await Promise.all(devices.map(async (d) => ({ device: d, outcome: await this.sendOne(d.token, row) })));
        return { row, outcomes };
      }),
    );

    // (3) The results, each only if the row is still in this claim.
    const savedAt = this.clock.now();
    await this.tenants.run(businessId, async () => {
      for (const { row, outcomes } of sends) {
        for (const o of outcomes) if (o.outcome === 'DEAD_TOKEN') await this.devices.clearPushToken(o.device.deviceId, o.device.token);
        const kind = this.decide(row, outcomes.map((o) => o.outcome));
        if (kind.status === 'SENT') {
          if (await this.repo.markSent(row.id, row.attempts, savedAt)) result.sent++;
        } else if (kind.status === 'RETRY') {
          const at = new Date(savedAt.getTime() + NOTIFY_RETRY_DELAYS_MS[Math.min(row.attempts, NOTIFY_RETRY_DELAYS_MS.length) - 1]);
          if (await this.repo.markRetry(row.id, row.attempts, at, kind.code)) result.retried++;
        } else if (await this.repo.markDead(row.id, row.attempts, kind.code)) {
          result.dead++;
          // A dead token or a member without one is not a failure of ours; giving up after every attempt is.
          if (kind.code === 'PUSH_FAILED') {
            await this.errors.record({ source: 'notifications.push', code: 'PUSH_FAILED', detail: `attempts ${row.attempts}`, businessId });
          }
        }
      }
    });
    return result;
  }

  /**
   * The sweeper for one business: takes back pushes whose lease ran out (one
   * error_event per push that used every attempt) and says whether a PENDING
   * push is due, so the caller can enqueue a dispatch.
   */
  async sweepBusiness(businessId: string): Promise<boolean> {
    const now = this.clock.now();
    return this.tenants.run(businessId, async () => {
      const { dead } = await this.repo.releaseExpiredLeases(now, NOTIFY_MAX_ATTEMPTS);
      for (const _id of dead) {
        await this.errors.record({ source: 'notifications.sweep', code: 'LEASE_EXPIRED', detail: `attempts ${NOTIFY_MAX_ATTEMPTS}`, businessId });
      }
      return this.repo.hasDuePush(now);
    });
  }

  private decide(row: ClaimedPush, outcomes: SendOutcome[]): { status: 'SENT' } | { status: 'RETRY' | 'DEAD'; code: string } {
    if (outcomes.includes('OK')) return { status: 'SENT' };
    if (outcomes.length === 0) return { status: 'DEAD', code: 'NO_PUSH_TOKEN' };
    if (outcomes.every((o) => o === 'DEAD_TOKEN')) return { status: 'DEAD', code: 'DEAD_TOKEN' };
    const code = outcomes.includes('TIMEOUT') ? 'PUSH_TIMEOUT' : outcomes.includes('THROWN') ? 'PUSH_ERROR' : outcomes.includes('FAILED') ? 'PUSH_FAILED_ONCE' : 'PUSH_RETRY';
    if (row.attempts >= NOTIFY_MAX_ATTEMPTS) return { status: 'DEAD', code: 'PUSH_FAILED' };
    return { status: 'RETRY', code };
  }

  /** One device; a throw or no answer within the timeout is a retry, never an open promise left behind. */
  private async sendOne(token: string, row: ClaimedPush): Promise<SendOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<SendOutcome>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), PUSH_SEND_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.push.send(token, { notificationId: row.id, type: row.type, data: row.data, message: notificationMessage(row.type, row.data) }).catch((): SendOutcome => 'THROWN'),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
