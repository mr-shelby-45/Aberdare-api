import { Injectable } from '@nestjs/common';
import type { Permission } from '../../common/auth/permissions.js';
import { LocationsService } from '../locations/locations.service.js';
import { ProductsService } from '../products/products.service.js';
import { StockService } from '../stock/stock.service.js';
import type { ResultValue } from './command-outcome.js';

/** The tables a phone keeps offline, parents before children (docs/phase-d-design.md section 5). */
export const SYNC_TABLE_NAMES = ['location', 'product', 'pack_type', 'product_barcode', 'stock_balance'] as const;
export type SyncTableName = (typeof SYNC_TABLE_NAMES)[number];

/** What the reader may see. */
export interface SyncView {
  costs: boolean;
}

/** One row as the phone receives it: snake_case, money as strings, times as ISO text. */
export type SyncRow = { id: string } & Record<string, ResultValue>;

export interface SyncTable {
  name: SyncTableName;
  // Needed to see the table at all; without it the table is returned empty.
  permission: Permission | null;
  /** Rows after afterId in id order, at most limit, shaped for this reader. */
  page(afterId: string | null, limit: number, view: SyncView): Promise<SyncRow[]>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// The sync tables (Phase D). Adding a table later means adding one entry
// here (and its name to SYNC_TABLE_NAMES). Each entry reads through the
// owning module's service, so the sync module never reads another module's
// tables. Shapes follow the Phase B and C reads, flattened one row per table;
// cost_price is left out (not null) without costs.view.
@Injectable()
export class SyncTables {
  private readonly byName: ReadonlyMap<SyncTableName, SyncTable>;

  constructor(locations: LocationsService, products: ProductsService, stock: StockService) {
    const entries: SyncTable[] = [
      {
        name: 'location',
        permission: null,
        page: async (after, limit) =>
          (await locations.pageForSync(after, limit)).map((l) => ({ id: l.id, name: l.name, is_default: l.isDefault, archived_at: iso(l.archivedAt) })),
      },
      {
        name: 'product',
        permission: null,
        page: async (after, limit) =>
          (await products.productsPageForSync(after, limit)).map((p) => ({ id: p.id, name: p.name, sku: p.sku, archived_at: iso(p.archivedAt) })),
      },
      {
        name: 'pack_type',
        permission: null,
        page: async (after, limit, view) =>
          (await products.packTypesPageForSync(after, limit)).map((t) => ({
            id: t.id,
            product_id: t.productId,
            name: t.name,
            units_per_pack: t.unitsPerPack,
            sell_price: t.sellPrice,
            ...(view.costs ? { cost_price: t.costPrice } : {}),
            archived_at: iso(t.archivedAt),
          })),
      },
      {
        name: 'product_barcode',
        permission: null,
        page: async (after, limit) =>
          (await products.barcodesPageForSync(after, limit)).map((b) => ({ id: b.id, barcode: b.barcode, product_id: b.productId, pack_type_id: b.packTypeId })),
      },
      {
        name: 'stock_balance',
        permission: 'stock.view',
        page: async (after, limit) =>
          (await stock.balancesPageForSync(after, limit)).map((b) => ({
            id: b.id,
            location_id: b.locationId,
            pack_type_id: b.packTypeId,
            quantity: b.quantity,
            updated_at: b.updatedAt.toISOString(),
          })),
      },
    ];
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  get(name: SyncTableName): SyncTable {
    return this.byName.get(name)!;
  }

  /** The table after this one, or null after the last. */
  next(name: SyncTableName): SyncTableName | null {
    return SYNC_TABLE_NAMES[SYNC_TABLE_NAMES.indexOf(name) + 1] ?? null;
  }
}
