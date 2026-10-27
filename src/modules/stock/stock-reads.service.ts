import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { type CursorValues, SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import { LocationsService } from '../locations/locations.service.js';
import type { ListMovementsQueryDto } from './dto/list-movements-query.dto.js';
import type { ListStockQueryDto } from './dto/list-stock-query.dto.js';
import { type BalanceRow, type MovementReadRow, StockReadsRepository } from './stock-reads.repository.js';

// Reads (docs/phase-c-design.md section 7).
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STOCK_CURSOR = 'stock';
const MOVEMENTS_CURSOR = 'stock-movements';

// GET /v1/stock and GET /v1/stock/movements. Keyset paging with the shared
// signed cursor, which also carries the filters it was issued for: a cursor
// used with other filters is refused, like a tampered one.
@Injectable()
export class StockReadsService {
  constructor(
    private readonly repo: StockReadsRepository,
    private readonly cursor: SignedCursor,
    private readonly locations: LocationsService,
  ) {}

  /** Hides zero rows unless include_zero; always shows negative ones. */
  /** Phase T2: only the member's allowed locations; a location_id outside them gives an empty list, like an unknown one. */
  async balances(query: ListStockQueryDto, membershipId: string): Promise<{ balances: BalanceRow[]; nextCursor: string | null }> {
    const filters: CursorValues = {
      location_id: query.location_id ?? null,
      product_id: query.product_id ?? null,
      include_zero: query.include_zero === 'true',
      include_archived: query.include_archived === 'true',
    };
    const limit = pageLimit(query.limit);
    let after: { productName: string; packTypeId: string; locationId: string } | null = null;
    if (query.cursor !== undefined) {
      const v = this.readCursor(STOCK_CURSOR, query.cursor, filters);
      const packTypeId = cursorUuid(v.pack_type_id);
      const locationId = cursorUuid(v.after_location_id);
      if (typeof v.product_name !== 'string' || !packTypeId || !locationId) throw invalidCursor();
      after = { productName: v.product_name, packTypeId, locationId };
    }
    // One row more than asked tells whether there is a next page.
    const rows = await this.repo.balances({
      scopeIds: (await this.locations.scopeOf(membershipId)).ids(),
      locationId: query.location_id ?? null,
      productId: query.product_id ?? null,
      includeZero: filters.include_zero === true,
      includeArchived: filters.include_archived === true,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      balances: page,
      nextCursor:
        rows.length > limit && last
          ? this.cursor.sign(STOCK_CURSOR, {
              ...filters,
              product_name: last.productName,
              pack_type_id: last.packTypeId,
              after_location_id: last.locationId,
            })
          : null,
    };
  }

  /** Newest first. */
  async movements(query: ListMovementsQueryDto, membershipId: string): Promise<{ movements: MovementReadRow[]; nextCursor: string | null }> {
    const from = query.from === undefined ? null : new Date(query.from);
    const to = query.to === undefined ? null : new Date(query.to);
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'from and to must be valid times.');
    }
    if (from && to && from.getTime() >= to.getTime()) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'from must be before to.');
    }
    const filters: CursorValues = {
      location_id: query.location_id ?? null,
      pack_type_id: query.pack_type_id ?? null,
      product_id: query.product_id ?? null,
      type: query.type ?? null,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
    };
    const limit = pageLimit(query.limit);
    let after: { occurredKey: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      const v = this.readCursor(MOVEMENTS_CURSOR, query.cursor, filters);
      const id = cursorUuid(v.after_id);
      if (typeof v.after_occurred !== 'string' || !id) throw invalidCursor();
      after = { occurredKey: v.after_occurred, id };
    }
    const rows = await this.repo.movements({
      scopeIds: (await this.locations.scopeOf(membershipId)).ids(),
      locationId: query.location_id ?? null,
      packTypeId: query.pack_type_id ?? null,
      productId: query.product_id ?? null,
      type: query.type ?? null,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      movements: page,
      nextCursor:
        rows.length > limit && last
          ? this.cursor.sign(MOVEMENTS_CURSOR, { ...filters, after_occurred: last.occurredKey, after_id: last.id })
          : null,
    };
  }

  /** The cursor's values, if it is genuine and was issued for exactly these filters. */
  private readCursor(kind: string, raw: string, filters: CursorValues): CursorValues {
    const v = this.cursor.read(kind, raw);
    if (!v) throw invalidCursor();
    for (const [key, value] of Object.entries(filters)) {
      if (v[key] !== value) throw invalidCursor();
    }
    return v;
  }
}

/** limit: default 20; above 100 is quietly capped at 100; 0 is refused (as in B4). */
function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'limit must be at least 1.');
  return Math.min(n, MAX_LIMIT);
}

function invalidCursor(): ApiError {
  return new ApiError(422, 'VALIDATION_FAILED', 'The cursor is not valid.');
}
