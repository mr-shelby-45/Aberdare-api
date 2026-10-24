import { Injectable } from '@nestjs/common';
import { StockError } from './stock.error.js';
import { StockRepository } from './stock.repository.js';

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

  async receive(
    locationId: string,
    packTypeId: string,
    qty: number,
  ): Promise<StockChangeResult> {
    assertPositiveWholeNumber(qty);
    const quantity = await this.repo.changeBalance(locationId, packTypeId, qty);
    await this.repo.insertMovement(locationId, packTypeId, qty);
    return { quantity };
  }

  /** For stock.adjust decreases: refuses to go below zero. */
  async decreaseStrict(
    locationId: string,
    packTypeId: string,
    qty: number,
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
    await this.repo.insertMovement(locationId, packTypeId, -qty);
    return { quantity };
  }

  /** For sale.create from sync: always records the sale, flags an oversell. */
  async decreaseForSale(
    locationId: string,
    packTypeId: string,
    qty: number,
  ): Promise<SaleDecreaseResult> {
    assertPositiveWholeNumber(qty);
    const quantity = await this.repo.changeBalance(
      locationId,
      packTypeId,
      -qty,
    );
    await this.repo.insertMovement(locationId, packTypeId, -qty);
    return { quantity, flagged: quantity < 0 };
  }

  /** Break bulk: one pack of fromPackType becomes N of toPackType. Strict. */
  async convertOne(
    locationId: string,
    fromPackTypeId: string,
    toPackTypeId: string,
  ): Promise<ConversionResult> {
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
      locationId,
      fromPackTypeId,
      -1,
    );
    await this.repo.changeBalance(locationId, toPackTypeId, toQuantity);
    const inMovementId = await this.repo.insertMovement(
      locationId,
      toPackTypeId,
      toQuantity,
    );
    const conversionId = await this.repo.insertConversion(
      outMovementId,
      inMovementId,
    );
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
