import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { JobsModule } from './jobs/jobs.module.js';

// The worker's root module (Phase F1): the job queue, and the database as
// app_user through TenantRunner for business work. No HTTP.
@Module({
  imports: [DatabaseModule, JobsModule],
})
export class WorkerModule {}
