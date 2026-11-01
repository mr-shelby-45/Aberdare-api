import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export type SalesGroupBy = 'day' | 'attendant' | 'location';

/** Sums of completed sales; money as NUMERIC text ("1234.50"), never a number. */
export interface SalesSums {
  saleCount: number;
  total: string;
  paidTotal: string;
  balanceDue: string;
}

/** One group of the sales report: a Nairobi date, a membership id or a location id. */
export interface SalesGroupRow extends SalesSums {
  key: string;
  // The location's name when grouped by location; otherwise null.
  locationName: string | null;
}

/** Recorded payments of completed sales by method; money as NUMERIC text. */
export interface PaymentSplit {
  cash: string;
  mpesaUnverified: string;
  mpesaVerified: string;
}

export interface SalesReportRows {
  totals: SalesSums;
  rows: SalesGroupRow[];
  payments: PaymentSplit;
}

export interface MyDayRows {
  totals: SalesSums;
  voidedCount: number;
  payments: PaymentSplit;
}

interface RawRow {
  kind: 'group' | 'total' | 'payment';
  k: string | null;
  location_name: string | null;
  n: number | null;
  t: string | null;
  p: string | null;
  b: string | null;
  voided: number | null;
  method: string | null;
  verified: boolean | null;
}

// Reports (Phase G1, docs/phase-g1-design.md section 3). The approved
// read-only exception to "a module never reads another module's tables" (Ian,
// G1): these SELECTs read sale, sale_item, payment, stock_movement,
// stock_balance, field_settlement(_line), location, product and pack_type in
// one place, through the current tenant transaction, so RLS applies to every
// one. Nothing here writes. Display names come from StaffService, never a join
// on membership.
//
// Each report is ONE statement: the statement timeout then bounds the whole
// report, and totals, groups and payments come from one snapshot (separate
// statements under READ COMMITTED could each see a different set of sales).
// Money is summed in SQL as NUMERIC and read as text. Every value is a
// parameter; the business_id filters are in addition to RLS, never instead.
@Injectable()
export class ReportsRepository {
  /**
   * SET LOCAL statement_timeout for the rest of this transaction. set_config
   * with true is the same as SET LOCAL but takes a parameter. A cancelled
   * statement fails with SQLSTATE 57014.
   */
  async limitStatementTime(ms: number): Promise<void> {
    await currentTx().$executeRaw`SELECT set_config('statement_timeout', ${String(ms)}, true)`;
  }

  /**
   * Completed sales placed by occurred_at in [from, to), grouped by the Nairobi
   * date, the creating member or the location, with a totals row (ROLLUP) and
   * the recorded payments of those same sales by method.
   */
  async sales(f: { from: Date; to: Date; groupBy: SalesGroupBy; locationId: string | null; attendantId: string | null }): Promise<SalesReportRows> {
    const biz = currentBusinessId();
    const raw = await currentTx().$queryRaw<RawRow[]>`
      WITH s AS (
        SELECT id, total, paid_total, balance_due,
               CASE ${f.groupBy}
                 WHEN 'day' THEN (occurred_at AT TIME ZONE 'Africa/Nairobi')::date::text
                 WHEN 'attendant' THEN created_by_membership_id::text
                 ELSE location_id::text
               END AS k
          FROM sale
         WHERE business_id = ${biz}::uuid AND status = 'COMPLETED'
           AND occurred_at >= ${f.from} AND occurred_at < ${f.to}
           AND (${f.locationId}::uuid IS NULL OR location_id = ${f.locationId}::uuid)
           AND (${f.attendantId}::uuid IS NULL OR created_by_membership_id = ${f.attendantId}::uuid)
      ), g AS (
        SELECT grouping(k) AS is_total, k, count(*)::int AS n,
               sum(total) AS t, sum(paid_total) AS p, sum(balance_due) AS b
          FROM s GROUP BY ROLLUP (k)
      ), pay AS (
        SELECT pm.method, (pm.method = 'MPESA' AND pm.verified) AS verified, sum(pm.amount) AS a
          FROM payment pm JOIN s ON s.id = pm.sale_id
         WHERE pm.business_id = ${biz}::uuid AND pm.status = 'RECORDED'
         GROUP BY 1, 2
      )
      SELECT CASE WHEN g.is_total = 1 THEN 'total' ELSE 'group' END AS kind, g.k, l.name AS location_name,
             g.n, g.t::text AS t, g.p::text AS p, g.b::text AS b,
             NULL::int AS voided, NULL::text AS method, NULL::boolean AS verified
        FROM g
        LEFT JOIN location l ON ${f.groupBy} = 'location' AND g.is_total = 0
                            AND l.business_id = ${biz}::uuid AND l.id::text = g.k
      UNION ALL
      SELECT 'payment', NULL, NULL, NULL, a::text, NULL, NULL, NULL, method, verified FROM pay`;
    const total = raw.find((r) => r.kind === 'total');
    return {
      totals: sums(total),
      rows: raw.filter((r) => r.kind === 'group').map((r) => ({ key: r.k!, locationName: r.location_name, ...sums(r) })),
      payments: split(raw),
    };
  }

