import { Injectable } from '@nestjs/common';
import { MONEY_PATTERN, normalizeMoney } from '../../common/validation/money.js';
import { AuditService } from '../audit/audit.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { ProductsService } from '../products/products.service.js';
import type { AdjustStockDto } from './dto/adjust-stock.dto.js';
import type { ReceiveLineDto, ReceiveStockDto } from './dto/receive-stock.dto.js';
import { type InvalidLine, StockError, type StockLineReason } from './stock.error.js';
import type { AdjustReason, MovementContext } from './stock.repository.js';
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
    const lockOrder = [...dto.lines].sort((a, b) => {
      const byUnits = packs.get(b.pack_type_id)!.unitsPerPack - packs.get(a.pack_type_id)!.unitsPerPack;
      return byUnits !== 0 ? byUnits : a.pack_type_id < b.pack_type_id ? -1 : 1;
    });
    const after = new Map<string, number>();
    for (const line of lockOrder) {
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
