import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export const MOVEMENT_TYPES = ['RECEIVE', 'ADJUST', 'COUNT', 'CONVERT_OUT', 'CONVERT_IN', 'SALE'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export const ADJUST_REASONS = ['DAMAGED', 'EXPIRED', 'LOST', 'FOUND', 'SUPPLIER_RETURN', 'CORRECTION', 'OTHER'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

/** Who and when, for every movement (docs/phase-c-design.md section 3). */
export interface MovementContext {
  // Phone time.
  occurredAt: Date;
  createdByMembershipId: string | null;
  // The sync_command row (its id, not the phone's command_id).
  syncCommandId: string | null;
}

export interface MovementRow {
  locationId: string;
  packTypeId: string;
  quantityChange: number;
  movementType: MovementType;
  quantityAfter: number;
  reason?: AdjustReason | null;
  // RECEIVE only. A canonical money string ("120.50"), never a number.
  unitCost?: string | null;
  note?: string | null;
  reference?: string | null;
  // COUNT only, both: quantity_change = counted - expected (a database check).
  expectedQuantity?: number | null;
  countedQuantity?: number | null;
}

// The largest balance a pool may hold, either way (docs/phase-c-design.md section 4; floor since C3): an
// INTEGER guard with room to spare.
export const MAX_BALANCE = 2_000_000_000;

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
   * Non-strict change (positive or negative), creating the balance row if it
   * does not exist yet. One atomic statement. Returns the new quantity, or
   * null if it would leave -MAX_BALANCE..MAX_BALANCE (then nothing changed).
   * The limits are part of the statement (cap C2, floor C3), so they hold
   * under concurrency too. The check adds as bigint: a count delta can be up
   * to 2,000,000,000, and the sum must not overflow before it is compared.
   * In ON CONFLICT DO UPDATE the WHERE is checked before SET is computed.
   */
  async changeBalance(
    locationId: string,
    packTypeId: string,
    delta: number,
  ): Promise<number | null> {
    const rows = await currentTx().$queryRaw<{ quantity: number }[]>`
      INSERT INTO stock_balance (business_id, location_id, pack_type_id, quantity)
      VALUES (${currentBusinessId()}::uuid, ${locationId}::uuid, ${packTypeId}::uuid, ${delta}::int)
      ON CONFLICT (business_id, location_id, pack_type_id)
      DO UPDATE SET quantity = stock_balance.quantity + EXCLUDED.quantity, updated_at = now()
       WHERE stock_balance.quantity::bigint + EXCLUDED.quantity
             BETWEEN ${-MAX_BALANCE}::bigint AND ${MAX_BALANCE}::bigint
      RETURNING quantity`;
    return rows[0]?.quantity ?? null;
  }

  /**
   * Appends a ledger row. Returns its id. quantityAfter is the balance the
   * balance statement just returned, in the same transaction.
   */
  async insertMovement(movement: MovementRow, ctx: MovementContext): Promise<string> {
    const row = await currentTx().stockMovement.create({
      data: {
        businessId: currentBusinessId(),
        locationId: movement.locationId,
        packTypeId: movement.packTypeId,
        quantityChange: movement.quantityChange,
        movementType: movement.movementType,
        quantityAfter: movement.quantityAfter,
        reason: movement.reason ?? null,
        unitCost: movement.unitCost ?? null,
        note: movement.note ?? null,
        reference: movement.reference ?? null,
        expectedQuantity: movement.expectedQuantity ?? null,
        countedQuantity: movement.countedQuantity ?? null,
        occurredAt: ctx.occurredAt,
        createdByMembershipId: ctx.createdByMembershipId,
        syncCommandId: ctx.syncCommandId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async insertConversion(conversion: {
    outMovementId: string;
    inMovementId: string;
    createdByMembershipId: string;
    approvedByMembershipId: string;
  }): Promise<string> {
    const row = await currentTx().stockConversion.create({
      data: { businessId: currentBusinessId(), ...conversion },
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

  /**
   * Every pool whose cached balance differs from the sum of its movements,
   * including a balance with no movements and movements with no balance
   * (docs/phase-c-design.md section 3). Only this business's rows: RLS, plus
   * the explicit filter. Sums are read as text, so a large total never
   * passes through a JavaScript number before it is checked.
   */
  async integrityMismatches(): Promise<{ locationId: string; packTypeId: string; balance: string | null; ledgerSum: string | null }[]> {
    const business = currentBusinessId();
    const rows = await currentTx().$queryRaw<
      { location_id: string; pack_type_id: string; balance: string | null; ledger_sum: string | null }[]
    >`
      WITH b AS (
        SELECT location_id, pack_type_id, quantity::bigint AS quantity
          FROM stock_balance WHERE business_id = ${business}::uuid
      ), m AS (
        SELECT location_id, pack_type_id, sum(quantity_change)::bigint AS total
          FROM stock_movement WHERE business_id = ${business}::uuid
         GROUP BY location_id, pack_type_id
      )
      SELECT coalesce(b.location_id, m.location_id) AS location_id,
             coalesce(b.pack_type_id, m.pack_type_id) AS pack_type_id,
             b.quantity::text AS balance,
             m.total::text AS ledger_sum
        FROM b FULL OUTER JOIN m
          ON b.location_id = m.location_id AND b.pack_type_id = m.pack_type_id
       WHERE b.quantity IS NULL OR m.total IS NULL OR b.quantity <> m.total
       ORDER BY 1, 2`;
    return rows.map((r) => ({ locationId: r.location_id, packTypeId: r.pack_type_id, balance: r.balance, ledgerSum: r.ledger_sum }));
  }

  /** Whether any ledger row exists for this pack type, at any location. */
  async hasMovements(packTypeId: string): Promise<boolean> {
    const row = await currentTx().stockMovement.findFirst({ where: { packTypeId }, select: { id: true } });
    return row !== null;
  }
}
