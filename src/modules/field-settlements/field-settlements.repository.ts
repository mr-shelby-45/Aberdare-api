import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

/** A settlement as reads show it. Money as canonical text. */
export interface SettlementRow {
  id: string;
  fieldLocationId: string;
  attendantMembershipId: string;
  closedByMembershipId: string;
  occurredAt: Date;
  receivedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  // period_end as Postgres text (microseconds kept), for the list cursor.
  periodEndKey: string;
  expectedCash: string;
  cashReceived: string;
  cashVariance: string;
  mpesaVerifiedTotal: string;
  mpesaUnverifiedTotal: string;
  saleCount: number;
  voidedCount: number;
  unpaidTotal: string;
  earlierSalesCash: string;
  note: string | null;
}

export interface SettlementLineRow {
  packTypeId: string;
  issued: number;
  returned: number;
  sold: number;
  voidedBack: number;
  expectedQuantity: number;
  countedQuantity: number;
  variance: number;
}

export interface SettlementInsert {
  id: string;
  sequence: number;
  fieldLocationId: string;
  attendantMembershipId: string;
  closedByMembershipId: string;
  syncCommandId: string;
  occurredAt: Date;
  receivedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  expectedCash: string;
  cashReceived: string;
  cashVariance: string;
  mpesaVerifiedTotal: string;
  mpesaUnverifiedTotal: string;
  saleCount: number;
  voidedCount: number;
  unpaidTotal: string;
  earlierSalesCash: string;
  snapshot: string;
  note: string | null;
}

interface RawSettlement {
  id: string;
  field_location_id: string;
  attendant_membership_id: string;
  closed_by_membership_id: string;
  occurred_at: Date;
  received_at: Date;
  period_start: Date;
  period_end: Date;
  period_end_key: string;
  expected_cash: string;
  cash_received: string;
  cash_variance: string;
  mpesa_verified_total: string;
  mpesa_unverified_total: string;
  sale_count: number;
  voided_count: number;
  unpaid_total: string;
  earlier_sales_cash: string;
  note: string | null;
}

// field_settlement and field_settlement_line SQL (Phase T4), on the current
// tenant transaction. app_user may only read and insert: a settlement is
// final (docs/phase-t-design.md section 6).
@Injectable()
export class FieldSettlementsRepository {
  async exists(id: string): Promise<boolean> {
    return (await currentTx().fieldSettlement.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  /**
   * The location's latest settlement: the highest sequence (fix found in T5:
   * period_end can tie, or be earlier for a close that waited for the lock
   * and committed later). Its sequence, period_end and snapshot, or null.
   */
  async latest(fieldLocationId: string): Promise<{ sequence: number; periodEnd: Date; snapshot: string } | null> {
    return currentTx().fieldSettlement.findFirst({
      where: { fieldLocationId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, periodEnd: true, snapshot: true },
    });
  }

  /** The database snapshot now, as text (pg_current_snapshot()). */
  async currentSnapshot(): Promise<string> {
    const rows = await currentTx().$queryRaw<{ s: string }[]>`SELECT pg_current_snapshot()::text AS s`;
    return rows[0].s;
  }

  async insert(s: SettlementInsert): Promise<void> {
    await currentTx().fieldSettlement.create({ data: { businessId: currentBusinessId(), ...s }, select: { id: true } });
  }

  async insertLines(settlementId: string, lines: SettlementLineRow[]): Promise<void> {
    if (lines.length === 0) return;
    await currentTx().fieldSettlementLine.createMany({
      data: lines.map((l) => ({ businessId: currentBusinessId(), settlementId, ...l, variance: BigInt(l.variance) })),
    });
  }

  /** Newest first by (period_end, id), optionally for one location. */
  async list(f: { locationId: string | null; after: { periodEndKey: string; id: string } | null; limit: number }): Promise<SettlementRow[]> {
    const rows = await currentTx().$queryRaw<RawSettlement[]>`
      SELECT id, field_location_id, attendant_membership_id, closed_by_membership_id, occurred_at, received_at,
             period_start, period_end, period_end::text AS period_end_key, expected_cash::text AS expected_cash,
             cash_received::text AS cash_received, cash_variance::text AS cash_variance,
             mpesa_verified_total::text AS mpesa_verified_total, mpesa_unverified_total::text AS mpesa_unverified_total,
             sale_count, voided_count, unpaid_total::text AS unpaid_total, earlier_sales_cash::text AS earlier_sales_cash, note
        FROM field_settlement
       WHERE business_id = ${currentBusinessId()}::uuid
         AND (${f.locationId}::uuid IS NULL OR field_location_id = ${f.locationId}::uuid)
         AND (${f.after?.periodEndKey ?? null}::timestamptz IS NULL
              OR (period_end, id) < (${f.after?.periodEndKey ?? null}::timestamptz, ${f.after?.id ?? null}::uuid))
       ORDER BY period_end DESC, id DESC
       LIMIT ${f.limit}::int`;
    return rows.map(settlementRow);
  }

  async byId(id: string): Promise<{ settlement: SettlementRow; lines: SettlementLineRow[] } | null> {
    const rows = await currentTx().$queryRaw<RawSettlement[]>`
      SELECT id, field_location_id, attendant_membership_id, closed_by_membership_id, occurred_at, received_at,
             period_start, period_end, period_end::text AS period_end_key, expected_cash::text AS expected_cash,
             cash_received::text AS cash_received, cash_variance::text AS cash_variance,
             mpesa_verified_total::text AS mpesa_verified_total, mpesa_unverified_total::text AS mpesa_unverified_total,
             sale_count, voided_count, unpaid_total::text AS unpaid_total, earlier_sales_cash::text AS earlier_sales_cash, note
        FROM field_settlement WHERE id = ${id}::uuid AND business_id = ${currentBusinessId()}::uuid`;
    if (rows.length === 0) return null;
    const lines = await currentTx().fieldSettlementLine.findMany({
      where: { settlementId: id },
      orderBy: { packTypeId: 'asc' },
      select: { packTypeId: true, issued: true, returned: true, sold: true, voidedBack: true, expectedQuantity: true, countedQuantity: true, variance: true },
    });
    return { settlement: settlementRow(rows[0]), lines: lines.map((l) => ({ ...l, variance: Number(l.variance) })) };
  }
}

function settlementRow(r: RawSettlement): SettlementRow {
  return {
    id: r.id,
    fieldLocationId: r.field_location_id,
    attendantMembershipId: r.attendant_membership_id,
    closedByMembershipId: r.closed_by_membership_id,
    occurredAt: r.occurred_at,
    receivedAt: r.received_at,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodEndKey: r.period_end_key,
    expectedCash: r.expected_cash,
    cashReceived: r.cash_received,
    cashVariance: r.cash_variance,
    mpesaVerifiedTotal: r.mpesa_verified_total,
    mpesaUnverifiedTotal: r.mpesa_unverified_total,
    saleCount: r.sale_count,
    voidedCount: r.voided_count,
    unpaidTotal: r.unpaid_total,
    earlierSalesCash: r.earlier_sales_cash,
    note: r.note,
  };
}
