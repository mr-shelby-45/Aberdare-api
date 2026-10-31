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
    return count;
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
