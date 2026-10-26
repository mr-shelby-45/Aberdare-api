import { Injectable } from '@nestjs/common';
import { MONEY_PATTERN, normalizeMoney } from '../../common/validation/money.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { AuditService } from '../audit/audit.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { ProductsService } from '../products/products.service.js';
import type { AdjustStockDto } from './dto/adjust-stock.dto.js';
import type { ConvertStockDto } from './dto/convert-stock.dto.js';
import type { CountLineDto, CountStockDto } from './dto/count-stock.dto.js';
import type { ReceiveLineDto, ReceiveStockDto } from './dto/receive-stock.dto.js';
import { type InvalidLine, StockError, type StockLineReason } from './stock.error.js';
import { type AdjustReason, MAX_BALANCE, type MovementContext } from './stock.repository.js';
import { StockService } from './stock.service.js';

const MAX_LINE_QUANTITY = 1_000_000;
// Control characters other than tab and line breaks. Postgres text cannot
// hold a NUL, so it would otherwise end as a crash instead of a rejection.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// The sign each reason allows (docs/phase-c-design.md section 3); CORRECTION
// and OTHER go either way. The database checks the same rule.
const REASON_SIGN: Record<AdjustReason, 1 | -1 | 0> = {
  FOUND: 1,
  DAMAGED: -1,
  EXPIRED: -1,
  LOST: -1,
  SUPPLIER_RETURN: -1,
  CORRECTION: 0,
  OTHER: 0,
};

/** Who and which command, for the movements and the audit row. */
export interface StockActor {
  membershipId: string;
  occurredAt: Date;
  syncCommandId: string;
}

