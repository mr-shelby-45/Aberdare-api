import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { DeviceAdminService } from './device-admin.service.js';
import { DevicesController } from './devices.controller.js';
import { StaffController } from './staff.controller.js';
import { StaffLifecycleService } from './staff-lifecycle.service.js';

// The staff and device endpoints. They sit above the staff, devices and
// sessions data modules, because staff changes touch devices and tokens, and
// device changes check memberships (keeping staff and devices free of each
// other avoids a circular import).
@Module({
  imports: [DatabaseModule, AuditModule, StaffModule, DevicesModule, SessionsModule],
  controllers: [StaffController, DevicesController],
  providers: [StaffLifecycleService, DeviceAdminService],
})
export class TeamModule {}
