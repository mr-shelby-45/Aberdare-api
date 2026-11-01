import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';
import { type Member, stockApi } from './helpers/stock-api.js';

// Phase G1b: top products and profit (docs/phase-g1-design.md section 11,
// G1b). Numbers in test names refer to that list. Every expected value is a
// literal worked out by hand from the fixture below; none is recomputed with
// the report's own SQL.
//
// Products (sell price / cost price; "-" = no cost recorded):
//   Soda    piece 50.00 / 35.50       crate of 24 1100.00 / 800.00
//   Bread   piece 65.00 / 48.25       (renamed "Bread 400g" after S3)
//   Chai    piece 33.33 / -           box of 10 300.00 / 250.00
//   Pen     piece 10.00 / 6.00
//   Pencil  piece 10.00 / 7.00
// Sales (Nairobi times; sellers Achieng (A) and Baraka (B); Main shop L1, Branch L2):
//   S1 A L1 2026-10-20 09:00     3 Soda pc 150.00, 2 Bread pc 130.00              cost 106.50 + 96.50
//   S2 B L2 2026-10-20 23:59:59  1 Soda crate 1100.00, 3 Chai pc 99.99            cost 800.00 + none
//   S3 A L2 2026-10-21 00:00:00  4 Pen 40.00, 4 Pencil 40.00                      cost 24.00 + 28.00
//   S4 B L1 2026-10-21 10:00     1 Bread 400g pc 65.00, 1 Chai box 300.00,
//                                2 Soda pc at 45.00 = 90.00 (below list)          cost 48.25 + 250.00 + 71.00
//   S5 A L1 2026-10-21 12:00     2 Soda crates 2200.00, cash, then VOIDED (payment reversed)
//   S6 B L1 2026-10-22 08:00     1 Pen 10.00 (outside the main range)
//
// Per product over 2026-10-20..21 (S1 to S4):
//   Soda    pieces 3 + 24 + 2 = 29   value 1340.00   cost 977.50   profit 362.50   without cost 0.00
//   Chai    pieces 3 + 10 = 13       value 399.99    cost 250.00   profit 50.00    without cost 99.99
//   Pen     pieces 4                 value 40.00     cost 24.00    profit 16.00
//   Pencil  pieces 4                 value 40.00     cost 28.00    profit 12.00
//   Bread   pieces 3                 value 195.00    cost 144.75   profit 50.25    (latest name "Bread 400g")

// Report routes allow 30 requests a minute per member (G1a), so the tests
// spread their requests over the owner and Amina, a manager given costs.view
// as an extra permission.
const IP = '198.51.100.211';
const PHONE_BASE = 97_500_000;

interface TopRow {
  product: { id: string; name: string };
  pieces: number;
  value: string;
  cost?: string;
  profit?: string;
  value_without_cost?: string;
}
interface TopProducts {
  range: { from: string; to: string };
  by: string;
  rows: TopRow[];
}
interface ProfitFigures {
  revenue: string;
  cost: string;
  profit: string;
  lines_without_cost: number;
  revenue_without_cost: string;
}
interface Profit {
  range: { from: string; to: string };
  group_by: string;
  totals: { revenue: string; cost: string; profit: string };
  lines_without_cost: number;
  revenue_without_cost: string;
  rows: (ProfitFigures & Record<string, unknown>)[];
}

