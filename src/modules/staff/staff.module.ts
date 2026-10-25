import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';

@Module({
  imports: [AuditModule],
  providers: [StaffService, StaffRepository],
  exports: [StaffService],
})
export class StaffModule {}
