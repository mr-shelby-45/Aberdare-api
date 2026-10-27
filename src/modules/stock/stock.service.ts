import { Injectable } from '@nestjs/common';
import { inTransferLockOrder } from './lock-order.js';
import { StockError } from './stock.error.js';
import { type AdjustReason, MAX_BALANCE, type MovementContext, StockRepository } from './stock.repository.js';

export interface StockChangeResult {
  quantity: number;
}

/** Optional details of a received line, stored on its movement. */
export interface ReceiveDetails {
  unitCost?: string | null;
  note?: string | null;
  reference?: string | null;
}

export interface SaleDecreaseResult {
  quantity: number;
  // The sale took the balance below zero. It is still recorded, because the
  // goods are already gone; the owner reviews it.
  flagged: boolean;
}

export interface ConversionResult {
  conversionId: string;
  outMovementId: string;
  inMovementId: string;
  fromAfter: number;
  toAfter: number;
  unitsAdded: number;
  approvedByMembershipId: string;
}

// Stock rules. Every method must run inside TenantRunner.run(), and writes the
// balance change and its ledger row in that same transaction.
@Injectable()
export class StockService {
  constructor(private readonly repo: StockRepository) {}

  /**
   * Whether stock has ever moved for this pack type. Once it has, its
   * units_per_pack is locked (docs/phase-b-design.md section 4). The caller
   * holds a lock on the pack type row, so no movement can be added meanwhile.
   */
  async hasMovements(packTypeId: string): Promise<boolean> {
    return this.repo.hasMovements(packTypeId);
  }

  /** One line of a delivery: not strict (a negative pool can be refilled), capped at MAX_BALANCE. */
  async receive(
    locationId: string,
    packTypeId: string,
    qty: number,
    ctx: MovementContext,
    details: ReceiveDetails = {},
  ): Promise<StockChangeResult> {
    assertPositiveWholeNumber(qty);
    const quantity = withinLimit(await this.repo.changeBalance(locationId, packTypeId, qty));
    await this.repo.insertMovement(
      {
        locationId,
        packTypeId,
        quantityChange: qty,
        movementType: 'RECEIVE',
        quantityAfter: quantity,
        unitCost: details.unitCost ?? null,
        note: details.note ?? null,
        reference: details.reference ?? null,
      },
      ctx,
    );
    return { quantity };
  }

  /**
   * stock.adjust: a decrease is strict (one conditional statement, never
   * below zero), an increase is capped at MAX_BALANCE. The caller has
   * already checked that the sign fits the reason; the database checks it too.
   */
  async adjust(
    locationId: string,
    packTypeId: string,
    change: number,
    reason: AdjustReason,
    note: string | null,
    ctx: MovementContext,
  ): Promise<StockChangeResult> {
    if (!Number.isSafeInteger(change) || change === 0) {
      throw new StockError('STOCK_QUANTITY_INVALID', 'The change must be a whole number other than zero');
    }
    let quantity: number;
    if (change < 0) {
      const left = await this.repo.decreaseIfAvailable(locationId, packTypeId, -change);
      if (left === null) throw new StockError('STOCK_INSUFFICIENT', 'Not enough stock');
      quantity = left;
    } else {
      quantity = withinLimit(await this.repo.changeBalance(locationId, packTypeId, change));
    }
    await this.repo.insertMovement(
      { locationId, packTypeId, quantityChange: change, movementType: 'ADJUST', quantityAfter: quantity, reason, note },
      ctx,
    );
    return { quantity };
  }

  /**
   * For stock.adjust decreases: refuses to go below zero. The spike's minimal
   * adjust has no reason, so it records CORRECTION (decided in C1) until C2
   * replaces it with the real stock.adjust.
   */
  async decreaseStrict(
    locationId: string,
    packTypeId: string,
    qty: number,
    ctx: MovementContext,
    reason: AdjustReason = 'CORRECTION',
  ): Promise<StockChangeResult> {
    assertPositiveWholeNumber(qty);
    const quantity = await this.repo.decreaseIfAvailable(
      locationId,
      packTypeId,
      qty,
    );
    if (quantity === null) {
      throw new StockError('STOCK_INSUFFICIENT', 'Not enough stock');
    }
    await this.repo.insertMovement(
      { locationId, packTypeId, quantityChange: -qty, movementType: 'ADJUST', quantityAfter: quantity, reason },
      ctx,
    );
    return { quantity };
  }

