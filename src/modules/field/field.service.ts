import { Injectable } from '@nestjs/common';
import { MAX_CENTS, fromCents, signedCents, toCents } from '../../common/money/cents.js';
import { ApiError } from '../../common/errors/api.error.js';
import { type CursorValues, SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import { Clock } from '../../common/time/clock.js';
import { FIELD_SYNC_MAX_AGE_MINUTES } from '../../config/app.config.js';
import { AuditService } from '../audit/audit.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { FieldSettlementsService } from '../field-settlements/field-settlements.service.js';
import type { SettlementLineRow } from '../field-settlements/field-settlements.repository.js';
import { LocationsService } from '../locations/locations.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ProductsService } from '../products/products.service.js';
import { SalesReadsService } from '../sales/sales-reads.service.js';
import { StaffService } from '../staff/staff.service.js';
import { inLockOrder } from '../stock/lock-order.js';
import { StockError } from '../stock/stock.error.js';
import { StockService } from '../stock/stock.service.js';
import type { CloseSettlementDto } from './dto/close-settlement.dto.js';
import type { ListSettlementsQueryDto } from './dto/settlement-queries.dto.js';
import { FieldError, type InvalidSettlementLine } from './field.error.js';

const MAX_COUNTED = 2_000_000_000;
const LIST_CURSOR = 'field-settlements';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Locking a balance row created while the close was locking: try a few times, then go on with what is locked.
const MAX_LOCK_ROUNDS = 5;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Who closes, and the command's times. */
export interface SettlementActor {
  membershipId: string;
  occurredAt: Date;
  receivedAt: Date;
  syncCommandId: string;
}

/** One pack type's figures in a window. */
export interface WindowLine {
  packTypeId: string;
  issued: number;
  returned: number;
  sold: number;
  voidedBack: number;
  other: number;
  expectedQuantity: number;
}

/** The figures a close stores (and the preview shows). Money as canonical text. */
export interface WindowFigures {
  lines: WindowLine[];
  expectedCash: string;
  mpesaVerifiedTotal: string;
  mpesaUnverifiedTotal: string;
  saleCount: number;
  voidedCount: number;
  unpaidTotal: string;
  // Phase T6: the part of expectedCash that belongs to sales of earlier windows.
  earlierSalesCash: string;
}

// The field attendant's day-end settlement (Phase T4, docs/phase-t-design.md
// section 6, window rule B). A settlement covers the sales and movements at
// its location whose transaction is visible in its snapshot and was not in
// the previous settlement's, so every row is counted exactly once however
// long its transaction ran. Lock order: the location row (FOR NO KEY UPDATE,
// serialising closes of one location without blocking sales), then the
// location's balance rows in the pack order; nothing after that waits.
@Injectable()
export class FieldService {
  constructor(
    private readonly settlements: FieldSettlementsService,
    private readonly locations: LocationsService,
    private readonly stock: StockService,
    private readonly products: ProductsService,
    private readonly sales: SalesReadsService,
    private readonly payments: PaymentsService,
    private readonly devices: DevicesService,
    private readonly staff: StaffService,
    private readonly audit: AuditService,
    private readonly cursor: SignedCursor,
    private readonly clock: Clock,
  ) {}

  /** GET /v1/field/settlements/preview: what a close now would store. Read only, no locks. */
  async preview(locationId: string) {
    const location = await this.locations.findById(locationId);
    if (!location || location.kind !== 'FIELD') throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Location not found.');
    const latest = await this.settlements.latest(locationId);
    const snapshot = await this.settlements.currentSnapshot();
    const balances = new Map((await this.stock.balancesAt(locationId)).map((b) => [b.packTypeId, b.quantity]));
    const figures = await this.figures(locationId, location.assignedMembershipId!, snapshot, latest?.snapshot ?? null, balances);
    return {
      location,
      periodStart: latest?.periodEnd ?? (await this.locations.createdAt(locationId)),
      lastSyncedAt: await this.devices.lastSyncOf(location.assignedMembershipId!),
      figures,
    };
  }

  /** settlement.close. See the class comment for the window and the lock order. */
  async close(dto: CloseSettlementDto, actor: SettlementActor): Promise<{ settlementId: string; cashVariance: string; lines: { packTypeId: string; variance: number }[] }> {
    const note = cleanText(dto.note);
    const cashCents = toCents(dto.cash_received);
    if (cashCents === null || cashCents > MAX_CENTS) throw new FieldError('VALIDATION_FAILED', 'cash_received is not a valid amount.');
    if (await this.settlements.exists(dto.settlement_id)) {
      throw new FieldError('SETTLEMENT_ALREADY_EXISTS', 'This settlement was already closed.');
    }
    // The same answer for a missing location, another business's, and one that is not a field location.
    const location = await this.locations.lockForSettlement(dto.field_location_id);
    if (!location || location.kind !== 'FIELD') throw new FieldError('LOCATION_NOT_FOUND', 'Location not found.');
    const attendant = location.assignedMembershipId!;
    const lastSync = await this.devices.lastSyncOf(attendant);
    if (!lastSync || lastSync.getTime() < actor.receivedAt.getTime() - FIELD_SYNC_MAX_AGE_MINUTES * 60_000) {
      throw new FieldError('ATTENDANT_NOT_SYNCED', 'The attendant\'s phone has not synced recently. Sync it, then close again.');
    }

    // Lock every balance row at the location in the pack order, then take the
    // snapshot; a row created meanwhile is locked and the snapshot taken again.
    const locked = new Map<string, number>();
    let snapshot = '';
    for (let round = 0; round < MAX_LOCK_ROUNDS; round++) {
      const missing = (await this.stock.balancesAt(location.id)).filter((b) => !locked.has(b.packTypeId));
      if (round > 0 && missing.length === 0) break;
      const packs = await this.products.packTypesForStock(missing.map((b) => b.packTypeId));
      for (const b of inLockOrder(missing.map((m) => ({ ...m, pack_type_id: m.packTypeId })), packs)) {
        const quantity = await this.stock.lockBalance(b.id);
        if (quantity !== null) locked.set(b.packTypeId, quantity);
      }
      snapshot = await this.settlements.currentSnapshot();
    }

    const latest = await this.settlements.latest(location.id);
    const figures = await this.figures(location.id, attendant, snapshot, latest?.snapshot ?? null, locked);
    const lines = this.checkLines(dto, figures.lines, locked);

    const expectedCents = signedCents(figures.expectedCash);
    const cashVariance = fromCents(cashCents - expectedCents);
    const names = await this.staff.displayNames([attendant]);
    // Fix found in T5: the order and the period follow the lock, not the command's arrival.
    // The sequence is the previous + 1 (we hold the location lock); period_end is the
    // server time now, after the lock wait, and never before the previous period_end.
    const sequence = (latest?.sequence ?? 0) + 1;
    const now = this.clock.now();
    const periodEnd = latest && latest.periodEnd.getTime() > now.getTime() ? latest.periodEnd : now;
    // A location created after the close's server time (only with a test clock) starts its first window at the close.
    const created = (await this.locations.createdAt(location.id)) ?? periodEnd;
    const periodStart = latest?.periodEnd ?? (created.getTime() < periodEnd.getTime() ? created : periodEnd);

    await this.settlements.insert(
      {
        id: dto.settlement_id,
        sequence,
        fieldLocationId: location.id,
        attendantMembershipId: attendant,
        closedByMembershipId: actor.membershipId,
        syncCommandId: actor.syncCommandId,
        occurredAt: actor.occurredAt,
        receivedAt: actor.receivedAt,
        periodStart,
        periodEnd,
        expectedCash: figures.expectedCash,
        cashReceived: fromCents(cashCents),
        cashVariance,
        mpesaVerifiedTotal: figures.mpesaVerifiedTotal,
        mpesaUnverifiedTotal: figures.mpesaUnverifiedTotal,
        saleCount: figures.saleCount,
        voidedCount: figures.voidedCount,
        unpaidTotal: figures.unpaidTotal,
        earlierSalesCash: figures.earlierSalesCash,
        snapshot,
        note,
      },
    );

    // Per line, in the pack order: the balance set to the count in one statement, the adjustment from the locked row.
    const byPack = new Map(figures.lines.map((l) => [l.packTypeId, l]));
    const packs = await this.products.packTypesForStock(lines.map((l) => l.pack_type_id));
    const rows: SettlementLineRow[] = [];
    const ctx = { occurredAt: actor.occurredAt, createdByMembershipId: actor.membershipId, syncCommandId: actor.syncCommandId };
    for (const line of inLockOrder(lines, packs)) {
      let settled: { expected: number; variance: bigint };
      try {
        settled = await this.stock.settleCount(location.id, line.pack_type_id, line.counted_quantity, ctx, {
          settlementId: dto.settlement_id,
          note: `Field settlement: ${names.get(attendant) ?? 'attendant'}`,
        });
      } catch (err) {
        if (err instanceof StockError) throw new FieldError('VALIDATION_FAILED', err.message);
        throw err;
      }
      const flows = byPack.get(line.pack_type_id);
      rows.push({
        packTypeId: line.pack_type_id,
        issued: flows?.issued ?? 0,
        returned: flows?.returned ?? 0,
        sold: flows?.sold ?? 0,
        voidedBack: flows?.voidedBack ?? 0,
        expectedQuantity: settled.expected,
        countedQuantity: line.counted_quantity,
        variance: Number(settled.variance),
      });
    }
    await this.settlements.insertLines(dto.settlement_id, rows);
    return this.finish(dto, actor, location.id, attendant, figures, cashCents, cashVariance, rows);
  }

  /** The window's figures under one snapshot. `balances` are the expected quantities (locked for a close). */
  private async figures(locationId: string, attendant: string, snapshot: string, previous: string | null, balances: ReadonlyMap<string, number>): Promise<WindowFigures> {
    const flows = await this.stock.windowFlows(locationId, snapshot, previous);
    const packIds = new Set([...balances.keys(), ...flows.map((f) => f.packTypeId)]);
    const byPack = new Map(flows.map((f) => [f.packTypeId, f]));
    const lines: WindowLine[] = [...packIds].sort().map((packTypeId) => {
      const f = byPack.get(packTypeId);
      return {
        packTypeId,
        issued: f?.issued ?? 0,
        returned: f?.returned ?? 0,
        sold: f?.sold ?? 0,
        voidedBack: f?.voidedBack ?? 0,
        other: f?.other ?? 0,
        expectedQuantity: balances.get(packTypeId) ?? 0,
      };
    });
    const windowSales = await this.sales.inSettlementWindow(locationId, snapshot, previous);
    const completed = windowSales.filter((s) => s.status === 'COMPLETED');
    // Phase T6: payments by the snapshot rule (in when recorded, out when reversed, so a late
    // payment or refund counts in the window that first sees it), and only the attendant's
    // own payments on their personal devices: other cash never passed through their hands.
    const payer = { membershipId: attendant, deviceIds: await this.devices.personalDeviceIdsOf(attendant) };
    const totals = await this.payments.windowTotals(locationId, payer, snapshot, previous, windowSales.map((s) => s.id));
    const unpaid = completed.reduce((sum, s) => sum + toCents(s.balanceDue)!, 0n);
    return {
      lines,
      expectedCash: totals.cash,
      mpesaVerifiedTotal: totals.mpesaVerified,
      mpesaUnverifiedTotal: totals.mpesaUnverified,
      saleCount: windowSales.length,
      voidedCount: windowSales.length - completed.length,
      unpaidTotal: fromCents(unpaid),
      earlierSalesCash: totals.earlierSalesCash,
    };
  }

  /**
   * Every bad line and every missing one: a pack type with a nonzero balance
   * or movements in the window needs a line (LINE_MISSING, so nothing is
   * silently skipped); a line needs a balance row at the location
   * (PACK_TYPE_NOT_FOUND otherwise); counts are 0 to 2,000,000,000 and whole.
   */
  private checkLines(dto: CloseSettlementDto, window: WindowLine[], locked: ReadonlyMap<string, number>) {
    const invalid: InvalidSettlementLine[] = [];
    const seen = new Set<string>();
    dto.lines.forEach((line, i) => {
      const n = i + 1;
      if (seen.has(line.pack_type_id)) invalid.push({ line: n, reason: 'DUPLICATE_LINE' });
      else if (!locked.has(line.pack_type_id)) invalid.push({ line: n, reason: 'PACK_TYPE_NOT_FOUND' });
      else if (!Number.isSafeInteger(line.counted_quantity) || line.counted_quantity < 0 || line.counted_quantity > MAX_COUNTED) {
        invalid.push({ line: n, reason: 'QUANTITY_INVALID' });
      }
      seen.add(line.pack_type_id);
    });
    for (const w of window) {
      const required = w.expectedQuantity !== 0 || w.issued !== 0 || w.returned !== 0 || w.sold !== 0 || w.voidedBack !== 0 || w.other !== 0;
      if (required && !seen.has(w.packTypeId)) invalid.push({ pack_type_id: w.packTypeId, reason: 'LINE_MISSING' });
    }
    if (invalid.length > 0) throw new FieldError('INVALID_LINES', 'Some lines are missing or not valid. Nothing was saved.', invalid);
    return dto.lines;
  }

  /** The audit row and the result. Ids, counts and totals only: never the note or any name. */
  private async finish(
    dto: CloseSettlementDto,
    actor: SettlementActor,
    locationId: string,
    attendant: string,
    figures: WindowFigures,
    cashCents: bigint,
    cashVariance: string,
    rows: SettlementLineRow[],
  ) {
    await this.audit.record({
      action: 'settlement.closed',
      targetType: 'field_settlement',
      targetId: dto.settlement_id,
      metadata: {
        settlement_id: dto.settlement_id,
        attendant_membership_id: attendant,
        location_id: locationId,
        sale_count: figures.saleCount,
        expected_cash: figures.expectedCash,
        cash_received: fromCents(cashCents),
        cash_variance: cashVariance,
        variance_lines: rows.filter((r) => r.variance !== 0).length,
      },
      actorMembershipId: actor.membershipId,
    });
    return {
      settlementId: dto.settlement_id,
      cashVariance,
      lines: dto.lines.map((l) => ({ packTypeId: l.pack_type_id, variance: rows.find((r) => r.packTypeId === l.pack_type_id)!.variance })),
    };
  }

  /** GET /v1/field/settlements: newest first, signed cursor bound to the location filter. */
  async list(query: ListSettlementsQueryDto) {
    const filters: CursorValues = { location_id: query.location_id ?? null };
    const limit = pageLimit(query.limit);
    let after: { periodEndKey: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      const v = this.cursor.read(LIST_CURSOR, query.cursor);
      const id = cursorUuid(v?.after_id);
      if (!v || typeof v.after_period_end !== 'string' || !id || v.location_id !== filters.location_id) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'The cursor is not valid.');
      }
      after = { periodEndKey: v.after_period_end, id };
    }
    const rows = await this.settlements.list({ locationId: query.location_id ?? null, after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      settlements: page,
      nextCursor: rows.length > limit && last ? this.cursor.sign(LIST_CURSOR, { ...filters, after_period_end: last.periodEndKey, after_id: last.id }) : null,
    };
  }

  /** GET /v1/field/settlements/:id with its lines; 404 for a missing id, another business's, or not a UUID. */
  async detail(id: string) {
    const found = cursorUuid(id) ? await this.settlements.byId(id) : null;
    if (!found) throw new ApiError(404, 'SETTLEMENT_NOT_FOUND', 'Settlement not found.');
    return found;
  }
}

/** Trimmed text, or null when absent or blank. Control characters are refused. */
function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (CONTROL_CHARS.test(value)) throw new FieldError('VALIDATION_FAILED', 'The note contains characters that are not allowed.');
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** limit: default 20; above 100 is quietly capped at 100; 0 is refused. */
function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'limit must be at least 1.');
  return Math.min(n, MAX_LIMIT);
}