// The stock commands' rules (docs/phase-c-design.md sections 4 and 5). Runs
// inside the command's tenant transaction (a savepoint of it): a StockError
// undoes every write of the command, audit row included. Sits above the
// stock, products and locations modules, so none of them imports another.
@Injectable()
export class StockCommandsService {
  constructor(
    private readonly stock: StockService,
    private readonly products: ProductsService,
    private readonly locations: LocationsService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * stock.receive: every line is checked before anything is written, and one
   * bad line rejects the whole delivery with every bad line listed. Balances
   * are then changed larger pack first (then by id), the lock order every
   * multi-balance operation uses, so two deliveries cannot deadlock each
   * other or a conversion. Results come back in the payload's order.
   */
  async receive(dto: ReceiveStockDto, actor: StockActor): Promise<{ packTypeId: string; quantityAfter: number }[]> {
    const reference = cleanText(dto.reference);
    const note = cleanText(dto.note);
    await this.activeLocation(dto.location_id);

    const packs = await this.products.packTypesForStock([...new Set(dto.lines.map((l) => l.pack_type_id))]);
    const invalid: InvalidLine[] = [];
    const seen = new Set<string>();
    dto.lines.forEach((line, i) => {
      const reason = lineProblem(line, seen, packs);
      seen.add(line.pack_type_id);
      if (reason) invalid.push({ line: i + 1, reason });
    });
    if (invalid.length > 0) {
      throw new StockError('INVALID_LINES', 'Some lines of this delivery are not valid. Nothing was saved.', invalid);
    }

    const ctx = movementContext(actor);
    const after = new Map<string, number>();
    for (const line of inLockOrder(dto.lines, packs)) {
      const unitCost = line.unit_cost == null ? null : normalizeMoney(line.unit_cost);
      const { quantity } = await this.stock.receive(dto.location_id, line.pack_type_id, line.quantity, ctx, { unitCost, note, reference });
      after.set(line.pack_type_id, quantity);
    }

    // Ids, quantities and a flag only: never the note, reference or costs.
    await this.audit.record({
      action: 'stock.received',
      targetType: 'location',
      targetId: dto.location_id,
      metadata: {
        location_id: dto.location_id,
        lines: dto.lines.map((l) => ({ pack_type_id: l.pack_type_id, quantity: l.quantity })),
        with_cost: dto.lines.some((l) => l.unit_cost != null),
      },
      actorMembershipId: actor.membershipId,
    });
    return dto.lines.map((l) => ({ packTypeId: l.pack_type_id, quantityAfter: after.get(l.pack_type_id)! }));
  }

  /**
   * stock.count: all or nothing like receive. Each line applies counted
   * minus expected (StockService.count). Archived locations and pack types
   * are allowed. flagged is true when any counted pool ends below zero,
   * including a zero-delta line that was already negative (decided in C3).
   */
  async count(
    dto: CountStockDto,
    actor: StockActor,
  ): Promise<{ lines: { packTypeId: string; delta: number; quantityAfter: number }[]; flagged: boolean }> {
    const note = cleanText(dto.note);
    if (!(await this.locations.findById(dto.location_id))) throw locationNotFound();

    const packs = await this.products.packTypesForStock([...new Set(dto.lines.map((l) => l.pack_type_id))]);
    const invalid: InvalidLine[] = [];
    const seen = new Set<string>();
    dto.lines.forEach((line, i) => {
      const reason = countLineProblem(line, seen, packs);
      seen.add(line.pack_type_id);
      if (reason) invalid.push({ line: i + 1, reason });
    });
    if (invalid.length > 0) {
      throw new StockError('INVALID_LINES', 'Some lines of this count are not valid. Nothing was saved.', invalid);
    }

    const ctx = movementContext(actor);
    const after = new Map<string, { delta: number; quantity: number }>();
    for (const line of inLockOrder(dto.lines, packs)) {
      const r = await this.stock.count(dto.location_id, line.pack_type_id, line.expected_quantity, line.counted_quantity, note, ctx);
      after.set(line.pack_type_id, { delta: r.delta, quantity: r.quantity });
    }
    const lines = dto.lines.map((l) => ({ packTypeId: l.pack_type_id, delta: after.get(l.pack_type_id)!.delta, quantityAfter: after.get(l.pack_type_id)!.quantity }));

    // Ids and quantities only: never the note.
    await this.audit.record({
      action: 'stock.counted',
      targetType: 'location',
      targetId: dto.location_id,
      metadata: {
        location_id: dto.location_id,
        lines: dto.lines.map((l) => ({
          pack_type_id: l.pack_type_id,
          expected: l.expected_quantity,
          counted: l.counted_quantity,
          delta: l.counted_quantity - l.expected_quantity,
        })),
      },
      actorMembershipId: actor.membershipId,
    });
    return { lines, flagged: lines.some((l) => l.quantityAfter < 0) };
  }

  /**
   * stock.convert. Without an approval (C4) the caller has stock.convert and
   * is their own approver. With one (C5: an attendant), the approval is used
   * once and the approver re-checked live; any problem is APPROVAL_INVALID,
   * the same for every cause. The approval is used inside the command's
   * savepoint, so a conversion that then fails leaves it unused. Archived
   * locations and pack types are allowed. The pack type rules, the strict
   * source and the lock order are in StockService.convert.
   */
  async convert(
    dto: ConvertStockDto,
    actor: StockActor,
    approval: { approvalId: string; deviceId: string; receivedAt: Date } | null = null,
  ): Promise<{ fromAfter: number; toAfter: number; unitsAdded: number; approvedByMembershipId: string }> {
    const note = cleanText(dto.note);
    if (!(await this.locations.findById(dto.location_id))) throw locationNotFound();
    let approvedByMembershipId: string | undefined;
    if (approval) {
      const approver = await this.approvals.useForConversion({
        approvalId: approval.approvalId,
        requesterMembershipId: actor.membershipId,
        deviceId: approval.deviceId,
        syncCommandId: actor.syncCommandId,
        occurredAt: actor.occurredAt,
        receivedAt: approval.receivedAt,
      });
      if (!approver) throw new StockError('APPROVAL_INVALID', 'This approval cannot be used. Ask for a new one.');
      approvedByMembershipId = approver;
    }
    const r = await this.stock.convert(dto.location_id, dto.from_pack_type_id, dto.to_pack_type_id, dto.quantity, movementContext(actor), {
      note,
      approvedByMembershipId,
      approvalId: approval?.approvalId ?? null,
    });
    // Ids and numbers only: never the note.
    await this.audit.record({
      action: 'stock.converted',
      targetType: 'location',
      targetId: dto.location_id,
      metadata: {
        location_id: dto.location_id,
        from_pack_type_id: dto.from_pack_type_id,
        to_pack_type_id: dto.to_pack_type_id,
        quantity: dto.quantity,
        units_added: r.unitsAdded,
        approved_by_membership_id: r.approvedByMembershipId,
        approval_id: approval?.approvalId ?? null,
      },
      actorMembershipId: actor.membershipId,
    });
    return r;
  }

  /** stock.adjust: archived locations and pack types are allowed, so old stock can be cleaned up. */
  async adjust(dto: AdjustStockDto, actor: StockActor): Promise<number> {
    const note = cleanText(dto.note);
    const sign = REASON_SIGN[dto.reason];
    if (sign !== 0 && Math.sign(dto.quantity_change) !== sign) {
      throw new StockError(
        'REASON_SIGN_MISMATCH',
        sign > 0 ? 'This reason adds stock; use a positive change.' : 'This reason removes stock; use a negative change.',
      );
    }
    if (!(await this.locations.findById(dto.location_id))) throw locationNotFound();
    const packs = await this.products.packTypesForStock([dto.pack_type_id]);
    if (!packs.has(dto.pack_type_id)) throw new StockError('PACK_TYPE_NOT_FOUND', 'Pack type not found.');

    const { quantity } = await this.stock.adjust(
      dto.location_id,
      dto.pack_type_id,
      dto.quantity_change,
      dto.reason,
      note,
      movementContext(actor),
    );
    await this.audit.record({
      action: 'stock.adjusted',
      targetType: 'pack_type',
      targetId: dto.pack_type_id,
      metadata: {
        location_id: dto.location_id,
        pack_type_id: dto.pack_type_id,
        quantity_change: dto.quantity_change,
        quantity_after: quantity,
        reason: dto.reason,
      },
      actorMembershipId: actor.membershipId,
    });
    return quantity;
  }

  /** New stock only arrives at an active location of this business. */
  private async activeLocation(id: string): Promise<void> {
    const location = await this.locations.findById(id);
    if (!location) throw locationNotFound();
    if (location.archivedAt) throw new StockError('LOCATION_ARCHIVED', 'This location is archived.');
  }
}

/**
 * The first problem of one delivery line, or null. Checked in this order: a
 * repeated pack type, then the pack type, then the quantity, then the cost.
 */
function lineProblem(
  line: ReceiveLineDto,
  seen: ReadonlySet<string>,
  packs: ReadonlyMap<string, { archived: boolean }>,
): StockLineReason | null {
  if (seen.has(line.pack_type_id)) return 'DUPLICATE_LINE';
  const pack = packs.get(line.pack_type_id);
  if (!pack) return 'PACK_TYPE_NOT_FOUND';
  if (pack.archived) return 'PACK_TYPE_ARCHIVED';
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_LINE_QUANTITY) {
    return 'QUANTITY_INVALID';
  }
  if (line.unit_cost != null && !MONEY_PATTERN.test(line.unit_cost)) return 'COST_INVALID';
  return null;
}

