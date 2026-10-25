import { Module } from '@nestjs/common';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';

@Module({
  providers: [StaffService, StaffRepository],
  exports: [StaffService],
})
export class StaffModule {}
