import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';
import type { Channel, NotificationData, NotificationType } from './notification-types.js';

export interface NotificationInsert {
  type: NotificationType;
  recipientMembershipId: string;
  channel: Channel;
  data: NotificationData;
  dedupeKey: string;
}

/** A push claimed for sending (Phase F3); attempts already counts this attempt. */
export interface ClaimedPush {
  id: string;
  recipientMembershipId: string;
  type: string;
  data: NotificationData;
  attempts: number;
}

export interface NotificationReadRow {
  id: string;
  type: string;
  data: NotificationData;
  createdAt: Date;
  readAt: Date | null;
}

// notification SQL (Phase F2), on the current tenant transaction. app_user may
// insert, read, and update only the delivery and read columns; never delete.
@Injectable()
export class NotificationsRepository {
  /**
   * One INSERT ... ON CONFLICT DO NOTHING for all rows (createMany with
   * skipDuplicates): a row whose (business, recipient, channel, dedupe key)
   * exists is skipped, also when a concurrent transaction holds it (the insert
   * waits for it, then skips). IN_APP rows are SENT at once; the others are
   * PENDING and due now. Returns how many rows were new.
   */
  async insertMany(rows: NotificationInsert[], now: Date): Promise<number> {
    if (rows.length === 0) return 0;
    const businessId = currentBusinessId();
    const { count } = await currentTx().notification.createMany({
      data: rows.map((r) => ({
        businessId,
        type: r.type,
        recipientMembershipId: r.recipientMembershipId,
        channel: r.channel,
        data: r.data,
        dedupeKey: r.dedupeKey,
        status: r.channel === 'IN_APP' ? 'SENT' : 'PENDING',
        sentAt: r.channel === 'IN_APP' ? now : null,
        nextAttemptAt: r.channel === 'IN_APP' ? null : now,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
    // Phase F3: wake the worker. pg_notify in this transaction is delivered
    // only if it commits, so a rolled-back event wakes nobody.
    if (rows.some((r) => r.channel !== 'IN_APP')) {
      await currentTx().$executeRaw`SELECT pg_notify('notification_due', ${businessId})`;
    }
    return count;
  }

  /**
   * Phase F3, the atomic claim: due PENDING pushes become SENDING with one
   * more attempt and a lease (next_attempt_at = leaseUntil) in ONE statement.
   * SKIP LOCKED hides rows another worker is claiming, and the outer
   * status = 'PENDING' is checked again on the locked row, so two workers
   * can never claim the same notification. Commit before sending.
   */
  async claimDuePush(now: Date, leaseUntil: Date, limit: number): Promise<ClaimedPush[]> {
    const rows = await currentTx().$queryRaw<{ id: string; recipient_membership_id: string; type: string; data: NotificationData; attempts: number }[]>`
      UPDATE notification n
         SET status = 'SENDING', attempts = n.attempts + 1, next_attempt_at = ${leaseUntil}
       WHERE n.business_id = ${currentBusinessId()}::uuid AND n.status = 'PENDING'
         AND n.id IN (SELECT d.id FROM notification d
                       WHERE d.status = 'PENDING' AND d.channel = 'PUSH' AND d.next_attempt_at <= ${now}
                       ORDER BY d.next_attempt_at, d.id
                       LIMIT ${limit}
                       FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.recipient_membership_id, n.type, n.data, n.attempts`;
    return rows.map((r) => ({ id: r.id, recipientMembershipId: r.recipient_membership_id, type: r.type, data: r.data, attempts: r.attempts }));
  }

  // The results of one send. Each changes the row only if it is still in the
  // claim this attempt made (SENDING with these attempts): a row the sweeper
  // took back meanwhile is left alone. Return whether the row changed.

  async markSent(id: string, attempts: number, now: Date): Promise<boolean> {
    const { count } = await currentTx().notification.updateMany({
      where: { id, status: 'SENDING', attempts },
      data: { status: 'SENT', sentAt: now, nextAttemptAt: null, lastError: null },
    });
    return count === 1;
  }

  async markRetry(id: string, attempts: number, at: Date, lastError: string): Promise<boolean> {
    const { count } = await currentTx().notification.updateMany({ where: { id, status: 'SENDING', attempts }, data: { status: 'PENDING', nextAttemptAt: at, lastError } });
    return count === 1;
  }

  async markDead(id: string, attempts: number, lastError: string): Promise<boolean> {
    const { count } = await currentTx().notification.updateMany({ where: { id, status: 'SENDING', attempts }, data: { status: 'DEAD', nextAttemptAt: null, lastError } });
    return count === 1;
  }

  /**
   * Phase F3, the sweeper: SENDING rows whose lease ran out (the worker died
   * or hung) go back to PENDING, due at once; those that used every attempt
   * become DEAD instead. Returns the ids made DEAD.
   */
  async releaseExpiredLeases(now: Date, maxAttempts: number): Promise<{ released: number; dead: string[] }> {
    const dead = await currentTx().$queryRaw<{ id: string }[]>`
      UPDATE notification SET status = 'DEAD', next_attempt_at = NULL, last_error = 'LEASE_EXPIRED'
       WHERE business_id = ${currentBusinessId()}::uuid AND status = 'SENDING' AND next_attempt_at <= ${now} AND attempts >= ${maxAttempts}
      RETURNING id`;
    const released = await currentTx().notification.updateMany({
      where: { status: 'SENDING', nextAttemptAt: { lte: now }, attempts: { lt: maxAttempts } },
      data: { status: 'PENDING' },
    });
    return { released: released.count, dead: dead.map((r) => r.id) };
  }

  /** Phase F3: whether a PENDING push is due (the sweeper enqueues a dispatch then). */
  async hasDuePush(now: Date): Promise<boolean> {
    return (await currentTx().notification.count({ where: { status: 'PENDING', channel: 'PUSH', nextAttemptAt: { lte: now } }, take: 1 })) > 0;
  }

  /** The member's IN_APP notifications, newest first by (created_at, id), after the cursor position. */
  async listFor(membershipId: string, f: { unreadOnly: boolean; after: { createdAt: Date; id: string } | null; limit: number }): Promise<NotificationReadRow[]> {
    const rows = await currentTx().notification.findMany({
      where: {
        recipientMembershipId: membershipId,
        channel: 'IN_APP',
        ...(f.unreadOnly ? { readAt: null } : {}),
        ...(f.after ? { OR: [{ createdAt: { lt: f.after.createdAt } }, { createdAt: f.after.createdAt, id: { lt: f.after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: { id: true, type: true, data: true, createdAt: true, readAt: true },
    });
    return rows.map((r) => ({ ...r, data: r.data as NotificationData }));
  }

  async unreadCountFor(membershipId: string): Promise<number> {
    return currentTx().notification.count({ where: { recipientMembershipId: membershipId, channel: 'IN_APP', readAt: null } });
  }

  /** Marks the member's unread IN_APP notifications read: these ids, or all when ids is null. Other ids match nothing. */
  async markReadFor(membershipId: string, ids: string[] | null, now: Date): Promise<void> {
    await currentTx().notification.updateMany({
      where: { recipientMembershipId: membershipId, channel: 'IN_APP', readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: now },
    });
  }
}
