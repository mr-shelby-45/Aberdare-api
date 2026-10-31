import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { type CursorValues, SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import { Clock } from '../../common/time/clock.js';
import { errorCodeForLog } from '../../database/db-errors.js';
import { ErrorEventLog } from '../../database/error-event-log.js';
import { currentBusinessId, withSavepoint } from '../../database/tenant.js';
import { StaffService } from '../staff/staff.service.js';
import { notificationMessage } from './notification-messages.js';
import { type Channel, NOTIFY_CHANNELS, type NotificationData, checkNotification } from './notification-types.js';
import { type NotificationInsert, NotificationsRepository } from './notifications.repository.js';
import type { ListNotificationsQueryDto } from './dto/list-notifications.dto.js';
import type { MarkReadDto } from './dto/mark-read.dto.js';

/** The event a notification is about. dedupeKey identifies it (for example "sale.flagged:<sale id>"). */
export interface NotificationEvent {
  type: string;
  dedupeKey: string;
  data: NotificationData;
}

/** Who gets which channels: the active owners, or these members (if active). */
export interface NotificationTarget {
  to: 'OWNERS' | readonly string[];
  channels: readonly Channel[];
}

const LIST_CURSOR = 'notifications';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Notifications (Phase F2, docs/phase-f-design.md section 5). A data module:
// it owns the notification table and imports only staff (recipients) and the
// database layer. Commands call notify() in their own transaction (F4).
@Injectable()
export class NotificationsService {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly staff: StaffService,
    private readonly errors: ErrorEventLog,
    private readonly clock: Clock,
    private readonly cursor: SignedCursor,
  ) {}

  /**
   * Writes one row per recipient and channel in the CALLER'S transaction, so a
   * rolled-back event notifies nobody and the same event twice makes one row.
   * Recipients are live: active members only, never anyone in exclude.
   *
   * Never fails the caller: the work runs in a savepoint (paid only when an
   * event fires), and any error (also a programming error in the type or
   * data) is rolled back to it and recorded as one error_event in the same
   * transaction. Returns how many rows were new (0 after a failure).
   */
  async notify(event: NotificationEvent, targets: readonly NotificationTarget[], options: { exclude?: readonly string[] } = {}): Promise<number> {
    const businessId = currentBusinessId(); // outside a tenant transaction: a programming error, thrown
    try {
      return await withSavepoint(async () => {
        checkNotification(event.type, event.dedupeKey, event.data);
        for (const t of targets) for (const c of t.channels) if (!NOTIFY_CHANNELS.includes(c)) throw new Error('notification channel not built yet: ' + c);
        const type = event.type;
        const active = await this.staff.listActive();
        const exclude = new Set(options.exclude ?? []);
        const owners = active.filter((m) => m.rolePreset === 'OWNER').map((m) => m.id);
        const activeIds = new Set(active.map((m) => m.id));
        const rows = new Map<string, NotificationInsert>();
        for (const target of targets) {
          const members = target.to === 'OWNERS' ? owners : target.to.filter((id) => activeIds.has(id));
          for (const member of members) {
            if (exclude.has(member)) continue;
            for (const channel of target.channels) {
              rows.set(`${member}|${channel}`, { type, recipientMembershipId: member, channel, data: event.data, dedupeKey: event.dedupeKey });
            }
          }
        }
        return this.repo.insertMany([...rows.values()], this.clock.now());
      });
    } catch (err) {
      await this.errors.record({
        source: 'notifications',
        code: errorCodeForLog(err) ?? (err instanceof Error ? err.name : 'Error'),
        detail: `notify ${String(event.type).slice(0, 40)}`,
        businessId,
      });
      return 0;
    }
  }

  /** GET /v1/notifications: the member's IN_APP rows, newest first, signed cursor bound to the unread filter. */
  async list(membershipId: string, query: ListNotificationsQueryDto) {
    const unreadOnly = query.unread === 'true';
    const filters: CursorValues = { unread: unreadOnly };
    const limit = pageLimit(query.limit);
    let after: { createdAt: Date; id: string } | null = null;
    if (query.cursor !== undefined) {
      const v = this.cursor.read(LIST_CURSOR, query.cursor);
      const id = cursorUuid(v?.after_id);
      const at = typeof v?.after_created_at === 'string' ? new Date(v.after_created_at) : null;
      if (!v || !id || !at || Number.isNaN(at.getTime()) || v.unread !== unreadOnly) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'The cursor is not valid.');
      }
      after = { createdAt: at, id };
    }
    const rows = await this.repo.listFor(membershipId, { unreadOnly, after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      notifications: page.map((r) => ({ ...r, message: notificationMessage(r.type, r.data) })),
      nextCursor: rows.length > limit && last ? this.cursor.sign(LIST_CURSOR, { ...filters, after_created_at: last.createdAt.toISOString(), after_id: last.id }) : null,
    };
  }

  async unreadCount(membershipId: string): Promise<number> {
    return this.repo.unreadCountFor(membershipId);
  }

  /** POST /v1/notifications/read: ids or all, exactly one. Other members' and unknown ids are ignored silently. */
  async markRead(membershipId: string, dto: MarkReadDto): Promise<void> {
    const hasIds = dto.ids !== undefined;
    const hasAll = dto.all !== undefined;
    if (hasIds === hasAll) throw new ApiError(422, 'VALIDATION_FAILED', 'Send either ids or all.');
    await this.repo.markReadFor(membershipId, hasIds ? [...new Set(dto.ids)] : null, this.clock.now());
  }
}

function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new ApiError(422, 'VALIDATION_FAILED', `limit must be 1 to ${MAX_LIMIT}.`);
  return n;
}