  /**
   * One line of a count (docs/phase-c-design.md section 5): applies
   * counted minus expected, the phone's expected number, never the server
   * balance, with the non-strict statement. Sales processed between the count
   * and its arrival are therefore kept. A zero delta writes nothing; its
   * quantity is a plain read with no write after it (decided in C3).
   */
  async count(
    locationId: string,
    packTypeId: string,
    expected: number,
    counted: number,
    note: string | null,
    ctx: MovementContext,
  ): Promise<StockChangeResult & { delta: number }> {
    const delta = counted - expected;
    if (!Number.isSafeInteger(delta)) {
      throw new StockError('STOCK_QUANTITY_INVALID', 'Counts must be whole numbers');
    }
    if (delta === 0) {
      return { quantity: await this.repo.balanceOf(locationId, packTypeId), delta };
    }
    const quantity = withinLimit(await this.repo.changeBalance(locationId, packTypeId, delta));
    await this.repo.insertMovement(
      {
        locationId,
        packTypeId,
        quantityChange: delta,
        movementType: 'COUNT',
        quantityAfter: quantity,
        expectedQuantity: expected,
        countedQuantity: counted,
        note,
      },
      ctx,
    );
    return { quantity, delta };
  }

  /** For the sync snapshot (Phase D2): every balance row, zero and negative too, in id order. */
  async balancesPageForSync(afterId: string | null, limit: number, locationIds: string[] | null = null) {
    return this.repo.balancesPageForSync(afterId, limit, locationIds);
  }

  /** For sync changes (Phase D3): these balance rows as they are now; missing ones are absent. */
  async balancesByIdsForSync(ids: string[], locationIds: string[] | null = null) {
    return this.repo.balancesByIdsForSync(ids, locationIds);
  }

  /**
   * Phase E2, step 1 of a sale's stock: the sale-mode balance statement for
   * each line, in the order given (the caller sorts with inLockOrder). Never
   * refuses: the goods are already gone, so a pool may go below zero. Returns
   * each line's balance afterwards, in the same order. The ledger rows are
   * written by recordSaleMovements() in the SAME transaction, once the sale
   * row exists (its number comes from the counter, which must come after
   * these statements; decided in E2). Used only together.
   */
  async saleDecreases(locationId: string, lines: { packTypeId: string; quantity: number }[]): Promise<number[]> {
    const after: number[] = [];
    // One after another: queries on one transaction cannot run in parallel.
    for (const line of lines) {
      assertPositiveWholeNumber(line.quantity);
      after.push(withinLimit(await this.repo.changeBalance(locationId, line.packTypeId, -line.quantity)));
    }
    return after;
  }

  /** Phase E2, step 2: one SALE movement per line, with the balance from saleDecreases(). */
  async recordSaleMovements(
    saleId: string,
    locationId: string,
    lines: { packTypeId: string; quantity: number; quantityAfter: number }[],
    ctx: MovementContext,
  ): Promise<void> {
    for (const line of lines) {
      await this.repo.insertMovement(
        { locationId, packTypeId: line.packTypeId, quantityChange: -line.quantity, movementType: 'SALE', quantityAfter: line.quantityAfter, saleId },
        ctx,
      );
    }
  }

  /**
   * Phase E5, sale.void: puts each line back at the sale's location, in the
   * order given (the caller sorts them in the lock order), with one SALE_VOID
   * movement per line pointing at the sale. Never refuses (an increase may
   * fill a negative pool); only the MAX_BALANCE cap can stop it.
   */
  async returnForVoid(saleId: string, locationId: string, lines: { packTypeId: string; quantity: number }[], ctx: MovementContext): Promise<void> {
    // One after another: queries on one transaction cannot run in parallel.
    for (const line of lines) {
      assertPositiveWholeNumber(line.quantity);
      const quantityAfter = withinLimit(await this.repo.changeBalance(locationId, line.packTypeId, line.quantity));
      await this.repo.insertMovement(
        { locationId, packTypeId: line.packTypeId, quantityChange: line.quantity, movementType: 'SALE_VOID', quantityAfter, saleId },
        ctx,
      );
    }
  }

