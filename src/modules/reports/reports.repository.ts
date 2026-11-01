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

export type TopProductsBy = 'quantity' | 'value';
export type ProfitGroupBy = 'day' | 'product' | 'attendant';

/**
 * One product of the top products report. cost, profit and valueWithoutCost
 * are cost figures: the service drops them for members without costs.view.
 */
export interface TopProductRow {
  productId: string;
  // The name on the product's latest line in the range (lines keep the name
  // they were sold under, so a renamed product can have two).
  name: string;
  pieces: number;
  value: string;
  // Over lines with a recorded cost only: sum(cost_price * quantity), and
  // their line totals minus that cost.
  cost: string;
  profit: string;
  // Line totals of lines with no recorded cost.
  valueWithoutCost: string;
}

/** Profit figures; revenue, cost and profit count only lines with a recorded cost. */
export interface ProfitSums {
  revenue: string;
  cost: string;
  profit: string;
  linesWithoutCost: number;
  revenueWithoutCost: string;
}

/** One group of the profit report: a Nairobi date, a product id or a membership id. */
export interface ProfitGroupRow extends ProfitSums {
  key: string;
  // The product's name (its latest line in the range) when grouped by product; otherwise null.
  productName: string | null;
}

export interface ProfitReportRows {
  totals: ProfitSums;
  rows: ProfitGroupRow[];
}

export type StockGroupBy = 'product' | 'location';
export type ShrinkageGroupBy = 'reason' | 'person' | 'location' | 'product';

/**
 * Stock on hand. pieces = quantity x units_per_pack, negative balances
 * included. valueAtCost and poolsWithoutCost are cost figures (positive
 * balances only): the service drops them without costs.view.
 */
export interface StockSums {
  pieces: number;
  pools: number;
  negativePools: number;
  valueAtCost: string;
  poolsWithoutCost: number;
}

/** One pack type of a product, summed over the locations in the report. */
export interface StockPackRow {
  packTypeId: string;
  name: string;
  unitsPerPack: number;
  quantity: number;
}

/** One group of the stock report: a product id or a location id, with its current name. */
export interface StockGroupRow extends StockSums {
  key: string;
  name: string;
  // Grouped by product: its pack types, in id order. Otherwise empty.
  packs: StockPackRow[];
}

export interface StockReportRows {
  totals: StockSums;
  rows: StockGroupRow[];
}

/**
 * Shrinkage in pieces (quantity_change x units_per_pack, whatever the pack
 * type). The value figures are at the pack type's current cost and are cost
 * figures: the service drops them without costs.view. A movement whose pack
 * type has no cost is counted in movementsWithoutCost and valued at nothing.
 */
export interface ShrinkageSums {
  unitsLost: number;
  unitsFound: number;
  netUnits: number;
  valueLostAtCost: string;
  valueFoundAtCost: string;
  netValueAtCost: string;
  movementsWithoutCost: number;
}

/** One group of shrinkage: a reason key, a membership id, a location id or a product id. */
export interface ShrinkageGroupRow extends ShrinkageSums {
  key: string;
  // The current location or product name when grouped by those; otherwise null.
  name: string | null;
}

export interface ShrinkageReportRows {
  totals: ShrinkageSums;
  rows: ShrinkageGroupRow[];
}

interface RawStockRow {
  kind: 'group' | 'total' | 'pack';
  k: string | null;
  name: string | null;
  pieces: string | null;
  pools: number | null;
  negative_pools: number | null;
  value_at_cost: string | null;
  pools_without_cost: number | null;
  pack_type_id: string | null;
  units_per_pack: number | null;
  quantity: string | null;
}

interface RawShrinkageRow {
  is_total: number;
  k: string | null;
  name: string | null;
  lost: string;
  found: string;
  net: string;
  value_lost: string;
  value_found: string;
  net_value: string;
  without_cost: number;
}

interface RawProfitRow {
  is_total: number;
  k: string | null;
  name: string | null;
  revenue: string;
  cost: string;
  profit: string;
  nwc: number;
  rwc: string;
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

