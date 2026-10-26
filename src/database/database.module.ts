import { Module } from '@nestjs/common';
import { ChangeLogMaintenance } from './change-log-maintenance.js';
import { IdentityLookup } from './identity-lookup.js';
import { PrismaService } from './prisma.service.js';
import { TenantRunner } from './tenant.js';

// PrismaService is provided here but NOT exported. A class in any other module
// that asks for PrismaService makes Nest fail at startup with
// "can't resolve dependencies". Other modules only get TenantRunner,
// IdentityLookup (the non-tenant access path for login lookups) and
// ChangeLogMaintenance (the non-tenant change_log prune, Phase D1).
@Module({
  providers: [PrismaService, TenantRunner, IdentityLookup, ChangeLogMaintenance],
  exports: [TenantRunner, IdentityLookup, ChangeLogMaintenance],
})
export class DatabaseModule {}