  /**
   * Phase T3: moves lines from one location to another in one transaction
   * (docs/phase-t-design.md section 5). The transfer row first (the
   * movements point at it); then every balance statement of both locations
   * in the global lock order (inTransferLockOrder: location id, then the pack
   * order), the source a strict decrease (STOCK_INSUFFICIENT rolls the whole
   * command back), the destination the capped non-strict increase; each with
   * its TRANSFER_OUT or TRANSFER_IN movement. Results in the lines' order.
   */
  async transfer(
    fromLocationId: string,
    toLocationId: string,
    lines: { packTypeId: string; quantity: number; unitsPerPack: number }[],
    ctx: { occurredAt: Date; createdByMembershipId: string; syncCommandId: string },
    transfer: { kind: 'ISSUE' | 'RETURN'; reference: string | null; note: string | null },
  ): Promise<{ transferId: string; lines: { packTypeId: string; fromAfter: number; toAfter: number }[] }> {
    for (const line of lines) assertPositiveWholeNumber(line.quantity);
    const transferId = await this.repo.insertTransfer({ ...transfer, fromLocationId, toLocationId }, ctx);
    const steps = lines.flatMap((l) => [
      { locationId: fromLocationId, packTypeId: l.packTypeId, unitsPerPack: l.unitsPerPack, quantity: l.quantity, out: true },
      { locationId: toLocationId, packTypeId: l.packTypeId, unitsPerPack: l.unitsPerPack, quantity: l.quantity, out: false },
    ]);
    const after = new Map<string, number>();
    // One after another: queries on one transaction cannot run in parallel.
    for (const step of inTransferLockOrder(steps)) {
      let quantityAfter: number;
      if (step.out) {
        const left = await this.repo.decreaseIfAvailable(step.locationId, step.packTypeId, step.quantity);
        if (left === null) throw new StockError('STOCK_INSUFFICIENT', 'Not enough stock at the source location.');
        quantityAfter = left;
      } else {
        quantityAfter = withinLimit(await this.repo.changeBalance(step.locationId, step.packTypeId, step.quantity));
      }
      await this.repo.insertMovement(
        {
          locationId: step.locationId,
          packTypeId: step.packTypeId,
          quantityChange: step.out ? -step.quantity : step.quantity,
          movementType: step.out ? 'TRANSFER_OUT' : 'TRANSFER_IN',
          quantityAfter,
          transferId,
        },
        ctx,
      );
      after.set(`${step.out ? 'out' : 'in'}:${step.packTypeId}`, quantityAfter);
    }
    return {
      transferId,
      lines: lines.map((l) => ({ packTypeId: l.packTypeId, fromAfter: after.get(`out:${l.packTypeId}`)!, toAfter: after.get(`in:${l.packTypeId}`)! })),
    };
  }

  // Phase T4: the settlement's stock work (docs/phase-t-design.md section 6).

  async balancesAt(locationId: string) {
    return this.repo.balancesAt(locationId);
  }

  async lockBalance(balanceId: string): Promise<number | null> {
    return this.repo.lockBalance(balanceId);
  }

  async windowFlows(locationId: string, snapshot: string, previous: string | null) {
    return this.repo.windowFlows(locationId, snapshot, previous);
  }

  /**
   * Sets a field balance to the counted quantity in one statement and, for a
   * nonzero difference, writes an ADJUST movement (LOST when negative, FOUND
   * when positive) with the settlement's id. Returns the expected quantity
   * (the balance before) and the difference.
   */
  async settleCount(
    locationId: string,
    packTypeId: string,
    counted: number,
    ctx: MovementContext,
    settlement: { settlementId: string; note: string },
  ): Promise<{ expected: number; variance: bigint }> {
    const r = await this.repo.setCounted(locationId, packTypeId, counted);
    if (!r) throw new StockError('PACK_TYPE_NOT_FOUND', 'This pack type has no stock at the location.');
    const delta = BigInt(r.delta);
    if (delta !== 0n) {
      // quantity_change is an int: a difference beyond the balance limits cannot be recorded.
      if (delta > BigInt(MAX_BALANCE) || delta < BigInt(-MAX_BALANCE)) {
        throw new StockError('VALIDATION_FAILED', 'This count is too far from the stock to record.');
      }
      await this.repo.insertMovement(
        {
          locationId,
          packTypeId,
          quantityChange: Number(delta),
          movementType: 'ADJUST',
          quantityAfter: counted,
          reason: delta < 0n ? 'LOST' : 'FOUND',
          note: settlement.note,
          settlementId: settlement.settlementId,
        },
        ctx,
      );
    }
    return { expected: r.expected, variance: delta };
  }

