import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export type BusinessType = 'RETAIL' | 'WHOLESALE' | 'WAREHOUSE';

@Injectable()
export class BusinessRepository {
  /**
   * Inserts the current tenant's own business row. app_user may insert only
   * id, name and type, so this is plain SQL rather than a Prisma create (which
   * would also send updated_at).
   */
  /** The current tenant's business (RLS shows only that one row). */
  async findCurrent(): Promise<{ id: string; name: string; type: BusinessType } | null> {
    return currentTx().business.findUnique({
      where: { id: currentBusinessId() },
      select: { id: true, name: true, type: true },
    });
  }

  async create(name: string, type: BusinessType): Promise<void> {
    await currentTx().$executeRaw`
      INSERT INTO business (id, name, type)
      VALUES (${currentBusinessId()}::uuid, ${name}, ${type}::business_type)`;
  }
}
