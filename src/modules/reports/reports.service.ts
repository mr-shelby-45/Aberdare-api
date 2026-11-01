import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { daysBetween, nairobiDay, nairobiDayEnd, nairobiDayStart, parseDay } from '../../common/time/nairobi.js';
import { AppConfig, MY_DAY_MAX_DAYS, REPORT_MAX_RANGE_DAYS } from '../../config/app.config.js';
import { isQueryCanceled } from '../../database/db-errors.js';
import { StaffService } from '../staff/staff.service.js';
import type { MyDayQueryDto } from './dto/my-day-query.dto.js';
import type { ProfitQueryDto } from './dto/profit-query.dto.js';
import type { SalesReportQueryDto } from './dto/sales-report-query.dto.js';
import type { ShrinkageQueryDto } from './dto/shrinkage-query.dto.js';
import type { StockReportQueryDto } from './dto/stock-report-query.dto.js';
import type { TopProductsQueryDto } from './dto/top-products-query.dto.js';
import {
  type MyDayRows,
  type ProfitGroupBy,
  type ProfitReportRows,
  ReportsRepository,
  type SalesGroupBy,
  type SalesReportRows,
  type ShrinkageGroupBy,
  type ShrinkageGroupRow,
  type ShrinkageSums,
  type StockGroupBy,
  type StockGroupRow,
  type StockSums,
  type TopProductsBy,
} from './reports.repository.js';

// Shrinkage reasons in the order they are listed.
const SHRINKAGE_REASONS = ['DAMAGED', 'EXPIRED', 'LOST', 'FOUND', 'COUNT', 'SETTLEMENT'];

const TOP_PRODUCTS_DEFAULT_LIMIT = 10;
const TOP_PRODUCTS_MAX_LIMIT = 50;

/** Inclusive Nairobi days and the half-open instants they cover. */
export interface ReportRange {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

export interface SalesReport extends SalesReportRows {
  range: ReportRange;
  groupBy: SalesGroupBy;
  // Display names of the attendants in rows (group_by attendant only).
  names: Map<string, string>;
}

export interface MyDay extends MyDayRows {
  date: string;
}

/** One top product; costs only for a member with costs.view (absent, not null, otherwise). */
export interface TopProduct {
  productId: string;
  name: string;
  pieces: number;
  value: string;
  costs?: { cost: string; profit: string; valueWithoutCost: string };
}

export interface TopProducts {
  range: ReportRange;
  by: TopProductsBy;
  rows: TopProduct[];
}

/** Stock figures without the cost ones, plus them only for costs.view (absent, not null, otherwise). */
export type StockFigures = Omit<StockSums, 'valueAtCost' | 'poolsWithoutCost'> & {
  costs?: { valueAtCost: string; poolsWithoutCost: number };
};

export interface StockReport {
  groupBy: StockGroupBy;
  totals: StockFigures;
  rows: (StockFigures & Pick<StockGroupRow, 'key' | 'name' | 'packs'>)[];
}

/** Shrinkage figures in pieces, plus the cost values only for costs.view. */
export type ShrinkageFigures = Pick<ShrinkageSums, 'unitsLost' | 'unitsFound' | 'netUnits'> & {
  costs?: Pick<ShrinkageSums, 'valueLostAtCost' | 'valueFoundAtCost' | 'netValueAtCost' | 'movementsWithoutCost'>;
};

export interface ShrinkageReport {
  range: ReportRange;
  groupBy: ShrinkageGroupBy;
  totals: ShrinkageFigures;
  rows: (ShrinkageFigures & Pick<ShrinkageGroupRow, 'key' | 'name'>)[];
  // Display names of the people in rows (group_by person only).
  names: Map<string, string>;
}

export interface ProfitReport extends ProfitReportRows {
  range: ReportRange;
  groupBy: ProfitGroupBy;
  // Display names of the attendants in rows (group_by attendant only).
  names: Map<string, string>;
}

// Reports (Phase G1, docs/phase-g1-design.md). Live queries in Nairobi days;
// voided sales are left out (except the voided count of "my day"). Every
// report runs under an 8 second statement timeout: a cancelled statement is
// 503 REPORT_TOO_SLOW, and the request's transaction rolls back.
@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly staff: StaffService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async sales(query: SalesReportQueryDto): Promise<SalesReport> {
    const range = reportRange(query.from, query.to);
    const groupBy = query.group_by ?? 'day';
    const r = await this.timed(() =>
      this.repo.sales({ from: range.start, to: range.end, groupBy, locationId: query.location_id ?? null, attendantId: query.attendant_id ?? null }),
    );
    const names = groupBy === 'attendant' ? await this.staff.displayNames(r.rows.map((x) => x.key)) : new Map<string, string>();
    // Days ascending; attendants and locations by name, then id. Plain code
    // point order, so the result never depends on the server's locale.
    const label = (x: SalesReportRows['rows'][number]) =>
      groupBy === 'attendant' ? (names.get(x.key) ?? '') : groupBy === 'location' ? (x.locationName ?? '') : x.key;
    const rows = [...r.rows].sort((a, b) => compare(label(a), label(b)) || compare(a.key, b.key));
    return { ...r, rows, range, groupBy, names };
  }

