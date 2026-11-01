import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';
import { type Member, STAFF_PIN, stockApi } from './helpers/stock-api.js';

// Phase G1d: exceptions, receivables and the field report
// (docs/phase-g1-design.md section 11, G1d). Numbers in test names refer to
// that list. Every expected value is a literal worked out by hand from the
// fixture below; none is recomputed with the report's own SQL.
//
// Products: Soda piece SP (list 50.00, cost 35.50) and crate of 24 SC (list
// 1100.00, cost 800.00); Chai piece CP (list 33.33, no cost). Main shop L1;
// Van1 (Otieno) and Van2 (Kamau). Managers Wanjiru, Amina (costs.view extra)
// and Juma; attendants Achieng (A) and Baraka (B).
// The test clock starts at 2026-10-25 12:00 Nairobi and moves a day twice.
// Sales (Nairobi phone times):
//   S1  A  10-20 01:00 (22:00 UTC on the 19th)  2 SP 100.00                      unpaid
//   S2  B  10-20 10:00   1 SC at 1000.00 (-100.00), 3 CP at 30.00 (-9.99) 1090.00  cash 500.00, owes 590.00
//   S9  A  10-20 12:00   1 CP 33.33  cash   -> voided 10-20 12:30 by Amina (CUSTOMER_CANCELLED)
//   S3  A  10-21 09:00   4 SP at 45.00 (-20.00) 180.00                         M-Pesa QAA1111111
//   S4  B  10-21 11:00   1 SP 50.00                                             M-Pesa QAA1111111 again (duplicate)
//   S5  A  10-21 15:00   2 SP at 40.00 80.00  M-Pesa QBB2222222  -> voided 10-22 09:00 by Wanjiru (MISTAKE)
//   S10 Otieno Van1 10-21 13:00  5 SP 250.00 cash
//   S11 Otieno Van1 10-21 14:00  1 SP 50.00 M-Pesa QDD4444444
//   S12 Otieno Van1 10-21 15:00  1 SC 1100.00                                  unpaid
//   S6  B  10-22 10:00   1 CP 33.33  unpaid -> voided 10-25 12:05 by Baraka with Wanjiru's approval (WRONG_PRICE)
//   S7  A  10-22 12:00   2 SP 100.00  cash 40.00, then M-Pesa 60.00 QCC3333333 attached 10-23 09:00
//   S8  B  10-23 20:00   1 SP 50.00                                             unpaid
// Settlements, closed by Wanjiru at the clock's time:
//   Van1 #1 10-25 12:00: SP 14 counted 12 (-2), SC 1 counted 0 (-1 crate); cash 240.00 of 250.00
//   Van2    10-26 12:00: S13 Kamau 3 SP cash 150.00; SP 7 counted 8 (+1), CP 5 counted 4 (-1, no cost); cash 150.00
//   Van1 #2 10-27 12:00: S14 Otieno 2 SP cash 100.00; SP 10 counted 9 (-1), SC 0 counted 0; cash 100.00
// "Today" for age_days is the final clock day, 2026-10-27.

// Report routes allow 30 requests a minute per member (G1a): the tests spread
// their requests over Amina, Wanjiru and Juma.
const IP = '198.51.100.213';
const PHONE_BASE = 98_500_000;
const DAY_MINUTES = 24 * 60;

interface Ref {
  membership_id: string;
  display_name: string | null;
}
interface ListBody {
  type: string;
  range: { from: string; to: string } | null;
  totals: Record<string, unknown>;
  rows: Record<string, unknown>[];
  next_cursor: string | null;
}
interface FieldFigures {
  settlement_count: number;
  expected_cash: string;
  cash_received: string;
  cash_variance: string;
  mpesa_unverified_total: string;
  unpaid_total: string;
  shortage_units: number;
  surplus_units: number;
  shortage_value_at_cost?: string;
  shortage_lines_without_cost?: number;
}
interface FieldBody {
  range: { from: string; to: string };
  totals: FieldFigures;
  rows: (FieldFigures & { attendant: Ref })[];
}