describe('G1b: top products and profit', { timeout: 300_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let owner: Member;
  let manager: Member;
  let amina: Member;
  let achieng: Member;
  let baraka: Member;
  let L1: string;
  let ids: Record<'soda' | 'bread' | 'chai' | 'pen' | 'pencil', string>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, IP, PHONE_BASE);
    await resetTables();
    api.resetOutboxes();
    ({ owner, manager, amina, achieng, baraka, L1, ids } = await fixture());
  }, 240_000);

  afterAll(async () => {
    await t.app.close();
  });

  const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: IP });
  const ok = async <T>(url: string, token: string): Promise<T> => {
    const res = await get(url, token);
    expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    return res.json() as T;
  };
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });
  const top = (query: string, token: string) => ok<TopProducts>(`/v1/reports/top-products?${query}`, token);
  const profit = (query: string, token: string) => ok<Profit>(`/v1/reports/profit?${query}`, token);

  // Nairobi wall time (UTC+3) as an ISO instant, for command envelopes.
  const nbo = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();

  interface PackSpec {
    name: string;
    units: number;
    sell: string;
    cost: string | null;
  }
  async function product(o: Member, name: string, packs: PackSpec[]) {
    const productId = randomUUID();
    const packIds = packs.map(() => randomUUID());
    const r = await api.sendOne(
      o.token,
      api.command('product.create', {
        product_id: productId,
        name,
        pack_types: packs.map((p, i) => ({
          pack_type_id: packIds[i],
          name: p.name,
          units_per_pack: p.units,
          sell_price: p.sell,
          ...(p.cost === null ? {} : { cost_price: p.cost }),
        })),
      }),
    );
    expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    return { productId, packIds };
  }
  async function receive(m: Member, loc: string, lines: { pack_type_id: string; quantity: number }[]) {
    expect((await api.sendOne(m.token, api.command('stock.receive', { location_id: loc, lines }))).status).toBe('ACCEPTED');
  }
  const line = (pack: string, quantity: number, unit_price: string) => ({ pack_type_id: pack, quantity, unit_price });
  async function sell(m: Member, loc: string, at: string, lines: object[], payments: object[] = []): Promise<string> {
    const saleId = randomUUID();
    const r = await api.sendOne(m.token, api.command('sale.create', { sale_id: saleId, local_ref: saleId.slice(0, 8), location_id: loc, lines, payments }, nbo(at)));
    expect(['ACCEPTED', 'FLAGGED'], JSON.stringify(r)).toContain(r.status);
    return saleId;
  }
  const firstLocation = async (o: Member) => api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;

  async function fixture() {
    const o = await api.signupOwner('Duka la Faida');
    const m = await api.activeStaff(o, 'MANAGER', 'Wanjiru');
    const am = await api.activeStaff(o, 'MANAGER', 'Amina');
    expect((await api.call('PATCH', `/v1/staff/${am.membershipId}`, o.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    const a = await api.activeStaff(o, 'ATTENDANT', 'Achieng');
    const b = await api.activeStaff(o, 'ATTENDANT', 'Baraka');
    const l1 = await firstLocation(o);
    const l2 = await api.newLocation(o, 'Branch');
    const soda = await product(o, 'Soda', [
      { name: 'piece', units: 1, sell: '50.00', cost: '35.50' },
      { name: 'crate of 24', units: 24, sell: '1100.00', cost: '800.00' },
    ]);
    const bread = await product(o, 'Bread', [{ name: 'piece', units: 1, sell: '65.00', cost: '48.25' }]);
    const chai = await product(o, 'Chai', [
      { name: 'piece', units: 1, sell: '33.33', cost: null },
      { name: 'box of 10', units: 10, sell: '300.00', cost: '250.00' },
    ]);
    const pen = await product(o, 'Pen', [{ name: 'piece', units: 1, sell: '10.00', cost: '6.00' }]);
    const pencil = await product(o, 'Pencil', [{ name: 'piece', units: 1, sell: '10.00', cost: '7.00' }]);
    const [sodaPc, sodaCrate] = soda.packIds;
    const [breadPc] = bread.packIds;
    const [chaiPc, chaiBox] = chai.packIds;
    const [penPc] = pen.packIds;
    const [pencilPc] = pencil.packIds;
    for (const loc of [l1, l2]) {
      await receive(m, loc, [
        { pack_type_id: sodaPc, quantity: 20 },
        { pack_type_id: sodaCrate, quantity: 5 },
        { pack_type_id: breadPc, quantity: 20 },
        { pack_type_id: chaiPc, quantity: 20 },
        { pack_type_id: chaiBox, quantity: 5 },
        { pack_type_id: penPc, quantity: 20 },
        { pack_type_id: pencilPc, quantity: 20 },
      ]);
    }
    await sell(a, l1, '2026-10-20T09:00:00', [line(sodaPc, 3, '50.00'), line(breadPc, 2, '65.00')], [{ method: 'CASH', amount: '280.00' }]);
    await sell(b, l2, '2026-10-20T23:59:59', [line(sodaCrate, 1, '1100.00'), line(chaiPc, 3, '33.33')]);
    await sell(a, l2, '2026-10-21T00:00:00', [line(penPc, 4, '10.00'), line(pencilPc, 4, '10.00')], [{ method: 'MPESA', amount: '80.00', mpesa_code: 'QGB1111111' }]);
    const renamed = await api.sendOne(o.token, api.command('product.update', { product_id: bread.productId, name: 'Bread 400g' }));
    expect(renamed.status, JSON.stringify(renamed)).toBe('ACCEPTED');
    await sell(b, l1, '2026-10-21T10:00:00', [line(breadPc, 1, '65.00'), line(chaiBox, 1, '300.00'), line(sodaPc, 2, '45.00')], [{ method: 'CASH', amount: '455.00' }]);
    const s5 = await sell(a, l1, '2026-10-21T12:00:00', [line(sodaCrate, 2, '1100.00')], [{ method: 'CASH', amount: '2200.00' }]);
    const v = await api.sendOne(m.token, api.command('sale.void', { sale_id: s5, reason: 'MISTAKE' }, nbo('2026-10-21T12:30:00')));
    expect(v.status, JSON.stringify(v)).toBe('ACCEPTED');
    await sell(b, l1, '2026-10-22T08:00:00', [line(penPc, 1, '10.00')], [{ method: 'CASH', amount: '10.00' }]);
    return {
      owner: o,
      manager: m,
      amina: am,
      achieng: a,
      baraka: b,
      L1: l1,
      ids: { soda: soda.productId, bread: bread.productId, chai: chai.productId, pen: pen.productId, pencil: pencil.productId },
    };
  }

  const range = 'from=2026-10-20&to=2026-10-21';

  // ---------------------------------------------------------------- 1. top products
  it('1. top products by quantity and by value equal the literals: pieces roll a crate of 24 up, ties by name then id, limit rules', async () => {
    const byQty = await top(range, owner.token);
    expect(byQty.range).toEqual({ from: '2026-10-20', to: '2026-10-21' });
    expect(byQty.by).toBe('quantity');
    expect(byQty.rows).toEqual([
      { product: { id: ids.soda, name: 'Soda' }, pieces: 29, value: '1340.00', cost: '977.50', profit: '362.50', value_without_cost: '0.00' },
      { product: { id: ids.chai, name: 'Chai' }, pieces: 13, value: '399.99', cost: '250.00', profit: '50.00', value_without_cost: '99.99' },
      // Tied on 4 pieces (and on 40.00): "Pen" before "Pencil".
      { product: { id: ids.pen, name: 'Pen' }, pieces: 4, value: '40.00', cost: '24.00', profit: '16.00', value_without_cost: '0.00' },
      { product: { id: ids.pencil, name: 'Pencil' }, pieces: 4, value: '40.00', cost: '28.00', profit: '12.00', value_without_cost: '0.00' },
      // Sold as "Bread" in S1 and "Bread 400g" in S4: the latest line's name.
      { product: { id: ids.bread, name: 'Bread 400g' }, pieces: 3, value: '195.00', cost: '144.75', profit: '50.25', value_without_cost: '0.00' },
    ]);

    const byValue = await top(`${range}&by=value`, owner.token);
    expect(byValue.by).toBe('value');
    expect(byValue.rows.map((r) => [r.product.name, r.value])).toEqual([
      ['Soda', '1340.00'],
      ['Chai', '399.99'],
      ['Bread 400g', '195.00'],
      ['Pen', '40.00'],
      ['Pencil', '40.00'],
    ]);

    // One day: Bread's only line in range carries its old name.
    expect((await top('from=2026-10-20&to=2026-10-20', owner.token)).rows.map((r) => [r.product.name, r.pieces, r.value])).toEqual([
      ['Soda', 27, '1250.00'],
      ['Chai', 3, '99.99'],
      ['Bread', 2, '130.00'],
    ]);

    // Location filter: Main shop has S1 and S4 only (S5 is voided).
    expect((await top(`${range}&location_id=${L1}`, owner.token)).rows.map((r) => [r.product.name, r.pieces, r.value])).toEqual([
      ['Chai', 10, '300.00'],
      ['Soda', 5, '240.00'],
      ['Bread 400g', 3, '195.00'],
    ]);

    expect((await top(`${range}&limit=2`, owner.token)).rows.map((r) => r.product.name)).toEqual(['Soda', 'Chai']);
    expect((await top(`${range}&limit=50`, owner.token)).rows).toHaveLength(5);
    expect((await top('from=2026-10-25&to=2026-10-25', owner.token)).rows).toEqual([]);
    for (const bad of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5', 'limit=-1', 'by=pieces']) {
      expect(errorOf(await get(`/v1/reports/top-products?${range}&${bad}`, owner.token)), bad).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    }
  });

  // ---------------------------------------------------------------- 2. profit
  it('2. profit equals the literals for every group_by; lines without a cost are left out and counted apart; revenue - cost = profit', async () => {
    const byDay = await profit(range, owner.token);
    expect(byDay.group_by).toBe('day');
    expect(byDay.totals).toEqual({ revenue: '1915.00', cost: '1424.25', profit: '490.75' });
    expect(byDay.lines_without_cost).toBe(1);
    expect(byDay.revenue_without_cost).toBe('99.99');
    expect(byDay.rows).toEqual([
      // S1 and S2 (23:59:59 is still the 20th): Chai pieces have no cost.
      { date: '2026-10-20', revenue: '1380.00', cost: '1003.00', profit: '377.00', lines_without_cost: 1, revenue_without_cost: '99.99' },
      // S3 (00:00:00 is the 21st) and S4.
      { date: '2026-10-21', revenue: '535.00', cost: '421.25', profit: '113.75', lines_without_cost: 0, revenue_without_cost: '0.00' },
    ]);

    const byProduct = await profit(`${range}&group_by=product`, owner.token);
    expect(byProduct.totals).toEqual(byDay.totals);
    expect(byProduct.rows).toEqual([
      { product: { id: ids.bread, name: 'Bread 400g' }, revenue: '195.00', cost: '144.75', profit: '50.25', lines_without_cost: 0, revenue_without_cost: '0.00' },
      { product: { id: ids.chai, name: 'Chai' }, revenue: '300.00', cost: '250.00', profit: '50.00', lines_without_cost: 1, revenue_without_cost: '99.99' },
      { product: { id: ids.pen, name: 'Pen' }, revenue: '40.00', cost: '24.00', profit: '16.00', lines_without_cost: 0, revenue_without_cost: '0.00' },
      { product: { id: ids.pencil, name: 'Pencil' }, revenue: '40.00', cost: '28.00', profit: '12.00', lines_without_cost: 0, revenue_without_cost: '0.00' },
      { product: { id: ids.soda, name: 'Soda' }, revenue: '1340.00', cost: '977.50', profit: '362.50', lines_without_cost: 0, revenue_without_cost: '0.00' },
    ]);

    const byAttendant = await profit(`${range}&group_by=attendant`, owner.token);
    expect(byAttendant.totals).toEqual(byDay.totals);
    expect(byAttendant.rows).toEqual([
      { attendant: { membership_id: achieng.membershipId, display_name: 'Achieng' }, revenue: '360.00', cost: '255.00', profit: '105.00', lines_without_cost: 0, revenue_without_cost: '0.00' },
      { attendant: { membership_id: baraka.membershipId, display_name: 'Baraka' }, revenue: '1555.00', cost: '1169.25', profit: '385.75', lines_without_cost: 1, revenue_without_cost: '99.99' },
    ]);

    // A group whose only lines have no cost still appears, with 0.00 costed figures.
    const oneDay = await profit('from=2026-10-20&to=2026-10-20&group_by=product', owner.token);
    expect(oneDay.rows).toEqual([
      { product: { id: ids.bread, name: 'Bread' }, revenue: '130.00', cost: '96.50', profit: '33.50', lines_without_cost: 0, revenue_without_cost: '0.00' },
      { product: { id: ids.chai, name: 'Chai' }, revenue: '0.00', cost: '0.00', profit: '0.00', lines_without_cost: 1, revenue_without_cost: '99.99' },
      { product: { id: ids.soda, name: 'Soda' }, revenue: '1250.00', cost: '906.50', profit: '343.50', lines_without_cost: 0, revenue_without_cost: '0.00' },
    ]);

    // The identity in every row and the totals, checked in cents.
    const cents = (x: string) => BigInt(x.replace('.', ''));
    for (const r of [...byDay.rows, ...byProduct.rows, ...byAttendant.rows, ...oneDay.rows, byDay.totals]) {
      expect(cents(r.revenue) - cents(r.cost)).toBe(cents(r.profit));
    }
    // Costed and uncosted revenue together are every completed sale's total:
    // 280.00 + 1199.99 + 80.00 + 455.00 = 2014.99.
    expect(cents(byDay.totals.revenue) + cents(byDay.revenue_without_cost)).toBe(201_499n);

    const empty = await profit('from=2026-10-25&to=2026-10-25', owner.token);
    expect(empty).toEqual({
      range: { from: '2026-10-25', to: '2026-10-25' },
      group_by: 'day',
      totals: { revenue: '0.00', cost: '0.00', profit: '0.00' },
      lines_without_cost: 0,
      revenue_without_cost: '0.00',
      rows: [],
    });
  });

  // ---------------------------------------------------------------- 3. costs visibility
  it('3. a manager without costs.view is 403 on profit and gets no cost keys in top products; an owner (or a manager given costs.view) sees everything', async () => {
    expect(errorOf(await get(`/v1/reports/profit?${range}`, manager.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    const managerTop = await top(range, manager.token);
    expect(managerTop.rows).toEqual([
      { product: { id: ids.soda, name: 'Soda' }, pieces: 29, value: '1340.00' },
      { product: { id: ids.chai, name: 'Chai' }, pieces: 13, value: '399.99' },
      { product: { id: ids.pen, name: 'Pen' }, pieces: 4, value: '40.00' },
      { product: { id: ids.pencil, name: 'Pencil' }, pieces: 4, value: '40.00' },
      { product: { id: ids.bread, name: 'Bread 400g' }, pieces: 3, value: '195.00' },
    ]);
    for (const row of managerTop.rows) expect(Object.keys(row).sort()).toEqual(['pieces', 'product', 'value']);
    // Nor anywhere in the body (top products by value too).
    const body = (await get(`/v1/reports/top-products?${range}&by=value`, manager.token)).body;
    for (const key of ['cost', 'profit', 'without_cost', '977.50', '362.50']) expect(body).not.toContain(key);

    const ownerTop = await top(range, owner.token);
    for (const row of ownerTop.rows) expect(Object.keys(row).sort()).toEqual(['cost', 'pieces', 'product', 'profit', 'value', 'value_without_cost']);
    expect((await get(`/v1/reports/profit?${range}`, owner.token)).statusCode).toBe(200);
    // The permission decides, not the role: a manager given costs.view sees costs too.
    expect((await top(range, amina.token)).rows).toEqual(ownerTop.rows);
    expect((await profit(range, amina.token)).totals).toEqual({ revenue: '1915.00', cost: '1424.25', profit: '490.75' });

    // Attendants have neither report.
    expect(errorOf(await get(`/v1/reports/top-products?${range}`, achieng.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(errorOf(await get(`/v1/reports/profit?${range}`, achieng.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
  });

  // ---------------------------------------------------------------- 4. voided sales
  it('4. a voided sale (and its reversed payment) never enters these reports', async () => {
    // S5 sold 2 Soda crates (48 pieces, 2200.00, cost 1600.00) on the 21st, then was voided.
    const day = 'from=2026-10-21&to=2026-10-21';
    expect((await top(day, owner.token)).rows.find((r) => r.product.id === ids.soda)).toEqual({
      product: { id: ids.soda, name: 'Soda' },
      pieces: 2,
      value: '90.00',
      cost: '71.00',
      profit: '19.00',
      value_without_cost: '0.00',
    });
    const p = await profit(`${day}&group_by=attendant`, owner.token);
    expect(p.totals).toEqual({ revenue: '535.00', cost: '421.25', profit: '113.75' });
    // Achieng's only completed line that day is S3; S5 is hers but voided.
    expect(p.rows.find((r) => (r.attendant as { membership_id: string }).membership_id === achieng.membershipId)).toMatchObject({ revenue: '80.00', cost: '52.00', profit: '28.00' });
  });

  // ---------------------------------------------------------------- 5. tenant isolation
  it('5. identical data in two businesses never mixes', async () => {
    const twins: { o: Member; loc: string; productId: string }[] = [];
    for (const name of ['Pacha C', 'Pacha D']) {
      const o = await api.signupOwner(name);
      const p = await product(o, 'Soda', [{ name: 'piece', units: 1, sell: '50.00', cost: '35.50' }]);
      const loc = await firstLocation(o);
      await receive(o, loc, [{ pack_type_id: p.packIds[0], quantity: 10 }]);
      await sell(o, loc, '2026-10-24T10:00:00', [line(p.packIds[0], name === 'Pacha C' ? 1 : 3, '50.00')]);
      twins.push({ o, loc, productId: p.productId });
    }
    const [c, d] = twins;
    const day = 'from=2026-10-24&to=2026-10-24';
    expect((await top(day, c.o.token)).rows).toEqual([
      { product: { id: c.productId, name: 'Soda' }, pieces: 1, value: '50.00', cost: '35.50', profit: '14.50', value_without_cost: '0.00' },
    ]);
    expect((await top(day, d.o.token)).rows).toEqual([
      { product: { id: d.productId, name: 'Soda' }, pieces: 3, value: '150.00', cost: '106.50', profit: '43.50', value_without_cost: '0.00' },
    ]);
    expect((await profit(day, c.o.token)).totals).toEqual({ revenue: '50.00', cost: '35.50', profit: '14.50' });
    expect((await profit(day, d.o.token)).totals).toEqual({ revenue: '150.00', cost: '106.50', profit: '43.50' });
    // The other business's location as a filter finds nothing.
    expect((await top(`${day}&location_id=${d.loc}`, c.o.token)).rows).toEqual([]);
    // The fixture's business sees neither.
    expect((await top(day, owner.token)).rows).toEqual([]);
    expect((await profit(day, owner.token)).rows).toEqual([]);
  });

  // ---------------------------------------------------------------- 6. range and parameter rules
  it('6. range, group_by and unknown parameters are checked on both routes', async () => {
    for (const route of ['top-products', 'profit']) {
      const refused = async (query: string) => errorOf(await get(`/v1/reports/${route}?${query}`, amina.token));
      expect(await refused('from=2026-10-22&to=2026-10-21'), route).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      expect(await refused('from=2026-02-30&to=2026-03-01'), route).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      expect(await refused('to=2026-10-21'), route).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      expect(await refused('from=2026-07-31&to=2026-10-31'), route).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
      expect(await refused(`${range}&business_id=${owner.businessId}`), route).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      expect((await get(`/v1/reports/${route}?from=2026-08-01&to=2026-10-31`, amina.token)).statusCode, route).toBe(200);
    }
    const refusedProfit = async (query: string) => errorOf(await get(`/v1/reports/profit?${query}`, amina.token));
    expect(await refusedProfit(`${range}&group_by=location`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refusedProfit(`${range}&location_id=${L1}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // The 92-day range holds every completed sale of the fixture (S6 included).
    expect((await profit('from=2026-08-01&to=2026-10-31', amina.token)).totals).toEqual({ revenue: '1925.00', cost: '1430.25', profit: '494.75' });
  });
});
