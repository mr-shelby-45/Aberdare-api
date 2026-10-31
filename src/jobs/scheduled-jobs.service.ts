import { Injectable } from '@nestjs/common';
import type { FastifyBaseLogger } from 'fastify';
import { Clock } from '../common/time/clock.js';
import { BUSINESS_JOB_EXPIRE_SECONDS, ERROR_EVENT_RETENTION_DAYS, FANOUT_CONCURRENCY, NOTIFICATION_RETENTION_DAYS, STALE_DEVICE_DAYS } from '../config/app.config.js';
import { BusinessDirectory } from '../database/business-directory.js';
import { errorCodeForLog } from '../database/db-errors.js';
import { ErrorEventLog } from '../database/error-event-log.js';
import { RetentionMaintenance } from '../database/retention-maintenance.js';
import { TenantRunner } from '../database/tenant.js';
import { DevicesService } from '../modules/devices/devices.service.js';
import { NotificationEvents } from '../modules/notifications/notification-events.js';
import { StockIntegrityService } from '../modules/stock/stock-integrity.service.js';
import { ChangeFeedService } from '../modules/sync/change-feed.service.js';
import type { JobQueue } from './job-queue.service.js';

const DAY_MS = 86_400_000;
const BUSINESS_PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The daily jobs and their schedules (UTC; Nairobi is UTC+3, no daylight saving).
export const SCHEDULES = {
  'changelog.prune': '0 0 * * *', // 03:00 Nairobi
  'stock.integrity': '30 0 * * *', // 03:30 Nairobi
  'notifications.purge': '0 1 * * *', // 04:00 Nairobi
  'errors.purge': '10 1 * * *', // 04:10 Nairobi
  'devices.stale': '0 4 * * *', // 07:00 Nairobi
} as const;
/** The per-business jobs of the two fan-outs. */
export const INTEGRITY_BUSINESS_QUEUE = 'stock.integrity.business';
export const STALE_BUSINESS_QUEUE = 'devices.stale.business';
const DETAIL_MAX = 200;

// The scheduled jobs of Phase F5 (docs/phase-f-design.md section 7). Each
// job's work is a plain method that tests call directly, with the injected
// Clock. Every business job runs in that business's own short tenant
// transaction; a failure in one writes an error_event and never stops the
// others. Schedules are rows in pg-boss's schedule table (one per name), so
// they are registered once however many workers run.
@Injectable()
export class ScheduledJobs {
  private queue: JobQueue | null = null;

  constructor(
    private readonly tenants: TenantRunner,
    private readonly directory: BusinessDirectory,
    private readonly errors: ErrorEventLog,
    private readonly retention: RetentionMaintenance,
    private readonly changeFeed: ChangeFeedService,
    private readonly integrity: StockIntegrityService,
    private readonly devices: DevicesService,
    private readonly events: NotificationEvents,
    private readonly clock: Clock,
  ) {}

  async register(queue: JobQueue, log: FastifyBaseLogger, options: { schedules?: boolean } = {}): Promise<void> {
    this.queue = queue;
    for (const name of Object.keys(SCHEDULES)) await queue.ensureQueue(name);
    // At most one waiting job per business; a stuck business job expires instead of holding its slot.
    for (const name of [INTEGRITY_BUSINESS_QUEUE, STALE_BUSINESS_QUEUE]) await queue.ensureQueue(name, { policy: 'stately', expireInSeconds: BUSINESS_JOB_EXPIRE_SECONDS });

    await queue.work<object>('changelog.prune', async () => {
      log.info({ job: 'changelog.prune', removed: await this.pruneChangeLog() }, 'change log pruned');
    });
    await queue.work<object>('notifications.purge', async () => {
      log.info({ job: 'notifications.purge', removed: await this.purgeNotifications() }, 'notifications purged');
    });
    await queue.work<object>('errors.purge', async () => {
      log.info({ job: 'errors.purge', removed: await this.purgeErrorEvents() }, 'error events purged');
    });
    await queue.work<object>('stock.integrity', async () => {
      log.info({ job: 'stock.integrity', businesses: await this.fanOut(INTEGRITY_BUSINESS_QUEUE) }, 'integrity checks enqueued');
    });
    await queue.work<object>('devices.stale', async () => {
      log.info({ job: 'devices.stale', businesses: await this.fanOut(STALE_BUSINESS_QUEUE) }, 'stale-device checks enqueued');
    });
    await queue.work<{ businessId?: unknown }>(
      INTEGRITY_BUSINESS_QUEUE,
      async (data) => {
        if (typeof data.businessId !== 'string' || !UUID.test(data.businessId)) return;
        log.info({ job: INTEGRITY_BUSINESS_QUEUE, businessId: data.businessId, mismatches: await this.checkIntegrity(data.businessId) }, 'integrity checked');
      },
      { localConcurrency: FANOUT_CONCURRENCY },
    );
    await queue.work<{ businessId?: unknown }>(
      STALE_BUSINESS_QUEUE,
      async (data) => {
        if (typeof data.businessId !== 'string' || !UUID.test(data.businessId)) return;
        log.info({ job: STALE_BUSINESS_QUEUE, businessId: data.businessId, stale: await this.staleDevices(data.businessId) }, 'stale devices checked');
      },
      { localConcurrency: FANOUT_CONCURRENCY },
    );
    if (options.schedules !== false) {
      for (const [name, cron] of Object.entries(SCHEDULES)) await queue.schedule(name, cron);
    }
  }