  /**
   * Lines of completed sales placed in [from, to), per product (every pack
   * type of a product together, in pieces: quantity x units_per_pack, the
   * current value, which cannot change once a pack type has movements).
   * Ordered by pieces or value, then name in code point order, then id.
   */
  async topProducts(f: { from: Date; to: Date; by: TopProductsBy; limit: number; locationId: string | null }): Promise<TopProductRow[]> {
    const biz = currentBusinessId();
    const raw = await currentTx().$queryRaw<{ pid: string; name: string; pieces: string; value: string; cost: string; profit: string; vwc: string }[]>`
      WITH l AS (
        SELECT pt.product_id AS pid, li.product_name, s.occurred_at, s.id AS sid, li.line_no,
               li.quantity::bigint * pt.units_per_pack AS pieces, li.line_total, li.cost_price, li.quantity
          FROM sale s
          JOIN sale_item li ON li.business_id = s.business_id AND li.sale_id = s.id
          JOIN pack_type pt ON pt.business_id = li.business_id AND pt.id = li.pack_type_id
         WHERE s.business_id = ${biz}::uuid AND s.status = 'COMPLETED'
           AND s.occurred_at >= ${f.from} AND s.occurred_at < ${f.to}
           AND (${f.locationId}::uuid IS NULL OR s.location_id = ${f.locationId}::uuid)
      ), g AS (
        SELECT pid, (array_agg(product_name ORDER BY occurred_at DESC, sid DESC, line_no DESC))[1] AS name,
               sum(pieces) AS pieces, sum(line_total) AS value,
               coalesce(sum(cost_price * quantity), 0.00) AS cost,
               coalesce(sum(line_total) FILTER (WHERE cost_price IS NOT NULL), 0.00) AS costed_value,
               coalesce(sum(line_total) FILTER (WHERE cost_price IS NULL), 0.00) AS vwc
          FROM l GROUP BY pid
      )
      SELECT pid::text AS pid, name, pieces::text AS pieces, value::text AS value, cost::text AS cost,
             (costed_value - cost)::text AS profit, vwc::text AS vwc
        FROM g
       ORDER BY CASE WHEN ${f.by} = 'quantity' THEN pieces::numeric ELSE value END DESC, name COLLATE "C", pid
       LIMIT ${f.limit}`;
    return raw.map((r) => ({
      productId: r.pid,
      name: r.name,
      pieces: wholeNumber(r.pieces),
      value: r.value,
      cost: r.cost,
      profit: r.profit,
      valueWithoutCost: r.vwc,
    }));
  }

  /**
   * Lines of completed sales placed in [from, to), grouped by the Nairobi
   * date, the product or the selling member, with a totals row (ROLLUP).
   * revenue, cost and profit cover only lines with a recorded cost: a missing
   * cost is never counted as zero. Lines without one are counted apart.
   */
  async profit(f: { from: Date; to: Date; groupBy: ProfitGroupBy }): Promise<ProfitReportRows> {
    const biz = currentBusinessId();
    const raw = await currentTx().$queryRaw<RawProfitRow[]>`
      WITH l AS (
        SELECT CASE ${f.groupBy}
                 WHEN 'day' THEN (s.occurred_at AT TIME ZONE 'Africa/Nairobi')::date::text
                 WHEN 'product' THEN pt.product_id::text
                 ELSE s.created_by_membership_id::text
               END AS k,
               li.product_name, s.occurred_at, s.id AS sid, li.line_no,
               li.line_total, li.cost_price, li.quantity
          FROM sale s
          JOIN sale_item li ON li.business_id = s.business_id AND li.sale_id = s.id
          JOIN pack_type pt ON pt.business_id = li.business_id AND pt.id = li.pack_type_id
         WHERE s.business_id = ${biz}::uuid AND s.status = 'COMPLETED'
           AND s.occurred_at >= ${f.from} AND s.occurred_at < ${f.to}
      ), g AS (
        SELECT grouping(k) AS is_total, k,
               (array_agg(product_name ORDER BY occurred_at DESC, sid DESC, line_no DESC)
                  FILTER (WHERE ${f.groupBy} = 'product'))[1] AS name,
               coalesce(sum(line_total) FILTER (WHERE cost_price IS NOT NULL), 0.00) AS revenue,
               coalesce(sum(cost_price * quantity), 0.00) AS cost,
               count(*) FILTER (WHERE cost_price IS NULL)::int AS nwc,
               coalesce(sum(line_total) FILTER (WHERE cost_price IS NULL), 0.00) AS rwc
          FROM l GROUP BY ROLLUP (k)
      )
      SELECT is_total, k, name, revenue::text AS revenue, cost::text AS cost, (revenue - cost)::text AS profit,
             nwc, rwc::text AS rwc
        FROM g`;
    const profitSums = (r: RawProfitRow | undefined): ProfitSums => ({
      revenue: r?.revenue ?? '0.00',
      cost: r?.cost ?? '0.00',
      profit: r?.profit ?? '0.00',
      linesWithoutCost: r?.nwc ?? 0,
      revenueWithoutCost: r?.rwc ?? '0.00',
    });
    return {
      // No lines at all: ROLLUP still returns its totals row, so undefined only defends.
      totals: profitSums(raw.find((r) => r.is_total === 1)),
      rows: raw
        .filter((r) => r.is_total === 0)
        .map((r) => ({ key: r.k!, productName: f.groupBy === 'product' ? r.name : null, ...profitSums(r) })),
    };
  }

