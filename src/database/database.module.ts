import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { TenantRunner } from './tenant.js';

// PrismaService is provided here but NOT exported. A class in any other module
// that asks for PrismaService makes Nest fail at startup with
// "can't resolve dependencies". Other modules only get TenantRunner.
@Module({
  providers: [PrismaService, TenantRunner],
  exports: [TenantRunner],
})
export class DatabaseModule {}