  /** changelog.prune: the Phase D prune (retention by the Clock). */
  async pruneChangeLog(): Promise<string> {
    return this.changeFeed.prune();
  }

  async purgeNotifications(): Promise<string> {
    return this.retention.purgeNotifications(new Date(this.clock.now().getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS));
  }

  async purgeErrorEvents(): Promise<string> {
    return this.retention.purgeErrorEvents(new Date(this.clock.now().getTime() - ERROR_EVENT_RETENTION_DAYS * DAY_MS));
  }

  /** A fan-out: one job per business (paged through list_business_ids). Returns how many were enqueued. */
  async fanOut(queueName: string): Promise<number> {
    let after: string | null = null;
    let sent = 0;
    for (;;) {
      const ids = await this.directory.listIds(after, BUSINESS_PAGE);
      for (const businessId of ids) {
        if ((await this.queue!.send(queueName, { businessId }, { singletonKey: businessId })) !== null) sent++;
      }
      if (ids.length < BUSINESS_PAGE) return sent;
      after = ids[ids.length - 1];
    }
  }

  /**
   * stock.integrity for one business: a mismatch writes one error_event
   * listing the number of pools and, as short ids, as many pools as fit in
   * 200 characters (decided in F5). No notification. Returns the mismatches.
   */
  async checkIntegrity(businessId: string): Promise<number> {
    try {
      const mismatches = await this.tenants.run(businessId, () => this.integrity.check());
      if (mismatches.length > 0) {
        let detail = `pools=${mismatches.length}`;
        for (const m of mismatches) {
          const next = `${detail}${detail.includes(' ') ? ',' : ' '}${m.locationId.slice(0, 8)}:${m.packTypeId.slice(0, 8)}`;
          if (next.length > DETAIL_MAX) break;
          detail = next;
        }
        await this.errors.record({ source: 'stock.integrity', code: 'INTEGRITY_MISMATCH', detail, businessId });
      }
      return mismatches.length;
    } catch (err) {
      await this.errors.record({ source: 'stock.integrity', code: errorCodeForLog(err) ?? (err instanceof Error ? err.name : 'Error'), businessId });
      return 0;
    }
  }

  /** devices.stale for one business: owners told of each active device without a sync for 3 days. Returns the count. */
  async staleDevices(businessId: string): Promise<number> {
    try {
      return await this.tenants.run(businessId, async () => {
        const now = this.clock.now();
        const stale = await this.devices.staleDevices(new Date(now.getTime() - STALE_DEVICE_DAYS * DAY_MS));
        for (const d of stale) {
          const since = (d.lastSyncAt ?? d.createdAt).getTime();
          await this.events.deviceStale({ deviceId: d.deviceId, membershipId: d.membershipId, lastSyncAt: d.lastSyncAt, days: Math.floor((now.getTime() - since) / DAY_MS) });
        }
        return stale.length;
      });
    } catch (err) {
      await this.errors.record({ source: 'devices.stale', code: errorCodeForLog(err) ?? (err instanceof Error ? err.name : 'Error'), businessId });
      return 0;
    }
  }
}