  /** The caller's own sales on one Nairobi day within the last 7 (today included). */
  async myDay(membershipId: string, query: MyDayQueryDto): Promise<MyDay> {
    const today = nairobiDay(this.clock.now());
    const date = query.date === undefined ? today : parseDay(query.date);
    if (date === null) throw new ApiError(422, 'VALIDATION_FAILED', 'date must be a real date (YYYY-MM-DD).');
    const back = daysBetween(date, today);
    if (back < 0 || back >= MY_DAY_MAX_DAYS) {
      throw new ApiError(422, 'VALIDATION_FAILED', `date must be today or one of the ${MY_DAY_MAX_DAYS - 1} days before.`);
    }
    const r = await this.timed(() => this.repo.myDay({ membershipId, from: nairobiDayStart(date), to: nairobiDayEnd(date) }));
    return { ...r, date };
  }

  /**
   * The best-selling products by pieces or by value. Cost figures only with
   * costs.view (the caller passes the live permission).
   */
  async topProducts(query: TopProductsQueryDto, canSeeCosts: boolean): Promise<TopProducts> {
    const range = reportRange(query.from, query.to);
    const by = query.by ?? 'quantity';
    const limit = topProductsLimit(query.limit);
    const r = await this.timed(() =>
      this.repo.topProducts({ from: range.start, to: range.end, by, limit, locationId: query.location_id ?? null }),
    );
    const rows = r.map(
      (x): TopProduct => ({
        productId: x.productId,
        name: x.name,
        pieces: x.pieces,
        value: x.value,
        ...(canSeeCosts ? { costs: { cost: x.cost, profit: x.profit, valueWithoutCost: x.valueWithoutCost } } : {}),
      }),
    );
    return { range, by, rows };
  }

  /** Profit over lines with a recorded cost. The route requires costs.view. */
  async profit(query: ProfitQueryDto): Promise<ProfitReport> {
    const range = reportRange(query.from, query.to);
    const groupBy = query.group_by ?? 'day';
    const r = await this.timed(() => this.repo.profit({ from: range.start, to: range.end, groupBy }));
    const names = groupBy === 'attendant' ? await this.staff.displayNames(r.rows.map((x) => x.key)) : new Map<string, string>();
    // Same order as the sales report: days ascending, products and attendants
    // by name, then id, in code point order.
    const label = (x: ProfitReportRows['rows'][number]) =>
      groupBy === 'attendant' ? (names.get(x.key) ?? '') : groupBy === 'product' ? (x.productName ?? '') : x.key;
    const rows = [...r.rows].sort((a, b) => compare(label(a), label(b)) || compare(a.key, b.key));
    return { ...r, rows, range, groupBy, names };
  }

