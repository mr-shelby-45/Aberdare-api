import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  archivedAt: Date | null;
}

// product SQL. It has no Prisma dependency to inject: every call asks the
// tenant context for its client, and fails if there is none, so RLS limits it
// to the caller's business. app_user has no DELETE on product (Phase B1).
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

  /** product.create: the id comes from the phone. A taken id or SKU is a unique violation. */
  async insert(product: { id: string; name: string; sku: string | null }): Promise<void> {
    await currentTx().product.create({
      data: { businessId: currentBusinessId(), ...product },
      select: { id: true },
    });
  }

  /**
   * The product, locked until the end of the transaction. Every change to a
   * product or its pack types takes this lock first, so two commands on one
   * product run one after the other (pack limits, last active pack).
   */
  async lock(id: string): Promise<ProductRow | null> {
    const rows = await currentTx().$queryRaw<{ id: string; name: string; sku: string | null; archived_at: Date | null }[]>`
      SELECT id, name, sku, archived_at FROM product
       WHERE id = ${id}::uuid AND business_id = ${currentBusinessId()}::uuid
         FOR UPDATE`;
    const r = rows[0];
    return r ? { id: r.id, name: r.name, sku: r.sku, archivedAt: r.archived_at } : null;
  }

  async update(id: string, fields: { name?: string; sku?: string | null; archivedAt?: Date | null }): Promise<void> {
    await currentTx().product.update({ where: { id }, data: fields, select: { id: true } });
  }
}