  /** For sale.create from sync: always records the sale, flags an oversell. */
  async decreaseForSale(
    locationId: string,
    packTypeId: string,
    qty: number,
    ctx: MovementContext,
  ): Promise<SaleDecreaseResult> {
    assertPositiveWholeNumber(qty);
    // A decrease never reaches the upper limit, so this is never null.
    const quantity = withinLimit(await this.repo.changeBalance(locationId, packTypeId, -qty));
    await this.repo.insertMovement(
      { locationId, packTypeId, quantityChange: -qty, movementType: 'SALE', quantityAfter: quantity },
      ctx,
    );
    return { quantity, flagged: quantity < 0 };
  }

  /**
   * Break bulk (docs/phase-c-design.md section 5): `quantity` packs of the
   * larger pack type become quantity x ratio of the smaller one, at one
   * location, in one transaction. Both pack types must be of the same product,
   * larger to smaller, with an even ratio. The source decrease is strict. The
   * larger pack is changed first: the lock order of every multi-balance
   * operation (docs/architecture.md section 6). The approver defaults to the
   * creator (a manager or owner converting for themselves); C5 passes the
   * approver and approval of an attendant's conversion.
   */
  async convert(
    locationId: string,
    fromPackTypeId: string,
    toPackTypeId: string,
    quantity: number,
    ctx: MovementContext,
    options: { note?: string | null; approvedByMembershipId?: string; approvalId?: string | null } = {},
  ): Promise<ConversionResult> {
    const actor = ctx.createdByMembershipId;
    if (!actor) throw new Error('StockService.convert: a conversion needs the acting membership');
    assertPositiveWholeNumber(quantity);
    // Queries on one transaction run one after another, so no Promise.all.
    const from = await this.repo.findPackType(fromPackTypeId);
    const to = await this.repo.findPackType(toPackTypeId);
    if (!from || !to) throw new StockError('PACK_TYPE_NOT_FOUND', 'Pack type not found.');
    if (from.productId !== to.productId || from.unitsPerPack <= to.unitsPerPack) {
      throw new StockError(
        'PACK_TYPES_NOT_CONVERTIBLE',
        'Only a larger pack of a product can be broken into a smaller pack of the same product.',
      );
    }
    if (from.unitsPerPack % to.unitsPerPack !== 0) {
      throw new StockError('CONVERSION_RATIO_INVALID', 'The larger pack does not divide evenly into the smaller pack.');
    }
    const unitsAdded = quantity * (from.unitsPerPack / to.unitsPerPack);
    if (unitsAdded > MAX_BALANCE) withinLimit(null);
    const note = options.note ?? null;

    const fromAfter = await this.repo.decreaseIfAvailable(locationId, fromPackTypeId, quantity);
    if (fromAfter === null) {
      throw new StockError('STOCK_INSUFFICIENT', 'Not enough packs to break');
    }
    const outMovementId = await this.repo.insertMovement(
      { locationId, packTypeId: fromPackTypeId, quantityChange: -quantity, movementType: 'CONVERT_OUT', quantityAfter: fromAfter, note },
      ctx,
    );
    const toAfter = withinLimit(await this.repo.changeBalance(locationId, toPackTypeId, unitsAdded));
    const inMovementId = await this.repo.insertMovement(
      { locationId, packTypeId: toPackTypeId, quantityChange: unitsAdded, movementType: 'CONVERT_IN', quantityAfter: toAfter, note },
      ctx,
    );
    const approvedByMembershipId = options.approvedByMembershipId ?? actor;
    const conversionId = await this.repo.insertConversion({
      outMovementId,
      inMovementId,
      createdByMembershipId: actor,
      approvedByMembershipId,
      approvalId: options.approvalId ?? null,
    });
    return { conversionId, outMovementId, inMovementId, fromAfter, toAfter, unitsAdded, approvedByMembershipId };
  }
}

/** The new balance, or VALIDATION_FAILED when the limited statement changed nothing. */
function withinLimit(quantity: number | null): number {
  const limit = MAX_BALANCE.toLocaleString('en-US');
  if (quantity === null) {
    throw new StockError('VALIDATION_FAILED', `A stock balance must stay between -${limit} and ${limit}`);
  }
  return quantity;
}

// Quantities are whole numbers for now (CLAUDE.md rule 8).
function assertPositiveWholeNumber(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new StockError(
      'STOCK_QUANTITY_INVALID',
      'Quantity must be a whole number greater than zero',
    );
  }
}