  /**
   * Stock on hand from stock_balance, with the same filters and defaults as
   * GET /v1/stock (zero balances and archived products left out unless
   * asked), grouped by product or location with a totals row (ROLLUP). By
   * product, also each pack type's quantity over the locations.
   */
  async stock(f: { groupBy: StockGroupBy; locationId: string | null; includeZero: boolean; includeArchived: boolean }): Promise<StockReportRows> {
    const biz = currentBusinessId();
    const raw = await currentTx().$queryRaw<RawStockRow[]>`
      WITH b AS (
        SELECT CASE ${f.groupBy} WHEN 'product' THEN p.id::text ELSE b.location_id::text END AS k,
               CASE ${f.groupBy} WHEN 'product' THEN p.name ELSE l.name END AS name,
               b.pack_type_id, pt.name AS pack_type_name, pt.units_per_pack, b.quantity, pt.cost_price
          FROM stock_balance b
          JOIN pack_type pt ON pt.business_id = b.business_id AND pt.id = b.pack_type_id
          JOIN product p ON p.business_id = pt.business_id AND p.id = pt.product_id
          JOIN location l ON l.business_id = b.business_id AND l.id = b.location_id
         WHERE b.business_id = ${biz}::uuid
           AND (${f.locationId}::uuid IS NULL OR b.location_id = ${f.locationId}::uuid)
           AND (${f.includeZero}::boolean OR b.quantity <> 0)
           AND (${f.includeArchived}::boolean OR p.archived_at IS NULL)
      ), g AS (
        SELECT grouping(k) AS is_total, k, min(name) AS name,
               sum(quantity::bigint * units_per_pack) AS pieces, count(*)::int AS pools,
               count(*) FILTER (WHERE quantity < 0)::int AS negative_pools,
               coalesce(sum(quantity * cost_price) FILTER (WHERE quantity > 0), 0.00) AS value_at_cost,
               count(*) FILTER (WHERE quantity > 0 AND cost_price IS NULL)::int AS pools_without_cost
          FROM b GROUP BY ROLLUP (k)
      ), pk AS (
        SELECT k, pack_type_id, min(pack_type_name) AS name, min(units_per_pack) AS units_per_pack, sum(quantity) AS quantity
          FROM b WHERE ${f.groupBy} = 'product'
         GROUP BY k, pack_type_id
      )
      SELECT CASE WHEN is_total = 1 THEN 'total' ELSE 'group' END AS kind, k, name, coalesce(pieces, 0)::text AS pieces,
             pools, negative_pools, value_at_cost::text AS value_at_cost, pools_without_cost,
             NULL::text AS pack_type_id, NULL::int AS units_per_pack, NULL::text AS quantity
        FROM g
      UNION ALL
      SELECT 'pack', k, name, NULL, NULL, NULL, NULL, NULL, pack_type_id::text, units_per_pack, quantity::text FROM pk`;
    const stockSums = (r: RawStockRow | undefined): StockSums => ({
      pieces: wholeNumber(r?.pieces ?? '0'),
      pools: r?.pools ?? 0,
      negativePools: r?.negative_pools ?? 0,
      valueAtCost: r?.value_at_cost ?? '0.00',
      poolsWithoutCost: r?.pools_without_cost ?? 0,
    });
    const packs = raw
      .filter((r) => r.kind === 'pack')
      .sort((a, b) => (a.pack_type_id! < b.pack_type_id! ? -1 : a.pack_type_id! > b.pack_type_id! ? 1 : 0));
    return {
      totals: stockSums(raw.find((r) => r.kind === 'total')),
      rows: raw
        .filter((r) => r.kind === 'group')
        .map((r) => ({
          key: r.k!,
          name: r.name!,
          ...stockSums(r),
          packs: packs
            .filter((p) => p.k === r.k)
            .map((p) => ({ packTypeId: p.pack_type_id!, name: p.name!, unitsPerPack: p.units_per_pack!, quantity: wholeNumber(p.quantity!) })),
        })),
    };
  }

