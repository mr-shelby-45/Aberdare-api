import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsRepository } from './approvals.repository.js';
import { ApprovalsService } from './approvals.service.js';

// Approvals (Phase C5). Imports only data modules (staff, audit); the stock
// commands import this one to use an approval.
@Module({
  imports: [DatabaseModule, StaffModule, AuditModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalsRepository],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
