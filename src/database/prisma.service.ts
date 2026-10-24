import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

// The raw client, connected as app_user (DATABASE_URL). Only TenantRunner
// (src/database/tenant.ts) may use it. DatabaseModule does not export it and
// a lint rule blocks importing it elsewhere in src/ (CLAUDE.md section 5).
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    // Pool size. Defaults to 10 (the node-postgres default).
    const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('DATABASE_POOL_MAX must be a positive integer');
    }
    super({ adapter: new PrismaPg({ connectionString, max }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
