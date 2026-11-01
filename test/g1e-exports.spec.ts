import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { LightMyRequestResponse } from 'fastify';
import { CsvWriter } from '../src/modules/reports/csv-writer.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asMigrator, resetTables } from './helpers/db.js';
import { type Member, stockApi } from './helpers/stock-api.js';

// Phase G1e: CSV exports and audit (docs/phase-g1-design.md section 11, G1e).
// Numbers in test names refer to that list. Every expected cell is a literal
// worked out by hand from the fixture below.
//
// Business "Duka la Faili": Main shop (L1) and "+Branch, East" (L2); sellers
// Achieng and "@Baraka" (attendants). Products (sell / cost): Soda piece SP
// 50.00 / 35.50 and crate of 24 SC 1100.00 / 800.00; "=1+1" piece EQ 10.00 /
// 6.00; '-Chai "Kubwa"' piece CH 33.33 / none; two products renamed as the
// migrator to start with a tab ("\tTabbed", 3.00) and a carriage return
// ("\rReturn", 4.00), which the API itself trims away.
// Receive: L1 SP 20, SC 5, EQ 10, CH 10, TB 5, CR 5; L2 SC 2, EQ 1.
// Sales (Nairobi phone times):
//   X1 Achieng  L1 2026-10-20 23:59:59  1 SP 50.00, cash 50.00
//   X2 @Baraka  L2 2026-10-21 00:00:00  2 EQ 20.00, unpaid (EQ at L2 is now -1)
//   X3 Achieng  L2 2026-10-21 10:00     1 SC 1100.00, cash 600.00
//   X4 Achieng  L1 2026-10-21 11:00     1 CH 33.33, then voided
//   X5 @Baraka  L1 2026-10-22 09:00     1 EQ 10.00 (outside 20..21)

// Report routes allow 30 requests a minute per member (G1a): the tests spread
// their requests over several members.
const IP = '198.51.100.214';
const PHONE_BASE = 99_000_000;
const BOM = '﻿';

