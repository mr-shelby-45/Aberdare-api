import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DevicesModule } from '../modules/devices/devices.module.js';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { StockModule } from '../modules/stock/stock.module.js';
import { SyncModule } from '../modules/sync/sync.module.js';
import { JobQueue } from './job-queue.service.js';
import { NotificationJobs } from './notification-jobs.service.js';
import { ScheduledJobs } from './scheduled-jobs.service.js';

// The job queue (Phase F1) and the worker's job handlers: notification
// delivery and the sweeper (F3), and the daily scheduled jobs (F5).
@Module({
  imports: [DatabaseModule, NotificationsModule, SyncModule, StockModule, DevicesModule],
  providers: [JobQueue, NotificationJobs, ScheduledJobs],
  exports: [JobQueue, NotificationJobs, ScheduledJobs],
})
export class JobsModule {}
