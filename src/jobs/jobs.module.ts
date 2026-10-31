import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { JobQueue } from './job-queue.service.js';
import { NotificationJobs } from './notification-jobs.service.js';

// The job queue (Phase F1) and the worker's job handlers: notification
// delivery and the sweeper (F3). Scheduled jobs come in F5.
@Module({
  imports: [DatabaseModule, NotificationsModule],
  providers: [JobQueue, NotificationJobs],
  exports: [JobQueue, NotificationJobs],
})
export class JobsModule {}
