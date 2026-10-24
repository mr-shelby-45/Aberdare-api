import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

// Spike step 1 repository. It has no Prisma dependency to inject: every call
// asks the tenant context for its client, and fails if there is none.
@Injectable()
export class ProductsRepository {
  // Every method is async so a missing tenant context always surfaces as a
  // rejected promise, never as a synchronous throw some callers would miss.
  async list() {
    return currentTx().product.findMany({ orderBy: { name: 'asc' } });
  }

  // business_id comes from the tenant context, never from the caller
  // (CLAUDE.md rule 2).
  async create(name: string) {
    return currentTx().product.create({
      data: { businessId: currentBusinessId(), name },
    });
  }

  /** Returns the number of rows changed (0 if the row is not visible to this tenant). */
  async rename(id: string, name: string): Promise<number> {
    const { count } = await currentTx().product.updateMany({
      where: { id },
      data: { name },
    });
    return count;
  }

  /** Returns the number of rows deleted (0 if the row is not visible to this tenant). */
  async remove(id: string): Promise<number> {
    const { count } = await currentTx().product.deleteMany({ where: { id } });
    return count;
  }
}
