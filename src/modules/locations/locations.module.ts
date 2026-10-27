import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { LocationsController } from './locations.controller.js';
import { LocationsRepository } from './locations.repository.js';
import { LocationsService } from './locations.service.js';

// Exports the service so signup can create the default location.
@Module({
  imports: [AuditModule, StaffModule],
  controllers: [LocationsController],
  providers: [LocationsService, LocationsRepository],
  exports: [LocationsService],
})
export class LocationsModule {}