interface AuditRow {
  action: string;
  actor_membership_id: string | null;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

describe('G1e: CSV exports and audit', { timeout: 300_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let owner: Member;
  let wanjiru: Member;
  let neema: Member;
  let juma: Member;
  let achieng: Member;
  let baraka: Member;
  let L1: string;
  let L2: string;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, IP, PHONE_BASE);
    await resetTables();
    api.resetOutboxes();
    await fixture();
  }, 240_000);

  afterAll(async () => {
    await t.app.close();
  });

  const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: IP });
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });
  async function csv(url: string, token: string) {
    const res = await get(url, token);
    expect(res.statusCode, `${url} ${res.body.slice(0, 300)}`).toBe(200);
    return res;
  }
  /** The file's lines without the byte-order mark and the final CRLF; fails if either is missing. */
  function lines(body: string): string[] {
    expect(body.startsWith(BOM)).toBe(true);
    expect(body.endsWith('\r\n')).toBe(true);
    return body.slice(1, -2).split('\r\n');
  }
  const exportsOf = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<AuditRow>(
          "SELECT action, actor_membership_id, target_type, target_id, metadata FROM audit_log WHERE business_id = $1 AND action = 'report.exported' ORDER BY occurred_at, id",
          [businessId],
        )).rows,
    );

  // Nairobi wall time (UTC+3) as an ISO instant, for command envelopes.
  const nbo = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();
  async function accepted(m: Member, type: string, payload: object, at?: string) {
    const r = await api.sendOne(m.token, api.command(type, payload, at ? nbo(at) : undefined));
    expect(['ACCEPTED', 'FLAGGED'], `${type} ${JSON.stringify(r)}`).toContain(r.status);
    return r;
  }
  async function product(o: Member, name: string, packs: [string, number, string, string | null][]) {
    const productId = randomUUID();
    const ids = packs.map(() => randomUUID());
    await accepted(o, 'product.create', {
      product_id: productId,
      name,
      pack_types: packs.map(([packName, units, sell, cost], i) => ({
        pack_type_id: ids[i],
        name: packName,
        units_per_pack: units,
        sell_price: sell,
        ...(cost === null ? {} : { cost_price: cost }),
      })),
    });
    return { productId, ids };
  }
  async function sell(m: Member, loc: string, at: string, lines: [string, number, string][], payments: object[] = []) {
    const saleId = randomUUID();
    await accepted(m, 'sale.create', {
      sale_id: saleId,
      local_ref: saleId.slice(0, 8),
      location_id: loc,
      lines: lines.map(([pack_type_id, quantity, unit_price]) => ({ pack_type_id, quantity, unit_price })),
      payments,
    }, at);
    return saleId;
  }
  const firstLocation = async (o: Member) => api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;

  async function fixture() {
    owner = await api.signupOwner('Duka la Faili');
    wanjiru = await api.activeStaff(owner, 'MANAGER', 'Wanjiru');
    neema = await api.activeStaff(owner, 'MANAGER', 'Neema');
    expect((await api.call('PATCH', `/v1/staff/${neema.membershipId}`, owner.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    juma = await api.activeStaff(owner, 'MANAGER', 'Juma');
    achieng = await api.activeStaff(owner, 'ATTENDANT', 'Achieng');
    baraka = await api.activeStaff(owner, 'ATTENDANT', '@Baraka');
    L1 = await firstLocation(owner);
    L2 = await api.newLocation(owner, '+Branch, East');
    const soda = await product(owner, 'Soda', [['piece', 1, '50.00', '35.50'], ['crate of 24', 24, '1100.00', '800.00']]);
    const eq = await product(owner, '=1+1', [['piece', 1, '10.00', '6.00']]);
    const chai = await product(owner, '-Chai "Kubwa"', [['piece', 1, '33.33', null]]);
    const tab = await product(owner, 'Tabbed', [['piece', 1, '7.00', '3.00']]);
    const cr = await product(owner, 'Return', [['piece', 1, '8.00', '4.00']]);
    const [SP, SC] = soda.ids;
    const [EQ] = eq.ids;
    const [CH] = chai.ids;
    // Names the API trims; a future import could still bring them in.
    await asMigrator(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [owner.businessId]);
      await c.query('UPDATE product SET name = $2 WHERE id = $1', [tab.productId, '\tTabbed']);
      await c.query('UPDATE product SET name = $2 WHERE id = $1', [cr.productId, '\rReturn']);
      await c.query('COMMIT');
    });
    await accepted(wanjiru, 'stock.receive', { location_id: L1, lines: [{ pack_type_id: SP, quantity: 20 }, { pack_type_id: SC, quantity: 5 }, { pack_type_id: EQ, quantity: 10 }, { pack_type_id: CH, quantity: 10 }, { pack_type_id: tab.ids[0], quantity: 5 }, { pack_type_id: cr.ids[0], quantity: 5 }] }, '2026-10-19T08:00:00');
    await accepted(wanjiru, 'stock.receive', { location_id: L2, lines: [{ pack_type_id: SC, quantity: 2 }, { pack_type_id: EQ, quantity: 1 }] }, '2026-10-19T08:00:00');
    await sell(achieng, L1, '2026-10-20T23:59:59', [[SP, 1, '50.00']], [{ method: 'CASH', amount: '50.00' }]);
    await sell(baraka, L2, '2026-10-21T00:00:00', [[EQ, 2, '10.00']]);
    await sell(achieng, L2, '2026-10-21T10:00:00', [[SC, 1, '1100.00']], [{ method: 'CASH', amount: '600.00' }]);
    const x4 = await sell(achieng, L1, '2026-10-21T11:00:00', [[CH, 1, '33.33']], [{ method: 'CASH', amount: '33.33' }]);
    await accepted(wanjiru, 'sale.void', { sale_id: x4, reason: 'MISTAKE' }, '2026-10-21T11:30:00');
    await sell(baraka, L1, '2026-10-22T09:00:00', [[EQ, 1, '10.00']], [{ method: 'CASH', amount: '10.00' }]);
  }

  // ---------------------------------------------------------------- 1. the sales CSV
  it('1. the sales CSV equals the sales report: byte-order mark, header, CRLF, text/csv, file name, plain decimals, Nairobi date and time, no voided sale', async () => {
    const res = await csv('/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21', wanjiru.token);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="sales_2026-10-20_2026-10-21.csv"');
    expect(lines(res.body)).toEqual([
      'sale_number,date,time,location,attendant,total,paid_total,balance_due',
      // 23:59:59 Nairobi is 20:59:59 UTC: the file shows Nairobi time.
      '1,2026-10-20,23:59:59,Main shop,Achieng,50.00,50.00,0.00',
      `2,2026-10-21,00:00:00,"'+Branch, East",'@Baraka,20.00,0.00,20.00`,
      `3,2026-10-21,10:00:00,"'+Branch, East",Achieng,1100.00,600.00,500.00`,
    ]);
    // The same range in the sales report: 3 sales, 1170.00.
    const report = api.json<{ totals: { sale_count: number; total: string } }>(await get('/v1/reports/sales?from=2026-10-20&to=2026-10-21', wanjiru.token));
    const rows = lines(res.body).slice(1);
    expect(rows).toHaveLength(report.totals.sale_count);
    const cents = rows.reduce((s, line) => s + BigInt(line.match(/,(-?\d+)\.(\d\d),-?\d+\.\d\d,-?\d+\.\d\d$/)!.slice(1).join('')), 0n);
    expect(cents).toBe(117_000n);
    expect(report.totals.total).toBe('1170.00');

    // Filters narrow it the same way.
    expect(lines((await csv(`/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-22&attendant_id=${baraka.membershipId}`, wanjiru.token)).body)).toEqual([
      'sale_number,date,time,location,attendant,total,paid_total,balance_due',
      `2,2026-10-21,00:00:00,"'+Branch, East",'@Baraka,20.00,0.00,20.00`,
      `5,2026-10-22,09:00:00,Main shop,'@Baraka,10.00,10.00,0.00`,
    ]);
    expect(lines((await csv(`/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21&location_id=${L1}`, wanjiru.token)).body)).toEqual([
      'sale_number,date,time,location,attendant,total,paid_total,balance_due',
      '1,2026-10-20,23:59:59,Main shop,Achieng,50.00,50.00,0.00',
    ]);
    // An empty range is a header only.
    expect(lines((await csv('/v1/reports/sales/export.csv?from=2026-10-25&to=2026-10-25', wanjiru.token)).body)).toEqual(['sale_number,date,time,location,attendant,total,paid_total,balance_due']);
  });

  // ---------------------------------------------------------------- 2. formula injection
  it('2. names starting with =, +, -, @, tab or carriage return are neutralised; commas and quotes are quoted; negative numbers stay numbers', async () => {
    const writer = new CsvWriter();
    expect(
      writer.write(
        [
          { name: 'name', kind: 'text' },
          { name: 'quantity', kind: 'formatted' },
        ],
        [['=SUM(A1:A9)', -1], ['+1', '-10.00'], ['-2', 0], ['@x', null], ['\tx', 1], ['\rx', 2], ['a,b', 3], ['say "hi"', 4], ['plain', 5]],
      ),
    ).toBe(`${BOM}name,quantity\r\n'=SUM(A1:A9),-1\r\n'+1,-10.00\r\n'-2,0\r\n'@x,\r\n'\tx,1\r\n"'\rx",2\r\n"a,b",3\r\n"say ""hi""",4\r\nplain,5\r\n`);

    // Through the API: the stock CSV holds every kind of product and location name.
    const body = (await csv('/v1/reports/stock/export.csv', neema.token)).body;
    const rows = lines(body).slice(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        `'=1+1,piece,1,Main shop,9,6.00,54.00`,
        // A negative balance: the quantity stays a number, and is not valued.
        `'=1+1,piece,1,"'+Branch, East",-1,6.00,`,
        `"'-Chai ""Kubwa""",piece,1,Main shop,10,,`,
        `'\tTabbed,piece,1,Main shop,5,3.00,15.00`,
        `"'\rReturn",piece,1,Main shop,5,4.00,20.00`,
      ]),
    );
    // No line starts with a formula character.
    for (const line of rows) expect(line).not.toMatch(/^[=+\-@\t\r]/);
  });

  // ---------------------------------------------------------------- 3. the stock CSV
  it('3. the stock CSV: cost columns only with costs.view; the pools of GET /v1/stock in its order; a file name of the report and the date only', async () => {
    const withCosts = await csv('/v1/reports/stock/export.csv', neema.token);
    expect(withCosts.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(withCosts.headers['content-disposition']).toBe('attachment; filename="stock_2026-10-25.csv"');
    const costRows = lines(withCosts.body);
    expect(costRows[0]).toBe('product,pack_type,units_per_pack,location,quantity,cost_price,value_at_cost');
    expect(costRows.slice(1).sort()).toEqual(
      [
        'Soda,piece,1,Main shop,19,35.50,674.50',
        'Soda,crate of 24,24,Main shop,5,800.00,4000.00',
        `Soda,crate of 24,24,"'+Branch, East",1,800.00,800.00`,
        `'=1+1,piece,1,Main shop,9,6.00,54.00`,
        `'=1+1,piece,1,"'+Branch, East",-1,6.00,`,
        `"'-Chai ""Kubwa""",piece,1,Main shop,10,,`,
        `'\tTabbed,piece,1,Main shop,5,3.00,15.00`,
        `"'\rReturn",piece,1,Main shop,5,4.00,20.00`,
      ].sort(),
    );

    const plain = await csv('/v1/reports/stock/export.csv', wanjiru.token);
    const plainRows = lines(plain.body);
    expect(plainRows[0]).toBe('product,pack_type,units_per_pack,location,quantity');
    expect(plain.body).not.toMatch(/cost|35\.50|800\.00|674\.50/);
    // The same pools, in the same order, as GET /v1/stock for the same filters.
    for (const filters of ['', `location_id=${L2}`, 'include_zero=true']) {
      const stock = api.json<{ balances: { product_name: string; pack_type_name: string; location_name: string; quantity: number }[] }>(
        await get(`/v1/stock?limit=100${filters ? `&${filters}` : ''}`, wanjiru.token),
      ).balances;
      const file = lines((await csv(`/v1/reports/stock/export.csv${filters ? `?${filters}` : ''}`, wanjiru.token)).body).slice(1);
      expect(file.map((l) => l.split(',').at(-1)), filters).toEqual(stock.map((b) => String(b.quantity)));
      expect(file.length, filters).toBe(stock.length);
    }
    expect(lines((await csv(`/v1/reports/stock/export.csv?location_id=${L2}`, wanjiru.token)).body).slice(1).sort()).toEqual(
      [`Soda,crate of 24,24,"'+Branch, East",1`, `'=1+1,piece,1,"'+Branch, East",-1`].sort(),
    );
  });

  // ---------------------------------------------------------------- 4. size
  it('4. 50,000 rows export within the time and memory ceilings; 50,001 is 422 EXPORT_TOO_LARGE with no audit row', async () => {
    const big = await api.signupOwner('Duka Kubwa');
    const loc = await firstLocation(big);
    const seed = (from: number, to: number) =>
      asMigrator(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.business_id', $1, true)", [big.businessId]);
        const device = (await c.query<{ id: string }>('SELECT id FROM device WHERE business_id = $1 LIMIT 1', [big.businessId])).rows[0].id;
        // Sales are fixture data here (the export reads them, as app_user).
        await c.query(
          `INSERT INTO sale (id, business_id, sale_number, local_ref, location_id, device_id, created_by_membership_id,
                             occurred_at, received_at, status, total, paid_total, balance_due)
           SELECT gen_random_uuid(), $1, g, 'B' || g, $2, $3, $4,
                  timestamptz '2026-10-20 06:00:00+00' + g * interval '1 second', now(), 'COMPLETED', 1.00, 1.00, 0.00
             FROM generate_series($5::int, $6::int) g`,
          [big.businessId, loc, device, big.membershipId, from, to],
        );
        await c.query('COMMIT');
      });
    await seed(1, 50_000);

    const heap: number[] = [];
    const before = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => heap.push(process.memoryUsage().heapUsed), 25);
    const started = Date.now();
    const res = await get('/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21', big.token);
    const elapsed = Date.now() - started;
    clearInterval(sampler);
    heap.push(process.memoryUsage().heapUsed);
    const growthMb = Math.round((Math.max(...heap) - before) / 1_048_576);
    // Written before the assertions, so a failing run leaves its evidence too (as B4).
    const measured = `50,000-row sales export: ${elapsed} ms, heap growth ${growthMb} MB, ${res.body.length} characters`;
    if (process.env.G1E_REPORT_FILE) writeFileSync(process.env.G1E_REPORT_FILE, `${measured}\n`);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const all = lines(res.body);
    expect(all).toHaveLength(50_001);
    expect(all[1]).toBe('1,2026-10-20,09:00:01,Main shop,Amina,1.00,1.00,0.00');
    expect(all[50_000]).toBe('50000,2026-10-20,22:53:20,Main shop,Amina,1.00,1.00,0.00');
    expect(elapsed, measured).toBeLessThan(8_000);
    expect(growthMb, measured).toBeLessThan(150);
    expect(await exportsOf(big.businessId)).toHaveLength(1);

    await seed(50_001, 50_001);
    const refused = await get('/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21', big.token);
    expect(errorOf(refused)).toEqual({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect((refused.json() as { error: { message: string } }).error.message).toMatch(/Narrow the range/);
    expect(await exportsOf(big.businessId)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 5. audit
  it('5. each export writes one report.exported row with only the allowed metadata; a failure after the audit insert leaves none; report reads write none', async () => {
    const start = (await exportsOf(owner.businessId)).length;
    // A minute apart: audit times come from the Clock, and rows with the same time have no order.
    await csv(`/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21&location_id=${L1}&attendant_id=${achieng.membershipId}`, juma.token);
    t.clock.advanceMinutes(1);
    await csv(`/v1/reports/stock/export.csv?location_id=${L2}`, neema.token);
    t.clock.advanceMinutes(1);
    await csv('/v1/reports/stock/export.csv', juma.token);
    const rows = (await exportsOf(owner.businessId)).slice(start);
    expect(rows).toEqual([
      // Filters (the location and attendant ids) are never recorded.
      { action: 'report.exported', actor_membership_id: juma.membershipId, target_type: 'report', target_id: null, metadata: { report: 'sales', from: '2026-10-20', to: '2026-10-21', row_count: 1, with_costs: false } },
      { action: 'report.exported', actor_membership_id: neema.membershipId, target_type: 'report', target_id: null, metadata: { report: 'stock', row_count: 2, with_costs: true } },
      { action: 'report.exported', actor_membership_id: juma.membershipId, target_type: 'report', target_id: null, metadata: { report: 'stock', row_count: 8, with_costs: false } },
    ]);

    // Ordinary report reads and a refused export write nothing.
    expect((await get('/v1/reports/sales?from=2026-10-20&to=2026-10-21', juma.token)).statusCode).toBe(200);
    expect((await get('/v1/reports/stock', juma.token)).statusCode).toBe(200);
    expect(errorOf(await get('/v1/reports/sales/export.csv?from=2026-10-22&to=2026-10-21', juma.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await exportsOf(owner.businessId)).toHaveLength(start + 3);

    // The file is built after the audit insert; when building fails, the
    // request's transaction rolls back and takes the audit row with it.
    const writer = t.app.get(CsvWriter);
    const spy = vi.spyOn(writer, 'write').mockImplementationOnce(() => {
      throw new Error('forced failure after the audit insert');
    });
    try {
      const failed = await get('/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21', juma.token);
      expect(failed.statusCode).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await exportsOf(owner.businessId)).toHaveLength(start + 3);
    await csv('/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21', juma.token);
    expect(await exportsOf(owner.businessId)).toHaveLength(start + 4);
  });

  // ---------------------------------------------------------------- 6. permissions and isolation
  it('6. attendants and field attendants are 403; two businesses never see each other; parameters are checked', async () => {
    const field = await api.activeStaff(owner, 'FIELD_ATTENDANT', 'Otieno');
    for (const who of [achieng, field]) {
      expect(errorOf(await get('/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21', who.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
      expect(errorOf(await get('/v1/reports/stock/export.csv', who.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    }

    const twins: { o: Member; loc: string }[] = [];
    for (const name of ['Pacha I', 'Pacha J']) {
      const o = await api.signupOwner(name);
      const p = await product(o, 'Soda', [['piece', 1, '50.00', null]]);
      const loc = await firstLocation(o);
      await accepted(o, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: p.ids[0], quantity: name === 'Pacha I' ? 3 : 4 }] });
      await sell(o, loc, '2026-10-24T10:00:00', [[p.ids[0], 1, '50.00']]);
      twins.push({ o, loc });
    }
    const [i, j] = twins;
    expect(lines((await csv('/v1/reports/sales/export.csv?from=2026-10-24&to=2026-10-24', i.o.token)).body)).toEqual([
      'sale_number,date,time,location,attendant,total,paid_total,balance_due',
      '1,2026-10-24,10:00:00,Main shop,Amina,50.00,0.00,50.00',
    ]);
    expect(lines((await csv('/v1/reports/stock/export.csv', i.o.token)).body).slice(1)).toEqual(['Soda,piece,1,Main shop,2,,']);
    expect(lines((await csv('/v1/reports/stock/export.csv', j.o.token)).body).slice(1)).toEqual(['Soda,piece,1,Main shop,3,,']);
    // The other business's location as a filter finds nothing.
    expect(lines((await csv(`/v1/reports/stock/export.csv?location_id=${j.loc}`, i.o.token)).body)).toHaveLength(1);
    expect(lines((await csv('/v1/reports/sales/export.csv?from=2026-10-24&to=2026-10-24', juma.token)).body)).toHaveLength(1);

    const bad = { status: 422, code: 'VALIDATION_FAILED' };
    const refused = async (url: string) => errorOf(await get(url, wanjiru.token));
    expect(await refused('/v1/reports/sales/export.csv?to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/sales/export.csv?from=2026-07-31&to=2026-10-31')).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
    expect(await refused(`/v1/reports/sales/export.csv?from=2026-10-20&to=2026-10-21&business_id=${owner.businessId}`)).toEqual(bad);
    expect(await refused('/v1/reports/stock/export.csv?include_zero=yes')).toEqual(bad);
    expect(await refused('/v1/reports/stock/export.csv?location_id=nope')).toEqual(bad);
    expect(await refused('/v1/reports/stock/export.csv?from=2026-10-20')).toEqual(bad);
  });
});
