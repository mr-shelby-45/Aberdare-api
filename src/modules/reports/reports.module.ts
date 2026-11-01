import { Module } from '@nestjs/common';
import { StaffModule } from '../staff/staff.module.js';
import { ReportRateLimitGuard } from './report-rate-limit.guard.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

// Reports (Phase G1). Reads only. Its repository is the approved read-only
// exception to the module rule (CLAUDE.md section 4); display names come from
// the staff module. Nothing imports this module.
@Module({
  imports: [StaffModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository, ReportRateLimitGuard],
})
export class ReportsModule {}
