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
  async create(name: string, type: BusinessType): Promise<void> {
    await currentTx().$executeRaw`
      INSERT INTO business (id, name, type)
      VALUES (${currentBusinessId()}::uuid, ${name}, ${type}::business_type)`;
  }
}