/**
 * The first problem of one count line, or null: a repeated pack type, the
 * pack type, then the numbers (decided in C3: counted 0 to MAX_BALANCE,
 * expected and the delta within -MAX_BALANCE..MAX_BALANCE, whole numbers).
 * Archived pack types are allowed.
 */
function countLineProblem(
  line: CountLineDto,
  seen: ReadonlySet<string>,
  packs: ReadonlyMap<string, unknown>,
): StockLineReason | null {
  if (seen.has(line.pack_type_id)) return 'DUPLICATE_LINE';
  if (!packs.has(line.pack_type_id)) return 'PACK_TYPE_NOT_FOUND';
  const { expected_quantity: expected, counted_quantity: counted } = line;
  const inRange = (n: number) => Number.isSafeInteger(n) && Math.abs(n) <= MAX_BALANCE;
  if (!inRange(expected) || !inRange(counted) || counted < 0 || !inRange(counted - expected)) return 'QUANTITY_INVALID';
  return null;
}

/**
 * Lines in the lock order of every multi-balance operation: larger pack
 * first, then by pack type id (docs/architecture.md section 6).
 */
function inLockOrder<T extends { pack_type_id: string }>(lines: T[], packs: ReadonlyMap<string, { unitsPerPack: number }>): T[] {
  return [...lines].sort((a, b) => {
    const byUnits = packs.get(b.pack_type_id)!.unitsPerPack - packs.get(a.pack_type_id)!.unitsPerPack;
    return byUnits !== 0 ? byUnits : a.pack_type_id < b.pack_type_id ? -1 : 1;
  });
}

/** Trimmed text, or null when absent or blank. Control characters are refused. */
function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (CONTROL_CHARS.test(value)) {
    throw new StockError('VALIDATION_FAILED', 'The note or reference contains characters that are not allowed.');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function movementContext(actor: StockActor): MovementContext {
  return { occurredAt: actor.occurredAt, createdByMembershipId: actor.membershipId, syncCommandId: actor.syncCommandId };
}

function locationNotFound(): StockError {
  // The same for another business's location and one that does not exist.
  return new StockError('LOCATION_NOT_FOUND', 'Location not found.');
}
