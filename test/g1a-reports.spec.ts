import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container.js';
import { TRANSACTION_TIMEOUT } from '../src/common/auth/transaction-timeout.decorator.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';
import { type Member, stockApi } from './helpers/stock-api.js';

// Phase G1a: the sales report and "my day" (docs/phase-g1-design.md section
// 11, G1a). Numbers in test names refer to that list. Every expected value is
// a literal worked out by hand from the fixture below; none is recomputed
// with the report's own SQL.
//
// The fixture (Nairobi times; Nairobi is UTC+3). Sellers Achieng (A), Baraka
// (B) and Chebet (C) are attendants; Main shop (L1) and Branch (L2).
//   S_1 B L1 2026-10-19 23:59:59  1 pen 33.33                cash 33.33
//   S0  B L2 2026-10-20 00:00:00  1 sweets 19.99             M-Pesa 19.99
//   S1  A L1 2026-10-20 10:00     3 pens 99.99               cash 99.99
//   S2  A L2 2026-10-20 15:00     1 sweets + 1 maize 199.99  M-Pesa 199.99
//   S3  B L1 2026-10-20 18:00     2 maize 360.00             cash 100.00 + M-Pesa 200.00 (owes 60.00)
//   S4  B L1 2026-10-21 09:00     1 maize carton 4200.00     unpaid (owes 4200.00)
//   S6  C L1 2026-10-21 12:00     1 pen 33.33                cash 33.33, then VOIDED (payment reversed)
//   S7  A L1 2026-10-21 14:00     1 sweets + 1 pen 53.32     cash 20.00, M-Pesa 33.32 attached on 10-22
//   S5  C L2 2026-10-21 23:59:59  5 sweets 99.95             cash 100.00 (overpaid)
//   S8  C L2 2026-10-22 00:00:00  1 pen 33.33                cash 33.33

const IP = '198.51.100.210';
const PHONE_BASE = 97_000_000;

interface Totals {
  sale_count: number;
  total: string;
  paid_total: string;
  balance_due: string;
}
interface SalesReport {
  range: { from: string; to: string };
  group_by: string;
  totals: Totals;
  rows: (Totals & Record<string, unknown>)[];
  payments: { cash: string; mpesa_unverified: string; mpesa_verified: string };
}

