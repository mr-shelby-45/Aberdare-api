import { Module } from '@nestjs/common';
import { BusinessDirectory } from './business-directory.js';
import { ChangeLogMaintenance } from './change-log-maintenance.js';
import { ErrorEventLog } from './error-event-log.js';
import { IdentityLookup } from './identity-lookup.js';
import { NotificationDueListener } from './notification-due-listener.js';
import { PrismaService } from './prisma.service.js';
import { TenantRunner } from './tenant.js';

// PrismaService is provided here but NOT exported. A class in any other module
// that asks for PrismaService makes Nest fail at startup with
// "can't resolve dependencies". Other modules only get TenantRunner,
// IdentityLookup (the non-tenant access path for login lookups) and
// ChangeLogMaintenance (the non-tenant change_log prune, Phase D1) and
// ErrorEventLog (the support-only error_event writer, Phase F2), and for the
// worker BusinessDirectory and NotificationDueListener (Phase F3).
@Module({
  providers: [PrismaService, TenantRunner, IdentityLookup, ChangeLogMaintenance, ErrorEventLog, BusinessDirectory, NotificationDueListener],
  exports: [TenantRunner, IdentityLookup, ChangeLogMaintenance, ErrorEventLog, BusinessDirectory, NotificationDueListener],
})
export class DatabaseModule {}
