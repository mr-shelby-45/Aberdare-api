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

/** A pack type as a sale records it (Phase E2): names and prices at that moment. */
export interface PackTypeForSale {
  id: string;
  productId: string;
  productName: string;
  name: string;
  unitsPerPack: number;
  sellPrice: string;
  costPrice: string | null;
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

  /** Every pack type of these products, archived ones too, smallest first per product. */
  async listForProducts(productIds: string[]): Promise<PackTypeRow[]> {
    if (productIds.length === 0) return [];
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
       WHERE product_id = ANY(${productIds}::uuid[]) AND business_id = ${currentBusinessId()}::uuid
       ORDER BY product_id, units_per_pack, id`;
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

  /** Product, units and archived state (the pack type's or its product's) of these pack types. */
  async stockStatus(ids: string[]): Promise<{ id: string; productId: string; unitsPerPack: number; archived: boolean }[]> {
    if (ids.length === 0) return [];
    const rows = await currentTx().$queryRaw<{ id: string; product_id: string; units_per_pack: number; archived: boolean }[]>`
      SELECT pt.id, pt.product_id, pt.units_per_pack,
             (pt.archived_at IS NOT NULL OR p.archived_at IS NOT NULL) AS archived
        FROM pack_type pt
        JOIN product p ON p.business_id = pt.business_id AND p.id = pt.product_id
       WHERE pt.id = ANY(${ids}::uuid[]) AND pt.business_id = ${currentBusinessId()}::uuid`;
    return rows.map((r) => ({ id: r.id, productId: r.product_id, unitsPerPack: r.units_per_pack, archived: r.archived }));
  }

  async update(id: string, fields: Partial<PackTypeWrite>): Promise<void> {
    await currentTx().packType.update({ where: { id }, data: fields, select: { id: true } });
  }

  /** Phase D2 snapshot: every pack type, archived too, keyset by id. Prices as canonical text. */
  async pageForSync(afterId: string | null, limit: number): Promise<PackTypeRow[]> {
    const rows = await currentTx().$queryRaw<
      { id: string; product_id: string; name: string; units_per_pack: number; sell_price: string; cost_price: string | null; archived_at: Date | null }[]
    >`
      SELECT id, product_id, name, units_per_pack, sell_price::text AS sell_price,
             cost_price::text AS cost_price, archived_at
        FROM pack_type
       WHERE business_id = ${currentBusinessId()}::uuid
         AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
       ORDER BY id
       LIMIT ${limit}::int`;
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

  /** Phase D3 changes: these pack types as they are now (missing ids are simply absent). */
  async byIdsForSync(ids: string[]): Promise<PackTypeRow[]> {
    if (ids.length === 0) return [];
    const rows = await currentTx().$queryRaw<
      { id: string; product_id: string; name: string; units_per_pack: number; sell_price: string; cost_price: string | null; archived_at: Date | null }[]
    >`
      SELECT id, product_id, name, units_per_pack, sell_price::text AS sell_price,
             cost_price::text AS cost_price, archived_at
        FROM pack_type
       WHERE id = ANY(${ids}::uuid[]) AND business_id = ${currentBusinessId()}::uuid`;
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

  /** Phase E2: pack types with their product's name and prices, for a sale's snapshots. */
  async forSale(ids: string[]): Promise<PackTypeForSale[]> {
    if (ids.length === 0) return [];
    const rows = await currentTx().$queryRaw<
      { id: string; product_id: string; product_name: string; name: string; units_per_pack: number; sell_price: string; cost_price: string | null }[]
    >`
      SELECT pt.id, pt.product_id, p.name AS product_name, pt.name, pt.units_per_pack,
             pt.sell_price::text AS sell_price, pt.cost_price::text AS cost_price
        FROM pack_type pt
        JOIN product p ON p.business_id = pt.business_id AND p.id = pt.product_id
       WHERE pt.id = ANY(${ids}::uuid[]) AND pt.business_id = ${currentBusinessId()}::uuid`;
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      name: r.name,
      unitsPerPack: r.units_per_pack,
      sellPrice: r.sell_price,
      costPrice: r.cost_price,
    }));
  }
}
