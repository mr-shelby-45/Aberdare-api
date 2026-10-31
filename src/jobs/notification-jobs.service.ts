import { Injectable } from '@nestjs/common';
import type { FastifyBaseLogger } from 'fastify';
import { AppConfig } from '../config/app.config.js';
import { BusinessDirectory } from '../database/business-directory.js';
import { errorCodeForLog } from '../database/db-errors.js';
import { ErrorEventLog } from '../database/error-event-log.js';
import { NotificationDueListener } from '../database/notification-due-listener.js';
import { NotificationDeliveryService } from '../modules/notifications/notification-delivery.service.js';
import type { JobQueue } from './job-queue.service.js';

export const DISPATCH_QUEUE = 'notifications.dispatch';
export const SWEEP_QUEUE = 'notifications.sweep';
// Every minute (UTC; the same minute in Nairobi, UTC+3).
export const SWEEP_CRON = '* * * * *';
const BUSINESS_PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotificationJobsOptions {
  // Register the every-minute sweep schedule (tests that drive the sweeper by hand turn it off).
  schedules?: boolean;
  // LISTEN for notification_due wake-ups.
  listen?: boolean;
}

// The worker's notification jobs (Phase F3, docs/phase-f-design.md section 5):
// - notifications.dispatch {businessId}: delivers that business's due pushes.
//   The queue is stately with the business id as singletonKey, so at most one
//   dispatch per business waits while one runs: a busy minute never piles up.
// - notifications.sweep, every minute: for every business (list_business_ids,
//   paged), takes back expired leases and enqueues a dispatch when pushes are
//   due. One failing business writes an error_event and never stops the rest.
// - the wake-up: a notification_due signal enqueues that business's dispatch.
@Injectable()
export class NotificationJobs {
  private queue: JobQueue | null = null;
  private log: FastifyBaseLogger | null = null;

  constructor(
    private readonly delivery: NotificationDeliveryService,
    private readonly directory: BusinessDirectory,
    private readonly listener: NotificationDueListener,
    private readonly errors: ErrorEventLog,
    private readonly config: AppConfig,
  ) {}

  async register(queue: JobQueue, log: FastifyBaseLogger, options: NotificationJobsOptions = {}): Promise<void> {
    this.queue = queue;
    this.log = log;
    await queue.ensureQueue(DISPATCH_QUEUE, { policy: 'stately' });
    await queue.ensureQueue(SWEEP_QUEUE);
    await queue.work<{ businessId?: unknown }>(DISPATCH_QUEUE, async (data) => {
      if (typeof data.businessId !== 'string' || !UUID.test(data.businessId)) return; // never trust a job's data
      const r = await this.delivery.dispatchBusiness(data.businessId);
      log.info({ job: DISPATCH_QUEUE, businessId: data.businessId, claimed: r.claimed, sent: r.sent, retried: r.retried, dead: r.dead }, 'pushes dispatched');
      if (r.more) await this.enqueueDispatch(data.businessId);
    });
    await queue.work<object>(SWEEP_QUEUE, async () => {
      await this.sweepAll();
    });
    if (options.schedules !== false) await queue.schedule(SWEEP_QUEUE, SWEEP_CRON);
    if (options.listen !== false) {
      await this.listener.start(
        this.config.queueDatabaseUrl!,
        (businessId) => void this.enqueueDispatch(businessId),
        (err) => log.error({ errorName: err instanceof Error ? err.name : 'Error', errorCode: errorCodeForLog(err) }, 'wake-up listener error'),
      );
    }
  }

  async stop(): Promise<void> {
    await this.listener.stop();
  }

  /** Enqueues one dispatch for the business (refused, harmlessly, when one is already waiting). */
  async enqueueDispatch(businessId: string): Promise<void> {
    try {
      await this.queue!.send(DISPATCH_QUEUE, { businessId }, { singletonKey: businessId });
    } catch (err) {
      this.log?.error({ job: DISPATCH_QUEUE, businessId, errorName: err instanceof Error ? err.name : 'Error', errorCode: errorCodeForLog(err) }, 'dispatch not enqueued');
    }
  }

  /** The sweep, also callable on demand (tests). Returns how many businesses had pushes due. */
  async sweepAll(): Promise<number> {
    let after: string | null = null;
    let due = 0;
    for (;;) {
      const ids = await this.directory.listIds(after, BUSINESS_PAGE);
      for (const businessId of ids) {
        try {
          if (await this.delivery.sweepBusiness(businessId)) {
            due++;
            await this.enqueueDispatch(businessId);
          }
        } catch (err) {
          await this.errors.record({ source: SWEEP_QUEUE, code: errorCodeForLog(err) ?? (err instanceof Error ? err.name : 'Error'), businessId });
        }
      }
      if (ids.length < BUSINESS_PAGE) return due;
      after = ids[ids.length - 1];
    }
  }
}
