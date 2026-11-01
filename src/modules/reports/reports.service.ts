import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { daysBetween, nairobiDay, nairobiDayEnd, nairobiDayStart, parseDay } from '../../common/time/nairobi.js';
import { AppConfig, MY_DAY_MAX_DAYS, REPORT_MAX_RANGE_DAYS } from '../../config/app.config.js';
import { isQueryCanceled } from '../../database/db-errors.js';
import { StaffService } from '../staff/staff.service.js';
import type { MyDayQueryDto } from './dto/my-day-query.dto.js';
import type { SalesReportQueryDto } from './dto/sales-report-query.dto.js';
import { type MyDayRows, ReportsRepository, type SalesGroupBy, type SalesReportRows } from './reports.repository.js';

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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