  /** Stock on hand now; the same pools as GET /v1/stock for the same filters. */
  async stock(query: StockReportQueryDto, canSeeCosts: boolean): Promise<StockReport> {
    const groupBy = query.group_by ?? 'product';
    const r = await this.timed(() =>
      this.repo.stock({
        groupBy,
        locationId: query.location_id ?? null,
        includeZero: query.include_zero === 'true',
        includeArchived: query.include_archived === 'true',
      }),
    );
    const figures = (x: StockSums): StockFigures => ({
      pieces: x.pieces,
      pools: x.pools,
      negativePools: x.negativePools,
      ...(canSeeCosts ? { costs: { valueAtCost: x.valueAtCost, poolsWithoutCost: x.poolsWithoutCost } } : {}),
    });
    // Products and locations by name, then id, in code point order.
    const rows = [...r.rows]
      .sort((a, b) => compare(a.name, b.name) || compare(a.key, b.key))
      .map((x) => ({ key: x.key, name: x.name, packs: x.packs, ...figures(x) }));
    return { groupBy, totals: figures(r.totals), rows };
  }

  /** Stock lost and found in the range, in pieces; cost values only with costs.view. */
  async shrinkage(query: ShrinkageQueryDto, canSeeCosts: boolean): Promise<ShrinkageReport> {
    const range = reportRange(query.from, query.to);
    const groupBy = query.group_by ?? 'reason';
    const r = await this.timed(() => this.repo.shrinkage({ from: range.start, to: range.end, groupBy }));
    const names = groupBy === 'person' ? await this.staff.displayNames(r.rows.map((x) => x.key)) : new Map<string, string>();
    const figures = (x: ShrinkageSums): ShrinkageFigures => ({
      unitsLost: x.unitsLost,
      unitsFound: x.unitsFound,
      netUnits: x.netUnits,
      ...(canSeeCosts
        ? {
            costs: {
              valueLostAtCost: x.valueLostAtCost,
              valueFoundAtCost: x.valueFoundAtCost,
              netValueAtCost: x.netValueAtCost,
              movementsWithoutCost: x.movementsWithoutCost,
            },
          }
        : {}),
    });
    // Reasons in their fixed order; people, locations and products by name, then id.
    const order = (a: ShrinkageGroupRow, b: ShrinkageGroupRow) =>
      groupBy === 'reason'
        ? SHRINKAGE_REASONS.indexOf(a.key) - SHRINKAGE_REASONS.indexOf(b.key)
        : compare(groupBy === 'person' ? (names.get(a.key) ?? '') : (a.name ?? ''), groupBy === 'person' ? (names.get(b.key) ?? '') : (b.name ?? '')) ||
          compare(a.key, b.key);
    const rows = [...r.rows].sort(order).map((x) => ({ key: x.key, name: x.name, ...figures(x) }));
    return { range, groupBy, totals: figures(r.totals), rows, names };
  }

  private async timed<T>(fn: () => Promise<T>): Promise<T> {
    await this.repo.limitStatementTime(this.config.reportStatementTimeoutMs);
    try {
      return await fn();
    } catch (err) {
      if (isQueryCanceled(err)) throw new ApiError(503, 'REPORT_TOO_SLOW', 'The report took too long. Try a shorter range or fewer filters.');
      throw err;
    }
  }
}

/**
 * from and to: inclusive Nairobi days, real dates, from not after to, at most
 * 92 days counting both ends. The range is [from 00:00, to + 1 day 00:00)
 * Nairobi time, as instants.
 */
export function reportRange(fromText: string, toText: string): ReportRange {
  const from = parseDay(fromText);
  const to = parseDay(toText);
  if (from === null || to === null) throw new ApiError(422, 'VALIDATION_FAILED', 'from and to must be real dates (YYYY-MM-DD).');
  const span = daysBetween(from, to) + 1;
  if (span < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'from must not be after to.');
  if (span > REPORT_MAX_RANGE_DAYS) throw new ApiError(422, 'RANGE_TOO_LARGE', `A report covers at most ${REPORT_MAX_RANGE_DAYS} days.`);
  return { from, to, start: nairobiDayStart(from), end: nairobiDayEnd(to) };
}

function topProductsLimit(raw: string | undefined): number {
  if (raw === undefined) return TOP_PRODUCTS_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > TOP_PRODUCTS_MAX_LIMIT) {
    throw new ApiError(422, 'VALIDATION_FAILED', `limit must be 1 to ${TOP_PRODUCTS_MAX_LIMIT}.`);
  }
  return n;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
