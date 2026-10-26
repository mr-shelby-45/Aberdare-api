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

  /** For reads: no lock. Rows not visible to this tenant are simply missing. */
  async findManyByIds(ids: string[]): Promise<ProductRow[]> {
    if (ids.length === 0) return [];
    return currentTx().product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, sku: true, archivedAt: true },
    });
  }

  /**
   * One listing page in (name, id) order, after the given position. Two
   * statements rather than one with "cursor IS NULL OR ...", so the row
   * comparison stays an index condition on (business_id, name, id).
   */
  async page(options: { includeArchived: boolean; after: { name: string; id: string } | null; limit: number }) {
    const { includeArchived, after, limit } = options;
    const tx = currentTx();
    const rows = after
      ? await tx.$queryRaw<{ id: string; name: string }[]>`
          SELECT id, name FROM product
           WHERE business_id = ${currentBusinessId()}::uuid
             AND (${includeArchived}::boolean OR archived_at IS NULL)
             AND (name, id) > (${after.name}::text, ${after.id}::uuid)
           ORDER BY name, id
           LIMIT ${limit}::int`
      : await tx.$queryRaw<{ id: string; name: string }[]>`
          SELECT id, name FROM product
           WHERE business_id = ${currentBusinessId()}::uuid
             AND (${includeArchived}::boolean OR archived_at IS NULL)
           ORDER BY name, id
           LIMIT ${limit}::int`;
    return rows;
  }

  /**
   * Search (docs/phase-b-design.md section 6): exact barcode, then exact SKU,
   * then names starting with the text, then names containing it; by name
   * within each group. Every value is a parameter; the LIKE patterns arrive
   * already escaped. RLS applies to both tables. Under RLS no index helps the
   * name match (LIKE and ILIKE are not leakproof), so it filters this
   * business's rows; it uses the stored name_lower column (B4, option B)
   * rather than name ILIKE, which lowercased every name on every search
   * (shadow database, 20,000 products: 18 ms instead of 108 ms median). The
   * text is lowercased by the same lower() as the column, so both sides fold
   * alike; lower() leaves the escapes (\ % _) untouched.
   */
  async search(options: {
    text: string;
    barcode: string | null;
    contains: string;
    prefix: string;
    includeArchived: boolean;
    limit: number;
  }): Promise<string[]> {
    const { text, barcode, contains, prefix, includeArchived, limit } = options;
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      WITH matches AS (
        SELECT b.product_id AS id, 0 AS rank
          FROM product_barcode b
         WHERE b.barcode = ${barcode}::text
        UNION ALL
        SELECT p.id, 1 FROM product p WHERE p.sku = ${text}::text
        UNION ALL
        SELECT p.id, CASE WHEN p.name_lower LIKE lower(${prefix}::text) ESCAPE '\\' THEN 2 ELSE 3 END
          FROM product p
         WHERE p.name_lower LIKE lower(${contains}::text) ESCAPE '\\'
      )
      SELECT p.id
        FROM (SELECT id, min(rank) AS rank FROM matches GROUP BY id) m
        JOIN product p ON p.id = m.id
       WHERE (${includeArchived}::boolean OR p.archived_at IS NULL)
       ORDER BY m.rank, p.name, p.id
       LIMIT ${limit}::int`;
    return rows.map((r) => r.id);
  }

  async update(id: string, fields: { name?: string; sku?: string | null; archivedAt?: Date | null }): Promise<void> {
    await currentTx().product.update({ where: { id }, data: fields, select: { id: true } });
  }

  /** Phase D2 snapshot: every product, archived too, keyset by id. */
  async pageForSync(afterId: string | null, limit: number): Promise<ProductRow[]> {
    return currentTx().product.findMany({
      where: afterId ? { id: { gt: afterId } } : {},
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, name: true, sku: true, archivedAt: true },
    });
  }

  /** Phase D3 changes: these products as they are now (missing ids are simply absent). */
  async byIdsForSync(ids: string[]): Promise<ProductRow[]> {
    if (ids.length === 0) return [];
    return currentTx().product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true, archivedAt: true } });
  }
}
