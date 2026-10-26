import { Injectable } from '@nestjs/common';
import type { Permission } from '../../common/auth/permissions.js';
import { LocationsService } from '../locations/locations.service.js';
import type { LocationRow } from '../locations/locations.repository.js';
import type { PackTypeRow } from '../products/pack-types.repository.js';
import { ProductsService } from '../products/products.service.js';
import type { ProductRow } from '../products/products.repository.js';
import { SalesReadsService } from '../sales/sales-reads.service.js';
import { paymentJson, saleItemJson, saleJson } from '../sales/sales-view.js';
import { StockService } from '../stock/stock.service.js';
import type { ResultValue } from './command-outcome.js';

/** The tables a phone keeps offline, parents before children (docs/phase-d-design.md section 5; sales from Phase E4). */
export const SYNC_TABLE_NAMES = ['location', 'product', 'pack_type', 'product_barcode', 'stock_balance', 'sale', 'sale_item', 'payment'] as const;
export type SyncTableName = (typeof SYNC_TABLE_NAMES)[number];

/** What the reader may see: costs, and all sales or only the reader's own (Phase E4). */
export interface SyncView {
  costs: boolean;
  allSales: boolean;
  membershipId: string;
}

/** One row as the phone receives it: snake_case, money as strings, times as ISO text. */
export type SyncRow = { id: string } & Record<string, ResultValue>;

export interface SyncTable {
  name: SyncTableName;
  // Needed to see the table at all; without it the table is empty in a
  // snapshot and its changes are skipped.
  permission: Permission | null;
  // false for tables whose rows are never deleted (sales): a row not found
  // in changes is one this reader may not see, skipped without a delete marker.
  deletes: boolean;
  /** Rows after afterId in id order, at most limit, shaped for this reader (snapshot). */
  page(afterId: string | null, limit: number, view: SyncView): Promise<SyncRow[]>;
  /** These rows as they are now, shaped for this reader; missing ids are absent (changes). */
  byIds(ids: string[], view: SyncView): Promise<SyncRow[]>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// One shape per table, shared by the snapshot and the changes, so a row
// looks the same whichever way it reached the phone.
const locationRow = (l: LocationRow): SyncRow => ({ id: l.id, name: l.name, is_default: l.isDefault, archived_at: iso(l.archivedAt) });
const productRow = (p: ProductRow): SyncRow => ({ id: p.id, name: p.name, sku: p.sku, archived_at: iso(p.archivedAt) });
const packTypeRow =
  (view: SyncView) =>
  (t: PackTypeRow): SyncRow => ({
    id: t.id,
    product_id: t.productId,
    name: t.name,
    units_per_pack: t.unitsPerPack,
    sell_price: t.sellPrice,
    ...(view.costs ? { cost_price: t.costPrice } : {}),
    archived_at: iso(t.archivedAt),
  });
const barcodeRow = (b: { id: string; barcode: string; productId: string; packTypeId: string }): SyncRow => ({
  id: b.id,
  barcode: b.barcode,
  product_id: b.productId,
  pack_type_id: b.packTypeId,
});
const balanceRow = (b: { id: string; locationId: string; packTypeId: string; quantity: number; updatedAt: Date }): SyncRow => ({
  id: b.id,
  location_id: b.locationId,
  pack_type_id: b.packTypeId,
  quantity: b.quantity,
  updated_at: b.updatedAt.toISOString(),
});

// The sync tables (Phase D). Adding a table later means adding one entry
// here (and its name to SYNC_TABLE_NAMES). Each entry reads through the
// owning module's service, so the sync module never reads another module's
// tables. Shapes follow the Phase B and C reads, flattened one row per table;
// cost_price is left out (not null) without costs.view.
@Injectable()
export class SyncTables {
  private readonly byName: ReadonlyMap<SyncTableName, SyncTable>;

  constructor(locations: LocationsService, products: ProductsService, stock: StockService, sales: SalesReadsService) {
    const entries: SyncTable[] = [
      {
        name: 'location',
        permission: null,
        deletes: true,
        page: async (after, limit) => (await locations.pageForSync(after, limit)).map(locationRow),
        byIds: async (ids) => (await locations.byIdsForSync(ids)).map(locationRow),
      },
      {
        name: 'product',
        permission: null,
        deletes: true,
        page: async (after, limit) => (await products.productsPageForSync(after, limit)).map(productRow),
        byIds: async (ids) => (await products.productsByIdsForSync(ids)).map(productRow),
      },
      {
        name: 'pack_type',
        permission: null,
        deletes: true,
        page: async (after, limit, view) => (await products.packTypesPageForSync(after, limit)).map(packTypeRow(view)),
        byIds: async (ids, view) => (await products.packTypesByIdsForSync(ids)).map(packTypeRow(view)),
      },
      {
        name: 'product_barcode',
        permission: null,
        deletes: true,
        page: async (after, limit) => (await products.barcodesPageForSync(after, limit)).map(barcodeRow),
        byIds: async (ids) => (await products.barcodesByIdsForSync(ids)).map(barcodeRow),
      },
      {
        name: 'stock_balance',
        permission: 'stock.view',
        deletes: true,
        page: async (after, limit) => (await stock.balancesPageForSync(after, limit)).map(balanceRow),
        byIds: async (ids) => (await stock.balancesByIdsForSync(ids)).map(balanceRow),
      },
      // Sales (Phase E4, docs/phase-e-design.md section 8): every member, but a
      // member without sales.void receives only their own sales and their
      // items and payments. The snapshot holds the last 30 days.
      {
        name: 'sale',
        permission: null,
        deletes: false,
        page: async (after, limit, view) => (await sales.salesPageForSync(after, limit, view)).map(saleJson),
        byIds: async (ids, view) => (await sales.salesByIdsForSync(ids, view)).map(saleJson),
      },
      {
        name: 'sale_item',
        permission: null,
        deletes: false,
        page: async (after, limit, view) => (await sales.itemsPageForSync(after, limit, view)).map((i) => saleItemJson(i, view.costs)),
        byIds: async (ids, view) => (await sales.itemsByIdsForSync(ids, view)).map((i) => saleItemJson(i, view.costs)),
      },
      {
        name: 'payment',
        permission: null,
        deletes: false,
        page: async (after, limit, view) => (await sales.paymentsPageForSync(after, limit, view)).map(paymentJson),
        byIds: async (ids, view) => (await sales.paymentsByIdsForSync(ids, view)).map(paymentJson),
      },
    ];
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  get(name: SyncTableName): SyncTable {
    return this.byName.get(name)!;
  }

  /** The entry for a change_log table name, or null for a table phones do not keep. */
  find(name: string): SyncTable | null {
    return this.byName.get(name as SyncTableName) ?? null;
  }

  /** The table after this one, or null after the last. */
  next(name: SyncTableName): SyncTableName | null {
    return SYNC_TABLE_NAMES[SYNC_TABLE_NAMES.indexOf(name) + 1] ?? null;
  }
}
