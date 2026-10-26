import { Injectable } from '@nestjs/common';
import { StockError } from './stock.error.js';
import { type AdjustReason, type MovementContext, StockRepository } from './stock.repository.js';

export interface StockChangeResult {
  quantity: number;
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

  async receive(
    locationId: string,
    packTypeId: string,
    qty: number,
    ctx: MovementContext,
  ): Promise<StockChangeResult> {
    assertPositiveWholeNumber(qty);
    const quantity = await this.repo.changeBalance(locationId, packTypeId, qty);
    await this.repo.insertMovement(
      { locationId, packTypeId, quantityChange: qty, movementType: 'RECEIVE', quantityAfter: quantity },
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

  /** For sale.create from sync: always records the sale, flags an oversell. */
  async decreaseForSale(
    locationId: string,
    packTypeId: string,
    qty: number,
    ctx: MovementContext,
  ): Promise<SaleDecreaseResult> {
    assertPositiveWholeNumber(qty);
    const quantity = await this.repo.changeBalance(
      locationId,
      packTypeId,
      -qty,
    );
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
    const toAfter = await this.repo.changeBalance(locationId, toPackTypeId, toQuantity);
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

// Quantities are whole numbers for now (CLAUDE.md rule 8).
function assertPositiveWholeNumber(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new StockError(
      'STOCK_QUANTITY_INVALID',
      'Quantity must be a whole number greater than zero',
    );
  }
}