describe('G1a: sales report and my day', { timeout: 300_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  // The fixture's business.
  let owner: Member;
  let manager: Member;
  let achieng: Member;
  let baraka: Member;
  let chebet: Member;
  let L1: string;
  let L2: string;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, IP, PHONE_BASE);
    await resetTables();
    api.resetOutboxes();
    ({ owner, manager, achieng, baraka, chebet, L1, L2 } = await fixture());
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
  const sales = (query: string, token: string) => ok<SalesReport>(`/v1/reports/sales?${query}`, token);

  // Nairobi wall time (UTC+3) as an ISO instant, for command envelopes.
  const nbo = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();

  async function product(o: Member, name: string, piece: string, packName: string, units: number, packPrice: string) {
    const ids = { piece: randomUUID(), pack: randomUUID() };
    const r = await api.sendOne(
      o.token,
      api.command('product.create', {
        product_id: randomUUID(),
        name,
        pack_types: [
          { pack_type_id: ids.piece, name: 'piece', units_per_pack: 1, sell_price: piece },
          { pack_type_id: ids.pack, name: packName, units_per_pack: units, sell_price: packPrice },
        ],
      }),
    );
    expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    return ids;
  }
  async function receive(m: Member, loc: string, lines: { pack_type_id: string; quantity: number }[]) {
    expect((await api.sendOne(m.token, api.command('stock.receive', { location_id: loc, lines }))).status).toBe('ACCEPTED');
  }
  const line = (pack: string, quantity: number, unit_price: string) => ({ pack_type_id: pack, quantity, unit_price });
  const cash = (amount: string) => ({ method: 'CASH', amount });
  const mpesa = (amount: string, mpesa_code: string) => ({ method: 'MPESA', amount, mpesa_code });
  async function sell(m: Member, loc: string, at: string, lines: object[], payments: object[] = []): Promise<string> {
    const saleId = randomUUID();
    const r = await api.sendOne(m.token, api.command('sale.create', { sale_id: saleId, local_ref: saleId.slice(0, 8), location_id: loc, lines, payments }, nbo(at)));
    expect(['ACCEPTED', 'FLAGGED'], JSON.stringify(r)).toContain(r.status);
    return saleId;
  }

  async function fixture() {
    const o = await api.signupOwner('Duka la Ripoti');
    const m = await api.activeStaff(o, 'MANAGER', 'Wanjiru');
    const a = await api.activeStaff(o, 'ATTENDANT', 'Achieng');
    const b = await api.activeStaff(o, 'ATTENDANT', 'Baraka');
    const c = await api.activeStaff(o, 'ATTENDANT', 'Chebet');
    const l1 = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;
    const l2 = await api.newLocation(o, 'Branch');
    const pen = await product(o, 'Pen', '33.33', 'box of 12', 12, '399.96');
    const sweets = await product(o, 'Sweets', '19.99', 'jar of 50', 50, '999.50');
    const maize = await product(o, 'Maize flour 2kg', '180', 'carton of 24', 24, '4200.00');
    for (const loc of [l1, l2]) {
      await receive(m, loc, [
        { pack_type_id: pen.piece, quantity: 50 },
        { pack_type_id: sweets.piece, quantity: 50 },
        { pack_type_id: maize.piece, quantity: 50 },
        { pack_type_id: maize.pack, quantity: 5 },
      ]);
    }
    await sell(b, l1, '2026-10-19T23:59:59', [line(pen.piece, 1, '33.33')], [cash('33.33')]);
    await sell(b, l2, '2026-10-20T00:00:00', [line(sweets.piece, 1, '19.99')], [mpesa('19.99', 'QDD4444444')]);
    await sell(a, l1, '2026-10-20T10:00:00', [line(pen.piece, 3, '33.33')], [cash('99.99')]);
    await sell(a, l2, '2026-10-20T15:00:00', [line(sweets.piece, 1, '19.99'), line(maize.piece, 1, '180')], [mpesa('199.99', 'QAA1111111')]);
    await sell(b, l1, '2026-10-20T18:00:00', [line(maize.piece, 2, '180')], [cash('100.00'), mpesa('200.00', 'QBB2222222')]);
    await sell(b, l1, '2026-10-21T09:00:00', [line(maize.pack, 1, '4200.00')]);
    const s6 = await sell(c, l1, '2026-10-21T12:00:00', [line(pen.piece, 1, '33.33')], [cash('33.33')]);
    const s7 = await sell(a, l1, '2026-10-21T14:00:00', [line(sweets.piece, 1, '19.99'), line(pen.piece, 1, '33.33')], [cash('20.00')]);
    await sell(c, l2, '2026-10-21T23:59:59', [line(sweets.piece, 5, '19.99')], [cash('100.00')]);
    await sell(c, l2, '2026-10-22T00:00:00', [line(pen.piece, 1, '33.33')], [cash('33.33')]);
    const v = await api.sendOne(m.token, api.command('sale.void', { sale_id: s6, reason: 'MISTAKE' }, nbo('2026-10-21T13:00:00')));
    expect(v.status, JSON.stringify(v)).toBe('ACCEPTED');
    const p = await api.sendOne(a.token, api.command('payment.attach', { sale_id: s7, payments: [mpesa('33.32', 'QCC3333333')] }, nbo('2026-10-22T09:00:00')));
    expect(p.status, JSON.stringify(p)).toBe('ACCEPTED');
    return { owner: o, manager: m, achieng: a, baraka: b, chebet: c, L1: l1, L2: l2 };
  }

  // ---------------------------------------------------------------- 1. date rules
  it('1. Nairobi days: 23:59:59 and 00:00:00 land on different days, to is inclusive, bad ranges are 422', async () => {
    const four = await sales('from=2026-10-19&to=2026-10-22', owner.token);
    expect(four.rows).toEqual([
      { date: '2026-10-19', sale_count: 1, total: '33.33', paid_total: '33.33', balance_due: '0.00' },
      { date: '2026-10-20', sale_count: 4, total: '679.97', paid_total: '619.97', balance_due: '60.00' },
      { date: '2026-10-21', sale_count: 3, total: '4353.27', paid_total: '153.32', balance_due: '4200.00' },
      { date: '2026-10-22', sale_count: 1, total: '33.33', paid_total: '33.33', balance_due: '0.00' },
    ]);
    // One-day ranges: the sale at 2026-10-19T20:59:59Z is the 19th's only sale,
    // the one at 2026-10-19T21:00:00Z is the 20th's; the 21st ends at 20:59:59Z.
    expect((await sales('from=2026-10-19&to=2026-10-19', owner.token)).totals).toEqual({ sale_count: 1, total: '33.33', paid_total: '33.33', balance_due: '0.00' });
    expect((await sales('from=2026-10-22&to=2026-10-22', owner.token)).totals).toEqual({ sale_count: 1, total: '33.33', paid_total: '33.33', balance_due: '0.00' });
    expect((await sales('from=2026-10-21&to=2026-10-21', owner.token)).totals).toEqual({ sale_count: 3, total: '4353.27', paid_total: '153.32', balance_due: '4200.00' });

    const refused = async (query: string) => errorOf(await get(`/v1/reports/sales?${query}`, owner.token));
    expect(await refused('from=2026-10-22&to=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('from=2026-02-30&to=2026-03-01')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('from=2026-10-1&to=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('to=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('from=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // 2026-07-31 to 2026-10-31 is 1 + 31 + 30 + 31 = 93 days; from 2026-08-01, 92.
    expect(await refused('from=2026-07-31&to=2026-10-31')).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
    const max = await sales('from=2026-08-01&to=2026-10-31', owner.token);
    expect(max.range).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(max.totals).toEqual({ sale_count: 9, total: '5099.90', paid_total: '839.95', balance_due: '4260.00' });
  });

  // ---------------------------------------------------------------- 2. the sales report
  it('2. totals, every group_by, the filters and the payments split equal the hand-worked values; voided sales are left out', async () => {
    const range = 'from=2026-10-20&to=2026-10-21';
    const byDay = await sales(range, manager.token);
    expect(byDay.group_by).toBe('day');
    expect(byDay.totals).toEqual({ sale_count: 7, total: '5033.24', paid_total: '773.29', balance_due: '4260.00' });
    expect(byDay.payments).toEqual({ cash: '319.99', mpesa_unverified: '453.30', mpesa_verified: '0.00' });
    expect(byDay.rows).toEqual([
      { date: '2026-10-20', sale_count: 4, total: '679.97', paid_total: '619.97', balance_due: '60.00' },
      { date: '2026-10-21', sale_count: 3, total: '4353.27', paid_total: '153.32', balance_due: '4200.00' },
    ]);

    const byAttendant = await sales(`${range}&group_by=attendant`, manager.token);
    expect(byAttendant.totals).toEqual(byDay.totals);
    expect(byAttendant.rows).toEqual([
      { attendant: { membership_id: achieng.membershipId, display_name: 'Achieng' }, sale_count: 3, total: '353.30', paid_total: '353.30', balance_due: '0.00' },
      { attendant: { membership_id: baraka.membershipId, display_name: 'Baraka' }, sale_count: 3, total: '4579.99', paid_total: '319.99', balance_due: '4260.00' },
      { attendant: { membership_id: chebet.membershipId, display_name: 'Chebet' }, sale_count: 1, total: '99.95', paid_total: '100.00', balance_due: '0.00' },
    ]);

    const byLocation = await sales(`${range}&group_by=location`, manager.token);
    expect(byLocation.rows).toEqual([
      { location: { id: L2, name: 'Branch' }, sale_count: 3, total: '319.93', paid_total: '319.98', balance_due: '0.00' },
      { location: { id: L1, name: 'Main shop' }, sale_count: 4, total: '4713.31', paid_total: '453.31', balance_due: '4260.00' },
    ]);
    expect(byLocation.payments).toEqual(byDay.payments);

    const filtered = await sales(`${range}&location_id=${L1}&attendant_id=${baraka.membershipId}`, manager.token);
    expect(filtered.totals).toEqual({ sale_count: 2, total: '4560.00', paid_total: '300.00', balance_due: '4260.00' });
    expect(filtered.payments).toEqual({ cash: '100.00', mpesa_unverified: '200.00', mpesa_verified: '0.00' });

    // Achieng's payment attached on the 22nd still counts on her sale's day.
    const achiengOnly = await sales(`${range}&attendant_id=${achieng.membershipId}`, manager.token);
    expect(achiengOnly.totals).toEqual({ sale_count: 3, total: '353.30', paid_total: '353.30', balance_due: '0.00' });
    expect(achiengOnly.payments).toEqual({ cash: '119.99', mpesa_unverified: '233.31', mpesa_verified: '0.00' });

    // Chebet's voided sale (33.33 cash, reversed) is nowhere: her only sale is S5.
    const chebetOnly = await sales(`${range}&attendant_id=${chebet.membershipId}`, manager.token);
    expect(chebetOnly.totals).toEqual({ sale_count: 1, total: '99.95', paid_total: '100.00', balance_due: '0.00' });
    expect(chebetOnly.payments).toEqual({ cash: '100.00', mpesa_unverified: '0.00', mpesa_verified: '0.00' });
  });

  // ---------------------------------------------------------------- 3. cross-check with /v1/sales
  it('3. sale_count and total equal the sum of paging GET /v1/sales over the same range', async () => {
    const report = await sales('from=2026-10-20&to=2026-10-21', manager.token);
    let cursor: string | null = null;
    let count = 0;
    let cents = 0n;
    do {
      const page: { sales: { total: string }[]; next_cursor: string | null } = await ok(
        `/v1/sales?status=COMPLETED&from=2026-10-19T21:00:00.000Z&to=2026-10-21T21:00:00.000Z&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        manager.token,
      );
      for (const s of page.sales) {
        count++;
        cents += BigInt(s.total.replace('.', ''));
      }
      cursor = page.next_cursor;
    } while (cursor);
    expect(count).toBe(7);
    expect(report.totals.sale_count).toBe(count);
    expect(report.totals.total).toBe(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
  });

  // ---------------------------------------------------------------- 4. exactness
  it('4. 1,000 sales of 0.10 sum to exactly 100.00', async () => {
    const o = await api.signupOwner('Duka la Senti');
    const tiny = await product(o, 'Sweet', '0.10', 'bag of 100', 100, '10.00');
    await receive(o, api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id, [{ pack_type_id: tiny.piece, quantity: 1000 }]);
    const loc = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;
    for (let batch = 0; batch < 10; batch++) {
      const cmds = Array.from({ length: 100 }, (_, i) =>
        api.command(
          'sale.create',
          { sale_id: randomUUID(), local_ref: `T${batch}-${i}`, location_id: loc, lines: [line(tiny.piece, 1, '0.10')], payments: [cash('0.10')] },
          nbo(`2026-10-23T${String(8 + batch).padStart(2, '0')}:00:00`),
        ),
      );
      const results = await api.send(o.token, cmds);
      expect(results.every((r) => r.status === 'ACCEPTED')).toBe(true);
    }
    const r = await sales('from=2026-10-23&to=2026-10-23', o.token);
    expect(r.totals).toEqual({ sale_count: 1000, total: '100.00', paid_total: '100.00', balance_due: '0.00' });
    expect(r.payments).toEqual({ cash: '100.00', mpesa_unverified: '0.00', mpesa_verified: '0.00' });
  });

  // ---------------------------------------------------------------- 5. permissions
  it('5. attendants, field attendants are 403; manager and owner succeed; suspended and revoked are refused; business_id is 422', async () => {
    const q = '/v1/reports/sales?from=2026-10-20&to=2026-10-21';
    const field = await api.activeStaff(owner, 'FIELD_ATTENDANT', 'Otieno');
    expect(errorOf(await get(q, achieng.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(errorOf(await get(q, field.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect((await get(q, manager.token)).statusCode).toBe(200);
    expect((await get(q, owner.token)).statusCode).toBe(200);

    const suspended = await api.activeStaff(owner, 'MANAGER', 'Mwangi');
    expect((await get(q, suspended.token)).statusCode).toBe(200);
    expect((await api.post(`/v1/staff/${suspended.membershipId}/suspend`, {}, owner.token)).statusCode).toBe(204);
    expect(errorOf(await get(q, suspended.token))).toEqual({ status: 403, code: 'MEMBERSHIP_INACTIVE' });

    const revoked = await api.activeStaff(owner, 'MANAGER', 'Njeri');
    expect((await get(q, revoked.token)).statusCode).toBe(200);
    expect((await api.call('DELETE', `/v1/devices/${revoked.deviceId}`, owner.token)).statusCode).toBe(204);
    expect(errorOf(await get(q, revoked.token))).toEqual({ status: 403, code: 'DEVICE_REVOKED' });

    expect(errorOf(await get(`${q}&business_id=${owner.businessId}`, owner.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // No token at all.
    expect((await t.app.inject({ method: 'GET', url: q, remoteAddress: IP })).statusCode).toBe(401);
  });

  // ---------------------------------------------------------------- 6. tenant isolation
  it('6. identical data in two businesses never mixes', async () => {
    const twins: { o: Member; loc: string }[] = [];
    for (const name of ['Pacha A', 'Pacha B']) {
      const o = await api.signupOwner(name);
      const pen = await product(o, 'Pen', '33.33', 'box of 12', 12, '399.96');
      const loc = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;
      await receive(o, loc, [{ pack_type_id: pen.piece, quantity: 10 }]);
      await sell(o, loc, '2026-10-24T10:00:00', [line(pen.piece, 1, '33.33')], [cash('33.33')]);
      if (name === 'Pacha B') await sell(o, loc, '2026-10-24T11:00:00', [line(pen.piece, 2, '33.33')], [cash('66.66')]);
      twins.push({ o, loc });
    }
    const [a, b] = twins;
    expect((await sales('from=2026-10-24&to=2026-10-24', a.o.token)).totals).toEqual({ sale_count: 1, total: '33.33', paid_total: '33.33', balance_due: '0.00' });
    expect((await sales('from=2026-10-24&to=2026-10-24', b.o.token)).totals).toEqual({ sale_count: 2, total: '99.99', paid_total: '99.99', balance_due: '0.00' });
    // The other business's location as a filter finds nothing.
    expect((await sales(`from=2026-10-24&to=2026-10-24&location_id=${b.loc}`, a.o.token)).totals).toEqual({ sale_count: 0, total: '0.00', paid_total: '0.00', balance_due: '0.00' });
    // The fixture's business is untouched by both.
    expect((await sales('from=2026-10-24&to=2026-10-24', owner.token)).totals.sale_count).toBe(0);
  });

  // ---------------------------------------------------------------- 7. my day, timeout, rate limit
  it('7a. my day: only the caller’s own sales of the day, completed and voided counts; dates outside the last 7 days are 422', async () => {
    const day = (who: Member, date?: string) => ok<Record<string, unknown>>(`/v1/reports/my-day${date ? `?date=${date}` : ''}`, who.token);
    // The clock is 2026-10-25 12:00 Nairobi.
    expect(await day(achieng, '2026-10-20')).toEqual({
      date: '2026-10-20',
      sale_count: 2,
      total: '299.98',
      paid_total: '299.98',
      balance_due: '0.00',
      voided_count: 0,
      payments: { cash: '99.99', mpesa_unverified: '199.99', mpesa_verified: '0.00' },
    });
    expect(await day(chebet, '2026-10-21')).toEqual({
      date: '2026-10-21',
      sale_count: 1,
      total: '99.95',
      paid_total: '100.00',
      balance_due: '0.00',
      voided_count: 1,
      payments: { cash: '100.00', mpesa_unverified: '0.00', mpesa_verified: '0.00' },
    });
    expect(await day(achieng)).toEqual({
      date: '2026-10-25',
      sale_count: 0,
      total: '0.00',
      paid_total: '0.00',
      balance_due: '0.00',
      voided_count: 0,
      payments: { cash: '0.00', mpesa_unverified: '0.00', mpesa_verified: '0.00' },
    });
    // A manager's own day holds only the manager's own sales (none), not the shop's.
    expect(await day(manager, '2026-10-20')).toMatchObject({ sale_count: 0, total: '0.00', voided_count: 0 });
    // 2026-10-19 is 6 days back (allowed), 2026-10-18 is 7 (refused), tomorrow is refused.
    expect((await day(baraka, '2026-10-19')).sale_count).toBe(1);
    expect(errorOf(await get('/v1/reports/my-day?date=2026-10-18', baraka.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await get('/v1/reports/my-day?date=2026-10-26', baraka.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await get('/v1/reports/my-day?date=2026-02-30', baraka.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await get(`/v1/reports/my-day?membership_id=${chebet.membershipId}`, baraka.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('7b. a field attendant’s my day works the same', async () => {
    const field = await api.activeStaff(owner, 'FIELD_ATTENDANT', 'Kamau');
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: field.membershipId }, owner.token)).id;
    const pen = await product(owner, 'Marker', '45.50', 'box of 10', 10, '455.00');
    await receive(manager, L1, [{ pack_type_id: pen.piece, quantity: 10 }]);
    const issued = await api.sendOne(manager.token, api.command('stock.issue', { from_location_id: L1, to_location_id: van, lines: [{ pack_type_id: pen.piece, quantity: 4 }] }));
    expect(issued.status, JSON.stringify(issued)).toBe('ACCEPTED');
    await sell(field, van, '2026-10-24T09:00:00', [line(pen.piece, 2, '45.50')], [mpesa('91.00', 'QFF5555555')]);
    expect(await ok(`/v1/reports/my-day?date=2026-10-24`, field.token)).toEqual({
      date: '2026-10-24',
      sale_count: 1,
      total: '91.00',
      paid_total: '91.00',
      balance_due: '0.00',
      voided_count: 0,
      payments: { cash: '0.00', mpesa_unverified: '91.00', mpesa_verified: '0.00' },
    });
    expect(errorOf(await get('/v1/reports/sales?from=2026-10-24&to=2026-10-24', field.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('7c. a report statement that runs past 8 seconds is 503 REPORT_TOO_SLOW, not a 500', async () => {
    // A held lock makes the report's SELECT wait; statement_timeout counts the wait.
    const holder = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE sale IN ACCESS EXCLUSIVE MODE');
      const release = setTimeout(() => void holder.query('ROLLBACK'), 12_000);
      const started = Date.now();
      const res = await get('/v1/reports/sales?from=2026-10-20&to=2026-10-21', owner.token);
      const elapsed = Date.now() - started;
      clearTimeout(release);
      expect(errorOf(res), res.body).toEqual({ status: 503, code: 'REPORT_TOO_SLOW' });
      expect(elapsed).toBeGreaterThanOrEqual(7_900);
      expect(elapsed).toBeLessThan(10_000);
      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }
    // The next report runs normally.
    expect((await sales('from=2026-10-20&to=2026-10-21', owner.token)).totals.sale_count).toBe(7);
  }, 60_000);

  it('7e. a report that takes 6 seconds still answers 200 (the 10 second report transaction, not Prisma’s 5)', async () => {
    const holder = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE sale IN ACCESS EXCLUSIVE MODE');
      const release = setTimeout(() => void holder.query('ROLLBACK'), 6_000);
      const started = Date.now();
      const res = await get('/v1/reports/sales?from=2026-10-20&to=2026-10-21&group_by=attendant', owner.token);
      const elapsed = Date.now() - started;
      clearTimeout(release);
      expect(res.statusCode, res.body).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(5_900);
      expect((res.json() as SalesReport).totals).toEqual({ sale_count: 7, total: '5033.24', paid_total: '773.29', balance_due: '4260.00' });
    } finally {
      await holder.end();
    }
  }, 60_000);

  it('7d. report routes allow 30 requests a minute per member; the 31st is 429; another member is unaffected', async () => {
    const burst = await api.activeStaff(owner, 'ATTENDANT', 'Haraka');
    // One after another: the plugin's in-memory store returns one shared
    // counter object, so requests that arrive in the same tick all read the
    // final count (31 at once would all be refused; found in G1a).
    const answers: LightMyRequestResponse[] = [];
    for (let i = 0; i < 31; i++) answers.push(await get('/v1/reports/my-day', burst.token));
    const codes = answers.map((r) => r.statusCode).sort((a, b) => a - b);
    expect(codes.filter((c) => c === 200)).toHaveLength(30);
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    const refused = answers.find((r) => r.statusCode === 429)!;
    expect(errorOf(refused)).toEqual({ status: 429, code: 'RATE_LIMITED' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Errors (422) count too: the limit is checked before anything else.
    expect(errorOf(await get('/v1/reports/my-day?date=nope', burst.token))).toEqual({ status: 429, code: 'RATE_LIMITED' });
    expect((await get('/v1/reports/my-day', chebet.token)).statusCode).toBe(200);
    // Other routes are not limited by it.
    expect((await get('/v1/notifications', burst.token)).statusCode).toBe(200);
  });

  // ---------------------------------------------------------------- the transaction-timeout marker
  it('the @TransactionTimeout marker is used by the report routes only', () => {
    const reflector = new Reflector();
    const marked: string[] = [];
    for (const mod of t.app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (!controller) continue;
        const base = reflector.get<string>('path', controller);
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const fn = handler as (...args: unknown[]) => unknown;
          const ms = reflector.getAllAndOverride<number | undefined>(TRANSACTION_TIMEOUT, [fn, controller]);
          if (ms !== undefined) marked.push(`${base}/${reflector.get<string>('path', fn)} ${ms}`);
        }
      }
    }
    expect(marked.sort()).toEqual(['v1/reports/my-day 10000', 'v1/reports/sales 10000']);
  });
});
