import { Module } from '@nestjs/common';
import { SignedCursor } from '../../common/paging/signed-cursor.js';
import { AuditModule } from '../audit/audit.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { CsvWriter } from './csv-writer.js';
import { ReportRateLimitGuard } from './report-rate-limit.guard.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

// Reports (Phase G1). Reads only, apart from the audit row each CSV export
// writes through AuditService. Its repository is the approved read-only
// exception to the module rule (CLAUDE.md section 4); display names come from
// the staff module. Nothing imports this module.
@Module({
  imports: [StaffModule, AuditModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository, ReportRateLimitGuard, SignedCursor, CsvWriter],
})
export class ReportsModule {}