describe('G1d: exceptions, receivables and field reports', { timeout: 300_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let wanjiru: Member;
  let amina: Member;
  let juma: Member;
  let achieng: Member;
  let baraka: Member;
  let otieno: Member;
  let kamau: Member;
  let ownerBusiness: string;
  let L1: string;
  let VAN1: string;
  let VAN2: string;
  let sale: Record<string, string>;

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
  const ok = async <T>(url: string, token: string): Promise<T> => {
    const res = await get(url, token);
    expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    return res.json() as T;
  };
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });
  const list = (route: string, query: string, token: string) => ok<ListBody>(`/v1/reports/${route}?${query}`, token);
  /** Every page of a list, following next_cursor; also checks the totals are the same on every page. */
  async function allPages(route: string, query: string, token: string) {
    const first = await list(route, query, token);
    const rows = [...first.rows];
    let cursor = first.next_cursor;
    let pages = 1;
    while (cursor) {
      const page = await list(route, `${query}&cursor=${encodeURIComponent(cursor)}`, token);
      expect(page.totals).toEqual(first.totals);
      rows.push(...page.rows);
      cursor = page.next_cursor;
      pages++;
    }
    return { totals: first.totals, rows, pages };
  }

  // Nairobi wall time (UTC+3) as an ISO instant, for command envelopes.
  const nbo = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();
  const ref = (m: Member, name: string): Ref => ({ membership_id: m.membershipId, display_name: name });

  async function accepted(m: Member, type: string, payload: object, at?: string) {
    const r = await api.sendOne(m.token, api.command(type, payload, at ? nbo(at) : undefined));
    expect(['ACCEPTED', 'FLAGGED'], `${type} ${JSON.stringify(r)}`).toContain(r.status);
    return r;
  }
  async function sell(m: Member, loc: string, at: string | undefined, lines: [string, number, string][], payments: object[] = []) {
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
  const cash = (amount: string) => ({ method: 'CASH', amount });
  const mpesa = (amount: string, mpesa_code: string) => ({ method: 'MPESA', amount, mpesa_code });
  async function relogin(...members: Member[]) {
    for (const m of members) {
      const res = await api.post('/v1/auth/pin', { device_id: m.deviceId, device_secret: m.deviceSecret, pin: STAFF_PIN });
      expect(res.statusCode, res.body).toBe(200);
      m.token = api.json<{ access_token: string }>(res).access_token;
    }
  }
  async function close(van: string, attendant: Member, cashReceived: string, lines: [string, number][]) {
    // A close needs the attendant's phone synced recently; a sync read stamps it.
    expect((await api.call('GET', '/v1/sync/snapshot?limit=1', attendant.token)).statusCode).toBe(200);
    await accepted(wanjiru, 'settlement.close', {
      settlement_id: randomUUID(),
      field_location_id: van,
      cash_received: cashReceived,
      lines: lines.map(([pack_type_id, counted_quantity]) => ({ pack_type_id, counted_quantity })),
    });
  }

  async function fixture() {
    const o = await api.signupOwner('Duka la Madeni');
    ownerBusiness = o.businessId;
    wanjiru = await api.activeStaff(o, 'MANAGER', 'Wanjiru');
    amina = await api.activeStaff(o, 'MANAGER', 'Amina');
    expect((await api.call('PATCH', `/v1/staff/${amina.membershipId}`, o.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    juma = await api.activeStaff(o, 'MANAGER', 'Juma');
    achieng = await api.activeStaff(o, 'ATTENDANT', 'Achieng');
    baraka = await api.activeStaff(o, 'ATTENDANT', 'Baraka');
    otieno = await api.activeStaff(o, 'FIELD_ATTENDANT', 'Otieno');
    kamau = await api.activeStaff(o, 'FIELD_ATTENDANT', 'Kamau');
    L1 = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;
    VAN1 = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van1', kind: 'FIELD', assigned_membership_id: otieno.membershipId }, o.token)).id;
    VAN2 = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van2', kind: 'FIELD', assigned_membership_id: kamau.membershipId }, o.token)).id;
    const SP = randomUUID();
    const SC = randomUUID();
    const CP = randomUUID();
    await accepted(o, 'product.create', {
      product_id: randomUUID(),
      name: 'Soda',
      pack_types: [
        { pack_type_id: SP, name: 'piece', units_per_pack: 1, sell_price: '50.00', cost_price: '35.50' },
        { pack_type_id: SC, name: 'crate of 24', units_per_pack: 24, sell_price: '1100.00', cost_price: '800.00' },
      ],
    });
    await accepted(o, 'product.create', { product_id: randomUUID(), name: 'Chai', pack_types: [{ pack_type_id: CP, name: 'piece', units_per_pack: 1, sell_price: '33.33' }] });
    await accepted(wanjiru, 'stock.receive', { location_id: L1, lines: [{ pack_type_id: SP, quantity: 200 }, { pack_type_id: SC, quantity: 20 }, { pack_type_id: CP, quantity: 100 }] }, '2026-10-19T08:00:00');
    await accepted(wanjiru, 'stock.issue', { from_location_id: L1, to_location_id: VAN1, lines: [{ pack_type_id: SP, quantity: 20 }, { pack_type_id: SC, quantity: 2 }] }, '2026-10-19T09:00:00');
    await accepted(wanjiru, 'stock.issue', { from_location_id: L1, to_location_id: VAN2, lines: [{ pack_type_id: SP, quantity: 10 }, { pack_type_id: CP, quantity: 5 }] }, '2026-10-19T09:00:00');

    const s1 = await sell(achieng, L1, '2026-10-20T01:00:00', [[SP, 2, '50.00']]);
    const s2 = await sell(baraka, L1, '2026-10-20T10:00:00', [[SC, 1, '1000.00'], [CP, 3, '30.00']], [cash('500.00')]);
    const s9 = await sell(achieng, L1, '2026-10-20T12:00:00', [[CP, 1, '33.33']], [cash('33.33')]);
    const s3 = await sell(achieng, L1, '2026-10-21T09:00:00', [[SP, 4, '45.00']], [mpesa('180.00', 'QAA1111111')]);
    const s4 = await sell(baraka, L1, '2026-10-21T11:00:00', [[SP, 1, '50.00']], [mpesa('50.00', 'QAA1111111')]);
    const s5 = await sell(achieng, L1, '2026-10-21T15:00:00', [[SP, 2, '40.00']], [mpesa('80.00', 'QBB2222222')]);
    const s10 = await sell(otieno, VAN1, '2026-10-21T13:00:00', [[SP, 5, '50.00']], [cash('250.00')]);
    const s11 = await sell(otieno, VAN1, '2026-10-21T14:00:00', [[SP, 1, '50.00']], [mpesa('50.00', 'QDD4444444')]);
    const s12 = await sell(otieno, VAN1, '2026-10-21T15:00:00', [[SC, 1, '1100.00']]);
    const s6 = await sell(baraka, L1, '2026-10-22T10:00:00', [[CP, 1, '33.33']]);
    const s7 = await sell(achieng, L1, '2026-10-22T12:00:00', [[SP, 2, '50.00']], [cash('40.00')]);
    const s8 = await sell(baraka, L1, '2026-10-23T20:00:00', [[SP, 1, '50.00']]);
    sale = { s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12 };

    await accepted(amina, 'sale.void', { sale_id: s9, reason: 'CUSTOMER_CANCELLED' }, '2026-10-20T12:30:00');
    await accepted(wanjiru, 'sale.void', { sale_id: s5, reason: 'MISTAKE' }, '2026-10-22T09:00:00');
    await accepted(achieng, 'payment.attach', { sale_id: s7, payments: [mpesa('60.00', 'QCC3333333')] }, '2026-10-23T09:00:00');
    // An attendant's void needs a manager's approval, used within its 15
    // minutes (the setup has moved the clock a little past 12:00).
    const minted = await api.post('/v1/stock/approvals', { approver_membership_id: wanjiru.membershipId, approver_pin: STAFF_PIN, purpose: 'SALE_VOID' }, baraka.token);
    expect(minted.statusCode, minted.body).toBe(201);
    await accepted(baraka, 'sale.void', { sale_id: s6, reason: 'WRONG_PRICE', approval_id: api.json<{ approval_id: string }>(minted).approval_id }, '2026-10-25T12:05:00');

    await close(VAN1, otieno, '240.00', [[SP, 12], [SC, 0]]);
    t.clock.advanceMinutes(DAY_MINUTES);
    await relogin(wanjiru, kamau);
    sale.s13 = await sell(kamau, VAN2, undefined, [[SP, 3, '50.00']], [cash('150.00')]);
    await close(VAN2, kamau, '150.00', [[SP, 8], [CP, 4]]);
    t.clock.advanceMinutes(DAY_MINUTES);
    await relogin(wanjiru, otieno, amina, juma, achieng, baraka);
    sale.s14 = await sell(otieno, VAN1, undefined, [[SP, 2, '50.00']], [cash('100.00')]);
    await close(VAN1, otieno, '100.00', [[SP, 9], [SC, 0]]);
  }

  // ---------------------------------------------------------------- 1. exceptions
  it('1. exceptions: voids with seller, voider and approver; below-list differences; paging; cursors bound to their list and filters; no cost keys', async () => {
    const voids = await allPages('exceptions', 'type=voids&from=2026-10-20&to=2026-10-25&limit=1', amina.token);
    expect(voids.pages).toBe(3);
    expect(voids.totals).toEqual({ count: 3, total: '146.66' });
    expect(voids.rows).toEqual([
      // Voided on the 25th; sold on the 22nd. An attendant's void: the approver is shown.
      {
        sale_id: sale.s6,
        sale_number: 10,
        occurred_at: '2026-10-22T07:00:00.000Z',
        voided_at: '2026-10-25T09:05:00.000Z',
        total: '33.33',
        reason: 'WRONG_PRICE',
        location: { id: L1, name: 'Main shop' },
        attendant: ref(baraka, 'Baraka'),
        voided_by: ref(baraka, 'Baraka'),
        approved_by: ref(wanjiru, 'Wanjiru'),
      },
      // A manager's own void: no approval was used.
      {
        sale_id: sale.s5,
        sale_number: 6,
        occurred_at: '2026-10-21T12:00:00.000Z',
        voided_at: '2026-10-22T06:00:00.000Z',
        total: '80.00',
        reason: 'MISTAKE',
        location: { id: L1, name: 'Main shop' },
        attendant: ref(achieng, 'Achieng'),
        voided_by: ref(wanjiru, 'Wanjiru'),
        approved_by: null,
      },
      {
        sale_id: sale.s9,
        sale_number: 3,
        occurred_at: '2026-10-20T09:00:00.000Z',
        voided_at: '2026-10-20T09:30:00.000Z',
        total: '33.33',
        reason: 'CUSTOMER_CANCELLED',
        location: { id: L1, name: 'Main shop' },
        attendant: ref(achieng, 'Achieng'),
        voided_by: ref(amina, 'Amina'),
        approved_by: null,
      },
    ]);
    // By voided_at: the void on the 25th of a sale from the 22nd is outside 20..22.
    const early = await list('exceptions', 'type=voids&from=2026-10-20&to=2026-10-22', amina.token);
    expect(early.totals).toEqual({ count: 2, total: '113.33' });
    expect(early.rows.map((r) => r.sale_id)).toEqual([sale.s5, sale.s9]);
    expect(early.next_cursor).toBeNull();

    const below = await allPages('exceptions', 'type=below_list&from=2026-10-20&to=2026-10-23&limit=1', amina.token);
    expect(below.pages).toBe(3);
    // S5's line at 40.00 is gone with its void.
    expect(below.totals).toEqual({ lines: 3, difference: '129.99' });
    expect(below.rows).toEqual([
      { sale_id: sale.s3, sale_number: 4, occurred_at: '2026-10-21T06:00:00.000Z', line_no: 1, attendant: ref(achieng, 'Achieng'), product_name: 'Soda', pack_type_name: 'piece', quantity: 4, unit_price: '45.00', list_price: '50.00', difference: '20.00' },
      { sale_id: sale.s2, sale_number: 2, occurred_at: '2026-10-20T07:00:00.000Z', line_no: 1, attendant: ref(baraka, 'Baraka'), product_name: 'Soda', pack_type_name: 'crate of 24', quantity: 1, unit_price: '1000.00', list_price: '1100.00', difference: '100.00' },
      { sale_id: sale.s2, sale_number: 2, occurred_at: '2026-10-20T07:00:00.000Z', line_no: 2, attendant: ref(baraka, 'Baraka'), product_name: 'Chai', pack_type_name: 'piece', quantity: 3, unit_price: '30.00', list_price: '33.33', difference: '9.99' },
    ]);
    // A bigger page gives the same rows.
    expect((await list('exceptions', 'type=below_list&from=2026-10-20&to=2026-10-23', amina.token)).rows).toEqual(below.rows);

    // Cursors: tampered, from another list, or with other filters are refused.
    const first = await list('exceptions', 'type=voids&from=2026-10-20&to=2026-10-25&limit=1', amina.token);
    const c = first.next_cursor!;
    const refused = async (q: string) => errorOf(await get(`/v1/reports/exceptions?${q}`, amina.token));
    const tampered = `${c.slice(0, -2)}${c.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await refused(`type=voids&from=2026-10-20&to=2026-10-25&limit=1&cursor=${encodeURIComponent(tampered)}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused(`type=below_list&from=2026-10-20&to=2026-10-25&limit=1&cursor=${encodeURIComponent(c)}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused(`type=voids&from=2026-10-21&to=2026-10-25&limit=1&cursor=${encodeURIComponent(c)}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // The same cursor with its own filters still works (limit is not a filter).
    expect((await list('exceptions', `type=voids&from=2026-10-20&to=2026-10-25&limit=5&cursor=${encodeURIComponent(c)}`, amina.token)).rows.map((r) => r.sale_id)).toEqual([sale.s5, sale.s9]);

    // No cost figures in exceptions, even for a member with costs.view.
    for (const q of ['type=voids&from=2026-10-20&to=2026-10-25', 'type=below_list&from=2026-10-20&to=2026-10-23']) {
      expect((await get(`/v1/reports/exceptions?${q}`, amina.token)).body).not.toMatch(/cost/);
    }
  });

  // ---------------------------------------------------------------- 2. receivables
  it('2. receivables: unpaid with balance_due and Nairobi age_days; unverified M-Pesa with code and duplicate flag; exclusions; totals; cross-check with the sales report', async () => {
    const unpaid = await allPages('receivables', 'type=unpaid&limit=1', wanjiru.token);
    expect(unpaid.pages).toBe(4);
    expect(unpaid.totals).toEqual({ count: 4, balance_due: '1840.00' });
    expect(unpaid.rows).toEqual([
      // 01:00 Nairobi on the 20th is 22:00 UTC on the 19th: 7 Nairobi days to the 27th, not 8.
      { sale_id: sale.s1, sale_number: 1, occurred_at: '2026-10-19T22:00:00.000Z', age_days: 7, attendant: ref(achieng, 'Achieng'), location: { id: L1, name: 'Main shop' }, total: '100.00', balance_due: '100.00' },
      { sale_id: sale.s2, sale_number: 2, occurred_at: '2026-10-20T07:00:00.000Z', age_days: 7, attendant: ref(baraka, 'Baraka'), location: { id: L1, name: 'Main shop' }, total: '1090.00', balance_due: '590.00' },
      { sale_id: sale.s12, sale_number: 9, occurred_at: '2026-10-21T12:00:00.000Z', age_days: 6, attendant: ref(otieno, 'Otieno'), location: { id: VAN1, name: 'Van1' }, total: '1100.00', balance_due: '1100.00' },
      // S6 (voided) and S7 (paid off later) are not here.
      { sale_id: sale.s8, sale_number: 12, occurred_at: '2026-10-23T17:00:00.000Z', age_days: 4, attendant: ref(baraka, 'Baraka'), location: { id: L1, name: 'Main shop' }, total: '50.00', balance_due: '50.00' },
    ]);
    const ranged = await list('receivables', 'type=unpaid&from=2026-10-21&to=2026-10-23', wanjiru.token);
    expect(ranged.range).toEqual({ from: '2026-10-21', to: '2026-10-23' });
    expect(ranged.totals).toEqual({ count: 2, balance_due: '1150.00' });
    expect(ranged.rows.map((r) => r.sale_id)).toEqual([sale.s12, sale.s8]);
    // Cross-check: the sales report's balance_due over the same days.
    const salesReport = await ok<{ totals: { balance_due: string } }>('/v1/reports/sales?from=2026-10-20&to=2026-10-23', wanjiru.token);
    expect(salesReport.totals.balance_due).toBe(unpaid.totals.balance_due);

    const mpesa = await allPages('receivables', 'type=unverified_mpesa&limit=3', wanjiru.token);
    expect(mpesa.pages).toBe(2);
    expect(mpesa.totals).toEqual({ count: 4, amount: '340.00' });
    const payments = mpesa.rows.map(({ payment_id, ...rest }) => {
      expect(payment_id).toEqual(expect.any(String));
      return rest;
    });
    // S5's payment (reversed by its void) is not here; S4 reused S3's code.
    expect(payments).toEqual([
      { sale_id: sale.s3, sale_number: 4, occurred_at: '2026-10-21T06:00:00.000Z', amount: '180.00', mpesa_code: 'QAA1111111', attendant: ref(achieng, 'Achieng'), duplicate: false },
      { sale_id: sale.s4, sale_number: 5, occurred_at: '2026-10-21T08:00:00.000Z', amount: '50.00', mpesa_code: 'QAA1111111', attendant: ref(baraka, 'Baraka'), duplicate: true },
      { sale_id: sale.s11, sale_number: 8, occurred_at: '2026-10-21T11:00:00.000Z', amount: '50.00', mpesa_code: 'QDD4444444', attendant: ref(otieno, 'Otieno'), duplicate: false },
      // Attached on the 23rd to a sale of the 22nd: placed by the payment's time.
      { sale_id: sale.s7, sale_number: 11, occurred_at: '2026-10-23T06:00:00.000Z', amount: '60.00', mpesa_code: 'QCC3333333', attendant: ref(achieng, 'Achieng'), duplicate: false },
    ]);
    expect((await list('receivables', 'type=unverified_mpesa&from=2026-10-22&to=2026-10-23', wanjiru.token)).totals).toEqual({ count: 1, amount: '60.00' });

    const refused = async (q: string) => errorOf(await get(`/v1/reports/receivables?${q}`, wanjiru.token));
    expect(await refused('type=unpaid&from=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // An unpaid cursor is refused by the M-Pesa list and with a range added.
    const c = (await list('receivables', 'type=unpaid&limit=1', wanjiru.token)).next_cursor!;
    expect(await refused(`type=unverified_mpesa&limit=1&cursor=${encodeURIComponent(c)}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused(`type=unpaid&from=2026-10-20&to=2026-10-23&limit=1&cursor=${encodeURIComponent(c)}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  // ---------------------------------------------------------------- 3. the field report
  it('3. field report: sums match the settlements; shortage and surplus in pieces; out-of-range settlements excluded; cost value only with costs.view', async () => {
    const field = await ok<FieldBody>('/v1/reports/field?from=2026-10-25&to=2026-10-26', amina.token);
    expect(field.range).toEqual({ from: '2026-10-25', to: '2026-10-26' });
    expect(field.totals).toEqual({ settlement_count: 2, expected_cash: '400.00', cash_received: '390.00', cash_variance: '-10.00', mpesa_unverified_total: '50.00', unpaid_total: '1100.00', shortage_units: 27, surplus_units: 1, shortage_value_at_cost: '871.00', shortage_lines_without_cost: 1 });
    expect(field.rows).toEqual([
      // Van2: one Chai short (no cost: counted, not valued), one Soda over.
      { attendant: ref(kamau, 'Kamau'), settlement_count: 1, expected_cash: '150.00', cash_received: '150.00', cash_variance: '0.00', mpesa_unverified_total: '0.00', unpaid_total: '0.00', shortage_units: 1, surplus_units: 1, shortage_value_at_cost: '0.00', shortage_lines_without_cost: 1 },
      // Van1 #1 only (#2 closed on the 27th): 2 pieces and a crate of 24 short, 2 x 35.50 + 800.00.
      { attendant: ref(otieno, 'Otieno'), settlement_count: 1, expected_cash: '250.00', cash_received: '240.00', cash_variance: '-10.00', mpesa_unverified_total: '50.00', unpaid_total: '1100.00', shortage_units: 26, surplus_units: 0, shortage_value_at_cost: '871.00', shortage_lines_without_cost: 0 },
    ]);
    const wide = await ok<FieldBody>(`/v1/reports/field?from=2026-10-25&to=2026-10-27&attendant_id=${otieno.membershipId}`, amina.token);
    expect(wide.rows).toEqual([
      { attendant: ref(otieno, 'Otieno'), settlement_count: 2, expected_cash: '350.00', cash_received: '340.00', cash_variance: '-10.00', mpesa_unverified_total: '50.00', unpaid_total: '1100.00', shortage_units: 27, surplus_units: 0, shortage_value_at_cost: '906.50', shortage_lines_without_cost: 0 },
    ]);
    expect(wide.totals).toMatchObject({ settlement_count: 2, shortage_units: 27 });
    expect((await ok<FieldBody>('/v1/reports/field?from=2026-10-20&to=2026-10-24', amina.token)).rows).toEqual([]);

    // Cross-check: the money figures add up to the settlement rows of the same days.
    const settlements: { attendant_membership_id: string; period_end: string; expected_cash: string; cash_received: string; mpesa_unverified_total: string; unpaid_total: string }[] = [];
    for (const van of [VAN1, VAN2]) {
      settlements.push(...(await ok<{ settlements: typeof settlements }>(`/v1/field/settlements?location_id=${van}`, wanjiru.token)).settlements);
    }
    expect(settlements).toHaveLength(3);
    const cents = (x: string) => BigInt(x.replace('.', ''));
    for (const row of field.rows) {
      const mine = settlements.filter((s) => s.attendant_membership_id === row.attendant.membership_id && s.period_end < '2026-10-26T21:00:00.000Z');
      expect(mine).toHaveLength(row.settlement_count);
      for (const [key, figure] of [['expected_cash', row.expected_cash], ['cash_received', row.cash_received], ['mpesa_unverified_total', row.mpesa_unverified_total], ['unpaid_total', row.unpaid_total]] as const) {
        expect(mine.reduce((s, x) => s + cents(x[key]), 0n), key).toBe(cents(figure));
      }
    }

    // Without costs.view: no shortage value keys.
    const plain = await ok<FieldBody>('/v1/reports/field?from=2026-10-25&to=2026-10-26', wanjiru.token);
    expect(plain.totals).toEqual({ settlement_count: 2, expected_cash: '400.00', cash_received: '390.00', cash_variance: '-10.00', mpesa_unverified_total: '50.00', unpaid_total: '1100.00', shortage_units: 27, surplus_units: 1 });
    expect((await get('/v1/reports/field?from=2026-10-25&to=2026-10-26', wanjiru.token)).body).not.toMatch(/cost/);
  });

  // ---------------------------------------------------------------- 4. isolation and permissions
  it('4. identical data in two businesses never mixes; attendants and field attendants are 403', async () => {
    const twins: Member[] = [];
    for (const name of ['Pacha G', 'Pacha H']) {
      const o = await api.signupOwner(name);
      const pack = randomUUID();
      await accepted(o, 'product.create', { product_id: randomUUID(), name: 'Soda', pack_types: [{ pack_type_id: pack, name: 'piece', units_per_pack: 1, sell_price: '50.00' }] });
      const loc = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;
      await accepted(o, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: pack, quantity: 10 }] });
      await sell(o, loc, '2026-10-24T10:00:00', [[pack, name === 'Pacha G' ? 1 : 2, '45.00']], [mpesa('10.00', 'QZZ9999999')]);
      twins.push(o);
    }
    const [g, h] = twins;
    // The same M-Pesa code in another business is not a duplicate.
    expect((await list('receivables', 'type=unverified_mpesa', g.token)).rows.map((r) => [r.mpesa_code, r.duplicate])).toEqual([['QZZ9999999', false]]);
    expect((await list('receivables', 'type=unverified_mpesa', h.token)).rows.map((r) => [r.mpesa_code, r.duplicate])).toEqual([['QZZ9999999', false]]);
    expect((await list('receivables', 'type=unpaid', g.token)).totals).toEqual({ count: 1, balance_due: '35.00' });
    expect((await list('receivables', 'type=unpaid', h.token)).totals).toEqual({ count: 1, balance_due: '80.00' });
    expect((await list('exceptions', 'type=below_list&from=2026-10-24&to=2026-10-24', g.token)).totals).toEqual({ lines: 1, difference: '5.00' });
    expect((await list('exceptions', 'type=below_list&from=2026-10-24&to=2026-10-24', h.token)).totals).toEqual({ lines: 1, difference: '10.00' });
    expect((await ok<FieldBody>('/v1/reports/field?from=2026-10-25&to=2026-10-27', g.token)).rows).toEqual([]);
    // The fixture's business sees neither twin.
    expect((await list('exceptions', 'type=below_list&from=2026-10-24&to=2026-10-24', juma.token)).totals).toEqual({ lines: 0, difference: '0.00' });
    expect((await list('receivables', 'type=unverified_mpesa&from=2026-10-24&to=2026-10-24', juma.token)).rows).toEqual([]);
    expect(g.businessId).not.toBe(ownerBusiness);

    for (const who of [achieng, otieno]) {
      for (const url of ['/v1/reports/exceptions?type=voids&from=2026-10-20&to=2026-10-25', '/v1/reports/receivables?type=unpaid', '/v1/reports/field?from=2026-10-25&to=2026-10-26']) {
        expect(errorOf(await get(url, who.token)), url).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
      }
    }
  });

  // ---------------------------------------------------------------- 5. parameter rules
  it('5. type, range, limit and unknown parameters are checked on all three routes', async () => {
    const refused = async (url: string) => errorOf(await get(url, juma.token));
    const bad = { status: 422, code: 'VALIDATION_FAILED' };
    expect(await refused('/v1/reports/exceptions?from=2026-10-20&to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/exceptions?type=refunds&from=2026-10-20&to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/exceptions?type=voids&to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/exceptions?type=voids&from=2026-10-22&to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/exceptions?type=voids&from=2026-07-31&to=2026-10-31')).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
    for (const limit of ['0', '101', '1.5', 'abc']) {
      expect(await refused(`/v1/reports/exceptions?type=voids&from=2026-10-20&to=2026-10-21&limit=${limit}`), limit).toEqual(bad);
    }
    expect(await refused('/v1/reports/receivables')).toEqual(bad);
    expect(await refused('/v1/reports/receivables?type=unpaid&to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/receivables?type=unpaid&from=2026-07-31&to=2026-10-31')).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
    expect(await refused('/v1/reports/receivables?type=unpaid&limit=101')).toEqual(bad);
    expect(await refused('/v1/reports/receivables?type=unpaid&cursor=nonsense')).toEqual(bad);
    expect(await refused('/v1/reports/field?to=2026-10-21')).toEqual(bad);
    expect(await refused('/v1/reports/field?from=2026-10-20&to=2026-10-21&attendant_id=nope')).toEqual(bad);
    expect(await refused('/v1/reports/field?from=2026-07-31&to=2026-10-31')).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
    for (const url of ['/v1/reports/exceptions?type=voids&from=2026-10-20&to=2026-10-21', '/v1/reports/receivables?type=unpaid', '/v1/reports/field?from=2026-10-20&to=2026-10-21']) {
      expect(await refused(`${url}&business_id=${ownerBusiness}`), url).toEqual(bad);
    }
    expect((await get('/v1/reports/exceptions?type=voids&from=2026-08-01&to=2026-10-31&limit=100', juma.token)).statusCode).toBe(200);
  });
});
