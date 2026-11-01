import { writeFileSync } from 'node:fs';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asMigrator, resetTables } from './helpers/db.js';
import { type Member, stockApi } from './helpers/stock-api.js';

// Phase G1f test 2 (docs/phase-g1-design.md section 11): with 50,000 sales
// over 90 days in one business, every report route and both exports are
// timed through the API, and each must stay under the 8 second statement
// timeout. Seeding takes minutes, so it runs only with G1_PERF=1 (decided
// in G1f); the results file and the final three runs set it. The times go
// to G1F_REPORT_FILE before the assertions.

const SALES = 50_000;
const PRODUCTS = 200;
const IP = '198.51.100.215';
const PHONE_BASE = 99_500_000;

describe.skipIf(!process.env.G1_PERF)('G1f: report performance at 50,000 sales', { timeout: 900_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let owner: Member;
  let attendant: Member;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, IP, PHONE_BASE);
    await resetTables();
    owner = await api.signupOwner('Duka Kubwa');
    const manager = await api.activeStaff(owner, 'MANAGER', 'Wanjiru');
    attendant = await api.activeStaff(owner, 'ATTENDANT', 'Achieng');
    const field = await api.activeStaff(owner, 'FIELD_ATTENDANT', 'Otieno');
    const shop = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', owner.token)).locations[0].id;
    const branch = await api.newLocation(owner, 'Branch');
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: field.membershipId }, owner.token)).id;
    await seed({ shops: [shop, branch], van, sellers: [owner.membershipId, manager.membershipId, attendant.membershipId], manager: manager.membershipId, field: field.membershipId });
  }, 900_000);

  afterAll(async () => {
    await t?.app.close();
  });

  /** The data, as fixture rows written by the migrator in a few bulk statements (the code under test reads them as app_user). */
  async function seed(f: { shops: string[]; van: string; sellers: string[]; manager: string; field: string }): Promise<void> {
    await asMigrator(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [owner.businessId]);
      const biz = owner.businessId;
      const devices = (await c.query<{ id: string }>('SELECT id FROM device WHERE business_id = $1 ORDER BY id', [biz])).rows.map((r) => r.id);
      // 200 products with a piece and a carton of 24; every 10th without costs.
      const products = (await c.query<{ id: string }>(
        "INSERT INTO product (business_id, name) SELECT $1, 'Product ' || lpad(p::text, 3, '0') FROM generate_series(0, $2::int - 1) p RETURNING id",
        [biz, PRODUCTS],
      )).rows.map((r) => r.id);
      const pieces: string[] = [];
      const cartons: string[] = [];
      for (const [p, id] of products.entries()) {
        const costed = p % 10 !== 0;
        const rows = (await c.query<{ id: string; units_per_pack: number }>(
          "INSERT INTO pack_type (business_id, product_id, name, units_per_pack, sell_price, cost_price) VALUES ($1, $2, 'piece', 1, 50, $3), ($1, $2, 'carton', 24, 1100, $4) RETURNING id, units_per_pack",
          [biz, id, costed ? 35 : null, costed ? 800 : null],
        )).rows;
        pieces.push(rows.find((r) => r.units_per_pack === 1)!.id);
        cartons.push(rows.find((r) => r.units_per_pack === 24)!.id);
      }
      // Line i of sale g: product (g*7 + i*13) % 200, a carton when (g + i) % 4 = 0,
      // quantity 1 + (g + i) % 3, 5.00 below list when (g + i) % 9 = 0.
      const line = (g: string) => `
        SELECT i, ((${g} * 7 + i * 13) % ${PRODUCTS}) + 1 AS pidx, ((${g} + i) % 4 = 0) AS carton, 1 + (${g} + i) % 3 AS qty,
               CASE WHEN (${g} + i) % 4 = 0 THEN 1100 ELSE 50 END AS list,
               CASE WHEN (${g} + i) % 4 = 0 THEN 1100 ELSE 50 END - CASE WHEN (${g} + i) % 9 = 0 THEN 5 ELSE 0 END AS unit
          FROM generate_series(1, 2 + ${g} % 2) i`;
      // Sales over the 90 days before 2026-11-01 00:00 Nairobi; 5% voided, 10% unpaid.
      await c.query(
        `INSERT INTO sale (id, business_id, sale_number, local_ref, location_id, device_id, created_by_membership_id,
                           occurred_at, received_at, status, total, paid_total, balance_due,
                           voided_at, voided_by_membership_id, void_reason, void_approved_by_membership_id)
         SELECT gen_random_uuid(), $1, g, 'R' || g, ($2::uuid[])[1 + g % 2], ($3::uuid[])[1 + g % 3], ($4::uuid[])[1 + g % 3],
                ts, ts, CASE WHEN g % 20 = 0 THEN 'VOIDED' ELSE 'COMPLETED' END,
                tot, CASE WHEN g % 10 = 3 THEN 0 ELSE tot END, CASE WHEN g % 10 = 3 THEN tot ELSE 0 END,
                CASE WHEN g % 20 = 0 THEN ts + interval '3 hours' END, CASE WHEN g % 20 = 0 THEN $6::uuid END,
                CASE WHEN g % 20 = 0 THEN 'MISTAKE' END, CASE WHEN g % 20 = 0 THEN $6::uuid END
           FROM generate_series(1, $5::int) g,
                LATERAL (SELECT timestamptz '2026-10-31 21:00:00+00' - (g::double precision / $5 * 90) * interval '1 day' AS ts) t,
                LATERAL (SELECT sum(unit * qty)::numeric(14,2) AS tot FROM (${line('g')}) l) x`,
        [biz, f.shops, devices, f.sellers, SALES, f.manager],
      );
      await c.query(
        `INSERT INTO sale_item (business_id, sale_id, line_no, pack_type_id, product_name, pack_type_name, quantity, unit_price, list_price, cost_price, line_total)
         SELECT $1, s.id, l.i, CASE WHEN l.carton THEN ($3::uuid[])[l.pidx] ELSE ($2::uuid[])[l.pidx] END,
                'Product ' || lpad((l.pidx - 1)::text, 3, '0'), CASE WHEN l.carton THEN 'carton' ELSE 'piece' END,
                l.qty, l.unit, l.list,
                CASE WHEN (l.pidx - 1) % 10 = 0 THEN NULL WHEN l.carton THEN 800 ELSE 35 END, l.unit * l.qty
           FROM sale s, LATERAL (${line('s.sale_number')}) l
          WHERE s.business_id = $1`,
        [biz, pieces, cartons],
      );
      await c.query(
        `INSERT INTO payment (business_id, sale_id, method, amount, mpesa_code, status, occurred_at, created_by_membership_id, location_id, recorded_by_device_id, reversed_txid)
         SELECT $1, s.id, CASE WHEN s.sale_number % 2 = 0 THEN 'CASH' ELSE 'MPESA' END, s.total,
                CASE WHEN s.sale_number % 2 = 0 THEN NULL ELSE 'Q' || lpad(s.sale_number::text, 9, '0') END,
                CASE WHEN s.status = 'VOIDED' THEN 'REVERSED' ELSE 'RECORDED' END, s.occurred_at, s.created_by_membership_id, s.location_id, s.device_id,
                CASE WHEN s.status = 'VOIDED' THEN pg_current_xact_id() END
           FROM sale s WHERE s.business_id = $1 AND s.paid_total > 0`,
        [biz],
      );
      // Statistics first: without them the planner takes the fresh tables for
      // tiny ones and joins 50,000 sales to their lines in a nested loop (the
      // first run of this test spent over 13 minutes on the next statement).
      await c.query('ANALYZE sale; ANALYZE sale_item');
      // The ledger: a SALE movement per line, then adjustments and counts.
      await c.query(
        `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at, created_by_membership_id)
         SELECT $1, s.location_id, li.pack_type_id, -li.quantity, 'SALE', 10, s.occurred_at, s.created_by_membership_id
           FROM sale s JOIN sale_item li ON li.business_id = s.business_id AND li.sale_id = s.id
          WHERE s.business_id = $1`,
        [biz],
      );
      const packs = [...pieces, ...cartons];
      await c.query(
        `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at, created_by_membership_id, reason)
         SELECT $1, ($2::uuid[])[1 + g % 2], ($3::uuid[])[1 + (g * 7) % 400], CASE WHEN g % 7 = 3 THEN 1 + g % 4 ELSE -(1 + g % 4) END, 'ADJUST', 10,
                timestamptz '2026-10-31 21:00:00+00' - (g::double precision / 3500 * 90) * interval '1 day', $4,
                (ARRAY['DAMAGED', 'EXPIRED', 'LOST', 'FOUND', 'SUPPLIER_RETURN', 'CORRECTION', 'OTHER'])[1 + g % 7]
           FROM generate_series(1, 3500) g`,
        [biz, f.shops, packs, f.manager],
      );
      await c.query(
        `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at, created_by_membership_id, expected_quantity, counted_quantity)
         SELECT $1, ($2::uuid[])[1 + g % 2], ($3::uuid[])[1 + (g * 11) % 400], (g % 5) - 2, 'COUNT', 10,
                timestamptz '2026-10-31 21:00:00+00' - (g::double precision / 1500 * 90) * interval '1 day', $4, 12 - (g % 5), 10
           FROM generate_series(1, 1500) g WHERE g % 5 <> 2`,
        [biz, f.shops, packs, f.manager],
      );
      // Balances at every location, about 3% negative and 5% zero.
      await c.query(
        `INSERT INTO stock_balance (business_id, location_id, pack_type_id, quantity)
         SELECT $1, l, p, CASE WHEN (i + j) % 33 = 0 THEN -2 WHEN (i + j) % 20 = 0 THEN 0 ELSE 10 + (i * 7 + j) % 90 END
           FROM unnest($2::uuid[]) WITH ORDINALITY a(l, i), unnest($3::uuid[]) WITH ORDINALITY b(p, j)`,
        [biz, [...f.shops, f.van], packs],
      );
      // 100 settlements of the van, three lines and their adjustments each.
      for (let n = 1; n <= 100; n++) {
        const at = `timestamptz '2026-10-31 18:00:00+00' - interval '${(100 - n) * 21} hours'`;
        const cmd = (await c.query<{ id: string }>(
          "INSERT INTO sync_command (business_id, command_id, type, status, result, occurred_at, received_at) VALUES ($1, gen_random_uuid(), 'settlement.close', 'ACCEPTED', '{}'::jsonb, now(), now()) RETURNING id",
          [biz],
        )).rows[0].id;
        const sid = (await c.query<{ id: string }>(
          `INSERT INTO field_settlement (id, business_id, field_location_id, attendant_membership_id, closed_by_membership_id, sync_command_id,
                                         occurred_at, received_at, sequence, period_start, period_end, expected_cash, cash_received, cash_variance,
                                         mpesa_verified_total, mpesa_unverified_total, sale_count, voided_count, unpaid_total, earlier_sales_cash, snapshot)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, ${at}, ${at}, $6, ${at}, ${at}, 1000, 990, -10, 0, 250, 12, 1, 100, 0, pg_current_snapshot()::text)
           RETURNING id`,
          [biz, f.van, f.field, f.manager, cmd, n],
        )).rows[0].id;
        await c.query(
          `INSERT INTO field_settlement_line (business_id, settlement_id, pack_type_id, issued, returned, sold, voided_back, expected_quantity, counted_quantity, variance)
           SELECT $1, $2, ($3::uuid[])[1 + (k * 11 + $4::int) % 400], 20, 0, 10, 0, 10, 10 + v, v
             FROM generate_series(1, 3) k, LATERAL (SELECT CASE k WHEN 1 THEN -2 WHEN 2 THEN 1 ELSE 0 END AS v) x`,
          [biz, sid, packs, n],
        );
        await c.query(
          `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at, created_by_membership_id, reason, settlement_id)
           VALUES ($1, $2, ($3::uuid[])[1 + (11 + $4::int) % 400], -2, 'ADJUST', 8, ${at}, $5, 'LOST', $6),
                  ($1, $2, ($3::uuid[])[1 + (22 + $4::int) % 400], 1, 'ADJUST', 11, ${at}, $5, 'FOUND', $6)`,
          [biz, f.van, packs, n, f.manager, sid],
        );
      }
      await c.query('COMMIT');
      await c.query('ANALYZE sale; ANALYZE sale_item; ANALYZE payment; ANALYZE stock_movement; ANALYZE stock_balance; ANALYZE pack_type; ANALYZE product; ANALYZE field_settlement; ANALYZE field_settlement_line');
    });
  }

  it('2. every report route and both exports stay under the 8 second statement timeout at 50,000 sales over 90 days', async () => {
    const r = 'from=2026-08-01&to=2026-10-31';
    const routes: [string, string, Member][] = [
      ['sales by day, 92 days', `/v1/reports/sales?${r}`, owner],
      ['sales by attendant, 92 days', `/v1/reports/sales?${r}&group_by=attendant`, owner],
      ['sales by location, 1 day', '/v1/reports/sales?from=2026-10-20&to=2026-10-20&group_by=location', owner],
      ['my day', '/v1/reports/my-day?date=2026-10-24', attendant],
      ['top products by quantity, 92 days', `/v1/reports/top-products?${r}`, owner],
      ['top products by value, 92 days', `/v1/reports/top-products?${r}&by=value&limit=50`, owner],
      ['profit by day, 92 days', `/v1/reports/profit?${r}`, owner],
      ['profit by product, 92 days', `/v1/reports/profit?${r}&group_by=product`, owner],
      ['profit by attendant, 92 days', `/v1/reports/profit?${r}&group_by=attendant`, owner],
      ['stock by product', '/v1/reports/stock?include_zero=true', owner],
      ['stock by location', '/v1/reports/stock?group_by=location', owner],
      ['shrinkage by reason, 92 days', `/v1/reports/shrinkage?${r}`, owner],
      ['shrinkage by person, 92 days', `/v1/reports/shrinkage?${r}&group_by=person`, owner],
      ['shrinkage by product, 92 days', `/v1/reports/shrinkage?${r}&group_by=product`, owner],
      ['voids, 92 days', `/v1/reports/exceptions?type=voids&${r}&limit=100`, owner],
      ['below list, 92 days', `/v1/reports/exceptions?type=below_list&${r}&limit=100`, owner],
      ['unpaid, all time', '/v1/reports/receivables?type=unpaid&limit=100', owner],
      ['unverified M-Pesa, all time', '/v1/reports/receivables?type=unverified_mpesa&limit=100', owner],
      ['field, 92 days', `/v1/reports/field?${r}`, owner],
      ['sales export, 92 days', `/v1/reports/sales/export.csv?${r}`, owner],
      ['stock export', '/v1/reports/stock/export.csv?include_zero=true', owner],
    ];
    const times: { name: string; ms: number; status: number; size: number }[] = [];
    for (const [name, url, who] of routes) {
      const started = Date.now();
      const res = await t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}` }, remoteAddress: IP });
      times.push({ name, ms: Date.now() - started, status: res.statusCode, size: res.body.length });
    }
    // Written before the assertions, so a failing run leaves its evidence too (as B4).
    const table = times.map((x) => `${x.name.padEnd(36)} ${String(x.ms).padStart(6)} ms  ${x.status}  ${x.size} characters`).join('\n');
    if (process.env.G1F_REPORT_FILE) writeFileSync(process.env.G1F_REPORT_FILE, `${table}\n`);
    for (const x of times) {
      expect(x.status, `${x.name}\n${table}`).toBe(200);
      expect(x.ms, `${x.name}\n${table}`).toBeLessThan(8_000);
    }
    // The data is the size it claims to be.
    const all = await t.app.inject({ method: 'GET', url: `/v1/reports/sales?${r}`, headers: { authorization: `Bearer ${owner.token}` }, remoteAddress: IP });
    expect((all.json() as { totals: { sale_count: number } }).totals.sale_count).toBe(47_500);
  });
});