  /**
   * Shrinkage: movements placed by occurred_at in [from, to) that lose or
   * recover stock. ADJUST with DAMAGED, EXPIRED, LOST or FOUND; COUNT
   * differences; and every settlement adjustment (key SETTLEMENT, counted
   * against the settlement's attendant, never the member who closed it).
   * SUPPLIER_RETURN, CORRECTION and OTHER are not shrinkage. Grouped with a
   * totals row (ROLLUP); always in pieces.
   */
  async shrinkage(f: { from: Date; to: Date; groupBy: ShrinkageGroupBy }): Promise<ShrinkageReportRows> {
    const biz = currentBusinessId();
    const raw = await currentTx().$queryRaw<RawShrinkageRow[]>`
      WITH m AS (
        SELECT m.quantity_change::bigint * pt.units_per_pack AS pieces,
               m.quantity_change * pt.cost_price AS value,
               CASE ${f.groupBy}
                 WHEN 'reason' THEN CASE WHEN m.settlement_id IS NOT NULL THEN 'SETTLEMENT'
                                         WHEN m.movement_type = 'COUNT' THEN 'COUNT'
                                         ELSE m.reason END
                 WHEN 'person' THEN (CASE WHEN m.settlement_id IS NOT NULL THEN fs.attendant_membership_id
                                          ELSE m.created_by_membership_id END)::text
                 WHEN 'location' THEN m.location_id::text
                 ELSE pt.product_id::text
               END AS k
          FROM stock_movement m
          JOIN pack_type pt ON pt.business_id = m.business_id AND pt.id = m.pack_type_id
          LEFT JOIN field_settlement fs ON fs.business_id = m.business_id AND fs.id = m.settlement_id
         WHERE m.business_id = ${biz}::uuid
           AND m.occurred_at >= ${f.from} AND m.occurred_at < ${f.to}
           AND ((m.movement_type = 'ADJUST' AND (m.settlement_id IS NOT NULL OR m.reason IN ('DAMAGED', 'EXPIRED', 'LOST', 'FOUND')))
                OR (m.movement_type = 'COUNT' AND m.quantity_change <> 0))
      ), g AS (
        SELECT grouping(k) AS is_total, k,
               coalesce(-sum(pieces) FILTER (WHERE pieces < 0), 0) AS lost,
               coalesce(sum(pieces) FILTER (WHERE pieces > 0), 0) AS found,
               coalesce(sum(pieces), 0) AS net,
               coalesce(-sum(value) FILTER (WHERE pieces < 0), 0.00) AS value_lost,
               coalesce(sum(value) FILTER (WHERE pieces > 0), 0.00) AS value_found,
               coalesce(sum(value), 0.00) AS net_value,
               count(*) FILTER (WHERE value IS NULL)::int AS without_cost
          FROM m GROUP BY ROLLUP (k)
      )
      SELECT g.is_total, g.k, coalesce(l.name, p.name) AS name,
             g.lost::text AS lost, g.found::text AS found, g.net::text AS net,
             g.value_lost::text AS value_lost, g.value_found::text AS value_found, g.net_value::text AS net_value, g.without_cost
        FROM g
        LEFT JOIN location l ON ${f.groupBy} = 'location' AND g.is_total = 0 AND l.business_id = ${biz}::uuid AND l.id::text = g.k
        LEFT JOIN product p ON ${f.groupBy} = 'product' AND g.is_total = 0 AND p.business_id = ${biz}::uuid AND p.id::text = g.k`;
    const shrinkSums = (r: RawShrinkageRow | undefined): ShrinkageSums => ({
      unitsLost: wholeNumber(r?.lost ?? '0'),
      unitsFound: wholeNumber(r?.found ?? '0'),
      netUnits: wholeNumber(r?.net ?? '0'),
      valueLostAtCost: r?.value_lost ?? '0.00',
      valueFoundAtCost: r?.value_found ?? '0.00',
      netValueAtCost: r?.net_value ?? '0.00',
      movementsWithoutCost: r?.without_cost ?? 0,
    });
    return {
      totals: shrinkSums(raw.find((r) => r.is_total === 1)),
      rows: raw.filter((r) => r.is_total === 0).map((r) => ({ key: r.k!, name: r.name, ...shrinkSums(r) })),
    };
  }
}

// A count summed in SQL as bigint, read as text. Pieces are capped per line
// and per pool, so a sum beyond 2^53 means something is badly wrong.
function wholeNumber(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error('report count out of range');
  return n;
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
