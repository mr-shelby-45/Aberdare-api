import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

// Prices leave the repository as canonical strings ("180.00", read as
// numeric::text), never as numbers or Decimal objects.
export interface PackTypeRow {
  id: string;
  productId: string;
  name: string;
  unitsPerPack: number;
  sellPrice: string;
  costPrice: string | null;
  archivedAt: Date | null;
}

export interface PackTypeWrite {
  name: string;
  unitsPerPack: number;
  sellPrice: string;
  costPrice?: string | null;
  archivedAt?: Date | null;
}

// pack_type SQL, on the current tenant transaction. No DELETE (archive instead).
@Injectable()
export class PackTypesRepository {
  async insert(packType: PackTypeWrite & { id: string; productId: string }): Promise<void> {
    await currentTx().packType.create({
      data: { businessId: currentBusinessId(), ...packType },
      select: { id: true },
    });
  }

  /** The pack type, locked until the end of the transaction (see ProductsRepository.lock). */
  async lock(id: string): Promise<PackTypeRow | null> {
    const rows = await currentTx().$queryRaw<
      {
        id: string;
        product_id: string;
        name: string;
        units_per_pack: number;
        sell_price: string;
        cost_price: string | null;
        archived_at: Date | null;
      }[]
    >`
      SELECT id, product_id, name, units_per_pack, sell_price::text AS sell_price,
             cost_price::text AS cost_price, archived_at
        FROM pack_type
       WHERE id = ${id}::uuid AND business_id = ${currentBusinessId()}::uuid
         FOR UPDATE`;
    const r = rows[0];
    return r
      ? {
          id: r.id,
          productId: r.product_id,
          name: r.name,
          unitsPerPack: r.units_per_pack,
          sellPrice: r.sell_price,
          costPrice: r.cost_price,
          archivedAt: r.archived_at,
        }
      : null;
  }

  /** Active pack types of a product, optionally leaving one out. */
  async countActive(productId: string, exceptId?: string): Promise<number> {
    return currentTx().packType.count({
      where: { productId, archivedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    });
  }

  /** Every pack type of a product, archived ones too, smallest first. */
  async listForProduct(productId: string): Promise<PackTypeRow[]> {
    const rows = await currentTx().$queryRaw<
      {
        id: string;
        product_id: string;
        name: string;
        units_per_pack: number;
        sell_price: string;
        cost_price: string | null;
        archived_at: Date | null;
      }[]
    >`
      SELECT id, product_id, name, units_per_pack, sell_price::text AS sell_price,
             cost_price::text AS cost_price, archived_at
        FROM pack_type
       WHERE product_id = ${productId}::uuid AND business_id = ${currentBusinessId()}::uuid
       ORDER BY units_per_pack, id`;
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      name: r.name,
      unitsPerPack: r.units_per_pack,
      sellPrice: r.sell_price,
      costPrice: r.cost_price,
      archivedAt: r.archived_at,
    }));
  }

  async update(id: string, fields: Partial<PackTypeWrite>): Promise<void> {
    await currentTx().packType.update({ where: { id }, data: fields, select: { id: true } });
  }
}
