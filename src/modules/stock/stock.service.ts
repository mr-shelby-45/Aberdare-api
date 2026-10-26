import { Injectable } from '@nestjs/common';
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
  toQuantity: number;
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
   * Break bulk: one pack of fromPackType becomes N of toPackType. Strict. The
   * creator is also the approver here (a manager converting for themselves);
   * C4 and C5 add the real stock.convert and approvals.
   */
  async convertOne(
    locationId: string,
    fromPackTypeId: string,
    toPackTypeId: string,
    ctx: MovementContext,
  ): Promise<ConversionResult> {
    const actor = ctx.createdByMembershipId;
    if (!actor) throw new Error('StockService.convertOne: a conversion needs the acting membership');
    // Queries on one transaction run one after another, so no Promise.all.
    const from = await this.repo.findPackType(fromPackTypeId);
    const to = await this.repo.findPackType(toPackTypeId);
    if (
      !from ||
      !to ||
      from.productId !== to.productId ||
      from.unitsPerPack <= to.unitsPerPack ||
      from.unitsPerPack % to.unitsPerPack !== 0
    ) {
      throw new StockError(
        'STOCK_CONVERSION_INVALID',
        'These pack types cannot be converted into each other',
      );
    }
    const toQuantity = from.unitsPerPack / to.unitsPerPack;

    const left = await this.repo.decreaseIfAvailable(
      locationId,
      fromPackTypeId,
      1,
    );
    if (left === null) {
      throw new StockError('STOCK_INSUFFICIENT', 'No pack left to break');
    }
    const outMovementId = await this.repo.insertMovement(
      { locationId, packTypeId: fromPackTypeId, quantityChange: -1, movementType: 'CONVERT_OUT', quantityAfter: left },
      ctx,
    );
    const toAfter = withinLimit(await this.repo.changeBalance(locationId, toPackTypeId, toQuantity));
    const inMovementId = await this.repo.insertMovement(
      { locationId, packTypeId: toPackTypeId, quantityChange: toQuantity, movementType: 'CONVERT_IN', quantityAfter: toAfter },
      ctx,
    );
    const conversionId = await this.repo.insertConversion({
      outMovementId,
      inMovementId,
      createdByMembershipId: actor,
      approvedByMembershipId: actor,
    });
    return { conversionId, outMovementId, inMovementId, toQuantity };
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
