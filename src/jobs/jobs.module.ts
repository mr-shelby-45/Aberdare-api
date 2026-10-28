import { Module } from '@nestjs/common';
import { JobQueue } from './job-queue.service.js';

// The job queue (Phase F1). Job handlers come in later steps (F3, F5).
@Module({
  providers: [JobQueue],
  exports: [JobQueue],
})
export class JobsModule {}
