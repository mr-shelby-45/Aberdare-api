import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

// All stock SQL. Every method runs on the current tenant transaction.
// The business_id filters below are in addition to RLS, never instead of it
// (CLAUDE.md rule 6).
@Injectable()
export class StockRepository {
  /**
   * Strict decrease: one conditional statement, no read-then-write
   * (docs/architecture.md section 6). Under READ COMMITTED a concurrent
   * update makes this statement wait for the row lock, then re-check
   * `quantity >= qty` against the newly committed value.
   * Returns the new quantity, or null if there was not enough stock.
   */
  async decreaseIfAvailable(
    locationId: string,
    packTypeId: string,
    qty: number,
  ): Promise<number | null> {
    const rows = await currentTx().$queryRaw<{ quantity: number }[]>`
      UPDATE stock_balance
      SET quantity = quantity - ${qty}::int, updated_at = now()
      WHERE business_id = ${currentBusinessId()}::uuid
        AND location_id = ${locationId}::uuid
        AND pack_type_id = ${packTypeId}::uuid
        AND quantity >= ${qty}::int
      RETURNING quantity`;
    return rows[0]?.quantity ?? null;
  }

  /**
   * Unconditional change (positive or negative), creating the balance row if
   * it does not exist yet. One atomic statement. Returns the new quantity.
   */
  async changeBalance(
    locationId: string,
    packTypeId: string,
    delta: number,
  ): Promise<number> {
    const rows = await currentTx().$queryRaw<{ quantity: number }[]>`
      INSERT INTO stock_balance (business_id, location_id, pack_type_id, quantity)
      VALUES (${currentBusinessId()}::uuid, ${locationId}::uuid, ${packTypeId}::uuid, ${delta}::int)
      ON CONFLICT (business_id, location_id, pack_type_id)
      DO UPDATE SET quantity = stock_balance.quantity + EXCLUDED.quantity, updated_at = now()
      RETURNING quantity`;
    return rows[0].quantity;
  }

  /** Appends a ledger row. Returns its id. */
  async insertMovement(
    locationId: string,
    packTypeId: string,
    quantityChange: number,
  ): Promise<string> {
    const row = await currentTx().stockMovement.create({
      data: {
        businessId: currentBusinessId(),
        locationId,
        packTypeId,
        quantityChange,
      },
      select: { id: true },
    });
    return row.id;
  }

  async insertConversion(
    outMovementId: string,
    inMovementId: string,
  ): Promise<string> {
    const row = await currentTx().stockConversion.create({
      data: { businessId: currentBusinessId(), outMovementId, inMovementId },
      select: { id: true },
    });
    return row.id;
  }

  async findPackType(id: string) {
    return currentTx().packType.findUnique({
      where: { id },
      select: { id: true, productId: true, unitsPerPack: true },
    });
  }

  /** The cached balance, or 0 if no balance row exists yet. */
  async balanceOf(locationId: string, packTypeId: string): Promise<number> {
    const row = await currentTx().stockBalance.findUnique({
      where: {
        businessId_locationId_packTypeId: {
          businessId: currentBusinessId(),
          locationId,
          packTypeId,
        },
      },
      select: { quantity: true },
    });
    return row?.quantity ?? 0;
  }

  /** Sum of all ledger rows for one pool. Must always equal balanceOf(). */
  async movementSum(locationId: string, packTypeId: string): Promise<number> {
    const agg = await currentTx().stockMovement.aggregate({
      where: { locationId, packTypeId },
      _sum: { quantityChange: true },
    });
    return agg._sum.quantityChange ?? 0;
  }
}
