import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';

// Phase G1f test 5: the manual walkthrough of docs/phase-g1-walkthrough.md
// (design section 12), step by step, with the same values as the document,
// so it cannot silently go stale. The document's $TODAY is the fake clock's
// Nairobi day here (2026-10-25).

const CODE = '123456';
const OWNER = { phone: '0712000801', email: 'reports-owner@example.com' };
const SECOND = { phone: '0712000809', email: 'reports-second@example.com' };
const ALLOWLIST = ['+254712000801', '+254712000802', '+254712000803', '+254712000804', '+254712000805', '+254712000809', OWNER.email, SECOND.email].join(',');
const TODAY = '2026-10-25';
const R = `from=${TODAY}&to=${TODAY}`;

const SODA = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CRATE = '33333333-3333-4333-8333-333333333333';
const EQ_PRODUCT = '44444444-4444-4444-8444-444444444444';
const EQ = '55555555-5555-4555-8555-555555555555';
const sale = (n: number) => `a1a1a1a1-0000-4000-8000-00000000000${n}`;
const SETTLEMENT = 'e2e2e2e2-0000-4000-8000-000000000001';

let commandSeq = 0;
const commandId = () => `fbfbfbfb-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

interface Result {
  status: string;
  reason?: string;
  result?: Record<string, unknown>;
}

describe('G1f test 5: the Phase G1 walkthrough runs end to end', { timeout: 180_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.216' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json() as T;
  };
  const get = async <T>(url: string, token: string) => ok<T>(await call('GET', url, token));
  const cmd = async (token: string, type: string, payload: object) =>
    ok<{ results: Result[] }>(await call('POST', '/v1/sync/commands', token, { commands: [{ command_id: commandId(), type, occurred_at: t.clock.now().toISOString(), payload }] })).results[0];

  async function signup(who: { phone: string; email: string }, businessName: string) {
    ok(await call('POST', '/v1/auth/signup/start', undefined, who), 202);
    const verified = ok<{ signup_token: string }>(await call('POST', '/v1/auth/signup/verify', undefined, { ...who, phone_code: CODE, email_code: CODE }));
    return ok<{ access_token: string }>(
      await call('POST', '/v1/auth/signup', undefined, {
        signup_token: verified.signup_token,
        owner_name: 'Amina',
        business_name: businessName,
        business_type: 'RETAIL',
        password: 'baobab-sunrise-73',
        pin: '1357',
        device: { name: 'Amina phone', platform: 'android' },
      }),
      201,
    ).access_token;
  }
  async function staff(ownerToken: string, phone: string, name: string, role: 'MANAGER' | 'ATTENDANT' | 'FIELD_ATTENDANT') {
    const created = ok<{ membership_id: string; temp_pin: string }>(await call('POST', '/v1/staff', ownerToken, { phone, display_name: name, role_preset: role }), 201);
    const first = ok<{ setup_token: string }>(await call('POST', '/v1/auth/first-login', undefined, { phone, temp_pin: created.temp_pin }));
    const active = ok<{ access_token: string }>(
      await call('POST', '/v1/auth/staff/activate', undefined, { setup_token: first.setup_token, code: CODE, new_pin: '2468', device: { name: `${name} phone`, platform: 'android' } }),
    );
    return { id: created.membership_id, token: active.access_token };
  }

  it('walks the nine steps of docs/phase-g1-walkthrough.md', async () => {
    // ---- 1. the shop, its people, a day of sales, stock movements and a settlement
    const owner = await signup(OWNER, 'Duka la Amina');
    const shop = (await get<{ locations: { id: string }[] }>('/v1/locations', owner)).locations[0].id;
    const manager = await staff(owner, '0712000802', 'Wanjiru', 'MANAGER');
    const achieng = await staff(owner, '0712000803', 'Achieng', 'ATTENDANT');
    const baraka = await staff(owner, '0712000804', 'Baraka', 'ATTENDANT');
    const otieno = await staff(owner, '0712000805', 'Otieno', 'FIELD_ATTENDANT');
    const van = ok<{ id: string }>(await call('POST', '/v1/locations', owner, { name: 'Van', kind: 'FIELD', assigned_membership_id: otieno.id }), 201).id;

    expect((await cmd(owner, 'product.create', { product_id: SODA, name: 'Soda', pack_types: [{ pack_type_id: PIECE, name: 'piece', units_per_pack: 1, sell_price: '50', cost_price: '35.50' }, { pack_type_id: CRATE, name: 'crate of 24', units_per_pack: 24, sell_price: '1100', cost_price: '800' }] })).status).toBe('ACCEPTED');
    expect((await cmd(owner, 'product.create', { product_id: EQ_PRODUCT, name: '=1+1', pack_types: [{ pack_type_id: EQ, name: 'piece', units_per_pack: 1, sell_price: '10', cost_price: '6' }] })).status).toBe('ACCEPTED');
    expect((await cmd(manager.token, 'stock.receive', { location_id: shop, lines: [{ pack_type_id: PIECE, quantity: 50 }, { pack_type_id: CRATE, quantity: 5 }, { pack_type_id: EQ, quantity: 20 }] })).status).toBe('ACCEPTED');
    expect((await cmd(manager.token, 'stock.issue', { from_location_id: shop, to_location_id: van, lines: [{ pack_type_id: PIECE, quantity: 10 }] })).status).toBe('ACCEPTED');

    const sell = (token: string, n: number, loc: string, lines: [string, number, string][], payments: object[]) =>
      cmd(token, 'sale.create', { sale_id: sale(n), local_ref: `W-${n}`, location_id: loc, lines: lines.map(([pack_type_id, quantity, unit_price]) => ({ pack_type_id, quantity, unit_price })), payments });
    expect((await sell(achieng.token, 1, shop, [[PIECE, 2, '50']], [{ method: 'CASH', amount: '100' }])).status).toBe('ACCEPTED');
    expect((await sell(achieng.token, 2, shop, [[CRATE, 1, '1100']], [{ method: 'MPESA', amount: '1100', mpesa_code: 'QWK1111111' }])).status).toBe('ACCEPTED');
    expect((await sell(baraka.token, 3, shop, [[EQ, 3, '10']], [{ method: 'CASH', amount: '10' }, { method: 'MPESA', amount: '20', mpesa_code: 'QWK2222222' }])).status).toBe('ACCEPTED');
    expect((await sell(baraka.token, 4, shop, [[PIECE, 1, '50']], [])).status).toBe('ACCEPTED');
    expect((await sell(achieng.token, 5, shop, [[PIECE, 1, '50']], [{ method: 'CASH', amount: '50' }])).status).toBe('ACCEPTED');
    // Below the list price is allowed (no flag); the exceptions report shows it.
    expect((await sell(baraka.token, 6, shop, [[PIECE, 2, '45']], [{ method: 'CASH', amount: '90' }])).status).toBe('ACCEPTED');
    expect((await sell(otieno.token, 7, van, [[PIECE, 4, '50']], [{ method: 'CASH', amount: '200' }])).status).toBe('ACCEPTED');
    expect((await cmd(manager.token, 'sale.void', { sale_id: sale(5), reason: 'MISTAKE' })).status).toBe('ACCEPTED');
    expect((await cmd(manager.token, 'stock.adjust', { location_id: shop, pack_type_id: EQ, quantity_change: -1, reason: 'DAMAGED' })).status).toBe('ACCEPTED');
    expect((await cmd(manager.token, 'stock.count', { location_id: shop, lines: [{ pack_type_id: PIECE, expected_quantity: 35, counted_quantity: 34 }] })).status).toBe('ACCEPTED');
    expect((await call('GET', '/v1/sync/snapshot?limit=1', otieno.token)).statusCode).toBe(200);
    const closed = await cmd(manager.token, 'settlement.close', { settlement_id: SETTLEMENT, field_location_id: van, cash_received: '200', lines: [{ pack_type_id: PIECE, counted_quantity: 5 }] });
    expect(closed).toMatchObject({ status: 'ACCEPTED', result: { settlement_id: SETTLEMENT, cash_variance: '0.00' } });

    // ---- 2. the sales report, by day and by attendant
    const byDay = await get<Record<string, unknown>>(`/v1/reports/sales?${R}`, manager.token);
    expect(byDay).toEqual({
      range: { from: TODAY, to: TODAY },
      group_by: 'day',
      totals: { sale_count: 6, total: '1570.00', paid_total: '1520.00', balance_due: '50.00' },
      rows: [{ date: TODAY, sale_count: 6, total: '1570.00', paid_total: '1520.00', balance_due: '50.00' }],
      payments: { cash: '400.00', mpesa_unverified: '1120.00', mpesa_verified: '0.00' },
    });
    const byAttendant = await get<{ rows: unknown[] }>(`/v1/reports/sales?${R}&group_by=attendant`, manager.token);
    expect(byAttendant.rows).toEqual([
      { attendant: { membership_id: achieng.id, display_name: 'Achieng' }, sale_count: 2, total: '1200.00', paid_total: '1200.00', balance_due: '0.00' },
      { attendant: { membership_id: baraka.id, display_name: 'Baraka' }, sale_count: 3, total: '170.00', paid_total: '120.00', balance_due: '50.00' },
      { attendant: { membership_id: otieno.id, display_name: 'Otieno' }, sale_count: 1, total: '200.00', paid_total: '200.00', balance_due: '0.00' },
    ]);
    const listed = await get<{ sales: { sale_number: number; status: string; total: string }[] }>('/v1/sales?limit=20', manager.token);
    expect(listed.sales.filter((s) => s.status === 'COMPLETED').map((s) => s.total).sort()).toEqual(['100.00', '1100.00', '200.00', '30.00', '50.00', '90.00']);

    // ---- 3. top products and profit
    expect((await get<{ rows: unknown[] }>(`/v1/reports/top-products?${R}`, manager.token)).rows).toEqual([
      { product: { id: SODA, name: 'Soda' }, pieces: 33, value: '1540.00' },
      { product: { id: EQ_PRODUCT, name: '=1+1' }, pieces: 3, value: '30.00' },
    ]);
    const refused = await call('GET', `/v1/reports/profit?${R}`, manager.token);
    expect([refused.statusCode, (refused.json() as { error: { code: string } }).error.code]).toEqual([403, 'PERMISSION_DENIED']);
    const profit = await get<Record<string, unknown>>(`/v1/reports/profit?${R}&group_by=product`, owner);
    expect(profit).toMatchObject({
      totals: { revenue: '1570.00', cost: '1137.50', profit: '432.50' },
      lines_without_cost: 0,
      rows: [
        { product: { id: EQ_PRODUCT, name: '=1+1' }, revenue: '30.00', cost: '18.00', profit: '12.00' },
        { product: { id: SODA, name: 'Soda' }, revenue: '1540.00', cost: '1119.50', profit: '420.50' },
      ],
    });

    // ---- 4. stock and shrinkage
    const stock = await get<{ totals: unknown; rows: unknown[] }>('/v1/reports/stock', owner);
    expect(stock.totals).toEqual({ pieces: 151, pools: 4, negative_pools: 0, value_at_cost: '4680.50', pools_without_cost: 0 });
    const list = await get<{ balances: { pack_type_id: string; location_id: string; quantity: number }[] }>('/v1/stock', manager.token);
    expect(list.balances.map((b) => [b.pack_type_id === PIECE ? 'piece' : b.pack_type_id === CRATE ? 'crate' : 'eq', b.location_id === van ? 'van' : 'shop', b.quantity]).sort((x, y) => x.join().localeCompare(y.join()))).toEqual([
      ['crate', 'shop', 4],
      ['eq', 'shop', 16],
      ['piece', 'shop', 34],
      ['piece', 'van', 5],
    ]);
    expect((await get<{ rows: unknown[] }>(`/v1/reports/shrinkage?${R}`, manager.token)).rows).toEqual([
      { reason: 'DAMAGED', units_lost: 1, units_found: 0, net_units: -1 },
      { reason: 'COUNT', units_lost: 1, units_found: 0, net_units: -1 },
      { reason: 'SETTLEMENT', units_lost: 1, units_found: 0, net_units: -1 },
    ]);
    expect((await get<{ rows: unknown[] }>(`/v1/reports/shrinkage?${R}&group_by=person`, manager.token)).rows).toEqual([
      { person: { membership_id: otieno.id, display_name: 'Otieno' }, units_lost: 1, units_found: 0, net_units: -1 },
      { person: { membership_id: manager.id, display_name: 'Wanjiru' }, units_lost: 2, units_found: 0, net_units: -2 },
    ]);

    // ---- 5. exceptions and receivables
    const voids = await get<{ totals: unknown; rows: Record<string, unknown>[] }>(`/v1/reports/exceptions?type=voids&${R}`, manager.token);
    expect(voids.totals).toEqual({ count: 1, total: '50.00' });
    expect(voids.rows[0]).toMatchObject({ sale_number: 5, reason: 'MISTAKE', voided_by: { membership_id: manager.id, display_name: 'Wanjiru' }, approved_by: null });
    const below = await get<{ totals: unknown; rows: Record<string, unknown>[] }>(`/v1/reports/exceptions?type=below_list&${R}`, manager.token);
    expect(below.totals).toEqual({ lines: 1, difference: '10.00' });
    expect(below.rows[0]).toMatchObject({ sale_number: 6, quantity: 2, unit_price: '45.00', list_price: '50.00', difference: '10.00' });
    const unpaid = await get<{ totals: unknown; rows: Record<string, unknown>[] }>('/v1/reports/receivables?type=unpaid', manager.token);
    expect(unpaid.totals).toEqual({ count: 1, balance_due: '50.00' });
    expect(unpaid.rows[0]).toMatchObject({ sale_number: 4, age_days: 0, balance_due: '50.00' });
    const mpesa = await get<{ totals: unknown; rows: Record<string, unknown>[] }>('/v1/reports/receivables?type=unverified_mpesa', manager.token);
    expect(mpesa.totals).toEqual({ count: 2, amount: '1120.00' });
    // Same time (the test clock stands still between commands), so the list orders them by payment id: compare by sale number.
    expect(mpesa.rows.map((r) => [r.sale_number as number, r.mpesa_code, r.duplicate]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([
      [2, 'QWK1111111', false],
      [3, 'QWK2222222', false],
    ]);

    // ---- 6. the field report
    expect((await get<{ rows: unknown[] }>(`/v1/reports/field?${R}`, manager.token)).rows).toEqual([
      { attendant: { membership_id: otieno.id, display_name: 'Otieno' }, settlement_count: 1, expected_cash: '200.00', cash_received: '200.00', cash_variance: '0.00', mpesa_unverified_total: '0.00', unpaid_total: '0.00', shortage_units: 1, surplus_units: 0 },
    ]);

    // ---- 7. an attendant's own day
    expect(await get(`/v1/reports/my-day`, baraka.token)).toEqual({
      date: TODAY,
      sale_count: 3,
      total: '170.00',
      paid_total: '120.00',
      balance_due: '50.00',
      voided_count: 0,
      payments: { cash: '100.00', mpesa_unverified: '20.00', mpesa_verified: '0.00' },
    });
    const refusedSales = await call('GET', `/v1/reports/sales?${R}`, baraka.token);
    expect(refusedSales.statusCode).toBe(403);

    // ---- 8. the CSV files
    const salesCsv = await call('GET', `/v1/reports/sales/export.csv?${R}`, manager.token);
    expect(salesCsv.statusCode).toBe(200);
    expect(salesCsv.headers['content-disposition']).toBe(`attachment; filename="sales_${TODAY}_${TODAY}.csv"`);
    const rows = salesCsv.body.slice(1, -2).split('\r\n');
    expect(rows[0]).toBe('sale_number,date,time,location,attendant,total,paid_total,balance_due');
    expect(rows.slice(1).map((l) => l.split(',')[5])).toEqual(['100.00', '1100.00', '30.00', '50.00', '90.00', '200.00']);
    const stockCsv = (await call('GET', '/v1/reports/stock/export.csv', manager.token)).body;
    expect(stockCsv).toContain("\r\n'=1+1,piece,1,Main shop,16\r\n");

    // ---- 9. a second business sees none of it
    const second = await signup(SECOND, 'Duka Jirani');
    expect((await get<{ totals: unknown }>(`/v1/reports/sales?${R}`, second)).totals).toEqual({ sale_count: 0, total: '0.00', paid_total: '0.00', balance_due: '0.00' });
    expect((await get<{ totals: unknown }>('/v1/reports/stock', second)).totals).toEqual({ pieces: 0, pools: 0, negative_pools: 0, value_at_cost: '0.00', pools_without_cost: 0 });
    expect((await get<{ rows: unknown[] }>('/v1/reports/receivables?type=unpaid', second)).rows).toEqual([]);
  });
});