  /** One member's own sales placed in [from, to): completed sums, the voided count, and payments of the completed ones. */
  async myDay(f: { membershipId: string; from: Date; to: Date }): Promise<MyDayRows> {
    const biz = currentBusinessId();
    const raw = await currentTx().$queryRaw<RawRow[]>`
      WITH s AS (
        SELECT id, status, total, paid_total, balance_due
          FROM sale
         WHERE business_id = ${biz}::uuid AND created_by_membership_id = ${f.membershipId}::uuid
           AND occurred_at >= ${f.from} AND occurred_at < ${f.to}
      ), c AS (
        SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int AS n,
               sum(total) FILTER (WHERE status = 'COMPLETED') AS t,
               sum(paid_total) FILTER (WHERE status = 'COMPLETED') AS p,
               sum(balance_due) FILTER (WHERE status = 'COMPLETED') AS b,
               count(*) FILTER (WHERE status = 'VOIDED')::int AS voided
          FROM s
      ), pay AS (
        SELECT pm.method, (pm.method = 'MPESA' AND pm.verified) AS verified, sum(pm.amount) AS a
          FROM payment pm JOIN s ON s.id = pm.sale_id AND s.status = 'COMPLETED'
         WHERE pm.business_id = ${biz}::uuid AND pm.status = 'RECORDED'
         GROUP BY 1, 2
      )
      SELECT 'total' AS kind, NULL::text AS k, NULL::text AS location_name, n, t::text AS t, p::text AS p, b::text AS b,
             voided, NULL::text AS method, NULL::boolean AS verified
        FROM c
      UNION ALL
      SELECT 'payment', NULL, NULL, NULL, a::text, NULL, NULL, NULL, method, verified FROM pay`;
    const total = raw.find((r) => r.kind === 'total');
    return { totals: sums(total), voidedCount: total?.voided ?? 0, payments: split(raw) };
  }
}

// No sales: count 0 and NULL sums, shown as 0.00.
function sums(r: RawRow | undefined): SalesSums {
  return { saleCount: r?.n ?? 0, total: r?.t ?? '0.00', paidTotal: r?.p ?? '0.00', balanceDue: r?.b ?? '0.00' };
}

// The payment rows as the three amounts (strings straight from SQL; at most
// one row per method and verified flag, so nothing is added here).
function split(raw: RawRow[]): PaymentSplit {
  const amount = (method: string, verified: boolean) =>
    raw.find((r) => r.kind === 'payment' && r.method === method && r.verified === verified)?.t ?? '0.00';
  // Only M-Pesa can be verified (Phase M); the SQL groups every cash payment
  // as unverified, so cash is one row whatever its flag says.
  return { cash: amount('CASH', false), mpesaUnverified: amount('MPESA', false), mpesaVerified: amount('MPESA', true) };
}
