import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

// The worker's way to learn which businesses exist, before any tenant is
// known (Phase F3, docs/phase-f-design.md section 4): list_business_ids(),
// ids only, in id order. Each id is then processed in its own tenant
// transaction (TenantRunner); the worker never bypasses RLS.
@Injectable()
export class BusinessDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /** One page of business ids after the given id (null: from the start). */
  async listIds(after: string | null, limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM list_business_ids(${after}::uuid, ${limit}::integer)`;
    return rows.map((r) => r.id);
  }
}
