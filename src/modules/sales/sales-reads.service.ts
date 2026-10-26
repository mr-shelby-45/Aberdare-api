import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { type CursorValues, SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import { Clock } from '../../common/time/clock.js';
import { SALES_SNAPSHOT_DAYS } from '../../config/app.config.js';
import type { PaymentReadRow } from '../payments/payments.repository.js';
import { PaymentsService } from '../payments/payments.service.js';
import { StaffService } from '../staff/staff.service.js';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto.js';
import { type SaleItemReadRow, type SaleReadRow, SalesReadsRepository } from './sales-reads.repository.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LIST_CURSOR = 'sales';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Who reads. A member without sales.void (an attendant) sees only the sales
 * they created; with it, all of the business's sales (docs/phase-e-design.md
 * section 7).
 */
export interface SalesViewer {
  membershipId: string;
  allSales: boolean;
}

export interface SaleDetail {
  sale: SaleReadRow;
  items: SaleItemReadRow[];
  payments: PaymentReadRow[];
  names: Map<string, string>;
}

// Sales reads (Phase E4): GET /v1/sales, GET /v1/sales/:id, and the sync rows
// of sale, sale_item and payment. Every read applies the visibility rule; a
// sale the viewer may not see is the same as one that does not exist.
@Injectable()
export class SalesReadsService {
  constructor(
    private readonly repo: SalesReadsRepository,
    private readonly payments: PaymentsService,
    private readonly staff: StaffService,
    private readonly cursor: SignedCursor,
    private readonly clock: Clock,
  ) {}

  /** Newest first. created_by is honoured only for viewers who see all sales. */
  async list(query: ListSalesQueryDto, viewer: SalesViewer): Promise<{ sales: (SaleReadRow & { itemCount: number })[]; names: Map<string, string>; nextCursor: string | null }> {
    const from = query.from === undefined ? null : new Date(query.from);
    const to = query.to === undefined ? null : new Date(query.to);
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'from and to must be valid times.');
    }
    if (from && to && from.getTime() >= to.getTime()) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'from must be before to.');
    }
    const createdBy = viewer.allSales ? (query.created_by ?? null) : viewer.membershipId;
    const filters: CursorValues = {
      created_by: createdBy,
      location_id: query.location_id ?? null,
      status: query.status ?? null,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
    };
    const limit = pageLimit(query.limit);
    let after: { occurredKey: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      const v = this.cursor.read(LIST_CURSOR, query.cursor);
      const id = cursorUuid(v?.after_id);
      if (!v || typeof v.after_occurred !== 'string' || !id || Object.entries(filters).some(([k, value]) => v[k] !== value)) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'The cursor is not valid.');
      }
      after = { occurredKey: v.after_occurred, id };
    }
    // One row more than asked tells whether there is a next page.
    const rows = await this.repo.list({
      createdBy,
      locationId: query.location_id ?? null,
      status: query.status ?? null,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      sales: page,
      names: await this.staff.displayNames(page.map((s) => s.createdByMembershipId)),
      nextCursor: rows.length > limit && last ? this.cursor.sign(LIST_CURSOR, { ...filters, after_occurred: last.occurredKey, after_id: last.id }) : null,
    };
  }

  /** One sale with its items and payments; 404 when missing, not a UUID, or not the viewer's to see. */
  async detail(id: string, viewer: SalesViewer): Promise<SaleDetail> {
    const saleId = cursorUuid(id);
    const [sale] = saleId ? await this.repo.byIds([saleId], ownerFilter(viewer)) : [];
    if (!sale) throw new ApiError(404, 'SALE_NOT_FOUND', 'Sale not found.');
    const items = await this.repo.items([sale.id]);
    const payments = await this.payments.forSales([sale.id]);
    const people = [sale.createdByMembershipId, sale.voidedByMembershipId, sale.voidApprovedByMembershipId].filter((m): m is string => m !== null);
    return { sale, items, payments, names: await this.staff.displayNames(people) };
  }

  // Sync (docs/phase-e-design.md section 8). The snapshot holds sales of the
  // last SALES_SNAPSHOT_DAYS by the Clock. Items and payments use one day more
  // (decided in E4): a snapshot is many requests while the Clock moves, so a
  // sale near the edge never loses its children; a phone ignores children of
  // a sale it does not hold. Changes have no age filter.

  async salesPageForSync(afterId: string | null, limit: number, viewer: SalesViewer): Promise<SaleReadRow[]> {
    return this.repo.pageForSync(afterId, limit, this.since(SALES_SNAPSHOT_DAYS), ownerFilter(viewer));
  }

  async salesByIdsForSync(ids: string[], viewer: SalesViewer): Promise<SaleReadRow[]> {
    return this.repo.byIds(ids, ownerFilter(viewer));
  }

  async itemsPageForSync(afterId: string | null, limit: number, viewer: SalesViewer): Promise<SaleItemReadRow[]> {
    return this.repo.itemsPageForSync(afterId, limit, this.since(SALES_SNAPSHOT_DAYS + 1), ownerFilter(viewer));
  }

  async itemsByIdsForSync(ids: string[], viewer: SalesViewer): Promise<SaleItemReadRow[]> {
    return this.repo.itemsByIds(ids, ownerFilter(viewer));
  }

  /**
   * The payments module only knows payments, so the sales it may return come
   * from here: the ids of the sales in the window that the viewer may see
   * (see docs/phase-e-results.md, E4, for the cost of this at scale).
   */
  async paymentsPageForSync(afterId: string | null, limit: number, viewer: SalesViewer): Promise<PaymentReadRow[]> {
    const saleIds = await this.repo.idsSince(this.since(SALES_SNAPSHOT_DAYS + 1), ownerFilter(viewer));
    return this.payments.pageForSync(afterId, limit, saleIds);
  }

  async paymentsByIdsForSync(ids: string[], viewer: SalesViewer): Promise<PaymentReadRow[]> {
    const rows = await this.payments.byIdsForSync(ids);
    const visible = await this.repo.visibleIds([...new Set(rows.map((p) => p.saleId))], ownerFilter(viewer));
    return rows.filter((p) => visible.has(p.saleId));
  }

  private since(days: number): Date {
    return new Date(this.clock.now().getTime() - days * DAY_MS);
  }
}

/** The member whose sales alone the viewer may see, or null for all. */
function ownerFilter(viewer: SalesViewer): string | null {
  return viewer.allSales ? null : viewer.membershipId;
}

/** limit: default 20; above 100 is quietly capped at 100; 0 is refused (as in B4). */
function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'limit must be at least 1.');
  return Math.min(n, MAX_LIMIT);
}
