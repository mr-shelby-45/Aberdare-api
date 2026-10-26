import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';

// Phase E6 test 5: the manual walkthrough of docs/phase-e-walkthrough.md
// (design section 14), step by step, with the same values as the document,
// so the document cannot silently go stale. The dev fixed codes are switched
// on exactly as the document says (the code 123456 for listed targets).

const CODE = '123456';
const OWNER = { phone: '0712000501', email: 'sales-owner@example.com' };
const MANAGER_PHONE = '0712000502';
const ATTENDANT_PHONE = '0712000503';
const SECOND = { phone: '0712000509', email: 'sales-second@example.com' };
const ALLOWLIST = ['+254712000501', '+254712000502', '+254712000503', '+254712000509', OWNER.email, SECOND.email].join(',');

const MAIZE = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CARTON = '33333333-3333-4333-8333-333333333333';
const SALE_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const SALE_B = 'a1a1a1a1-0000-4000-8000-000000000002';
const SALE_C = 'a1a1a1a1-0000-4000-8000-000000000003';
const SALE_D = 'a1a1a1a1-0000-4000-8000-000000000004';
const SALE_E = 'a1a1a1a1-0000-4000-8000-000000000005';

let commandSeq = 0;
const commandId = () => `eeeeeeee-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

type Row = Record<string, unknown> & { id: string };
interface Result {
  status: string;
  reason?: string;
  result?: Record<string, unknown>;
}

describe('E6 test 5: the Phase E walkthrough runs end to end', { timeout: 120_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.185' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json() as T;
  };
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

  async function staff(ownerToken: string, phone: string, name: string, role: 'MANAGER' | 'ATTENDANT') {
    const created = ok<{ membership_id: string; temp_pin: string }>(await call('POST', '/v1/staff', ownerToken, { phone, display_name: name, role_preset: role }), 201);
    const first = ok<{ setup_token: string }>(await call('POST', '/v1/auth/first-login', undefined, { phone, temp_pin: created.temp_pin }));
    const active = ok<{ access_token: string }>(
      await call('POST', '/v1/auth/staff/activate', undefined, { setup_token: first.setup_token, code: CODE, new_pin: '2468', device: { name: `${name} phone`, platform: 'android' } }),
    );
    return { token: active.access_token, membershipId: created.membership_id };
  }

  it('runs the ten steps of docs/phase-e-walkthrough.md', async () => {
    // 1. The shop, and the attendant's snapshot start.
    const owner = await signup(OWNER, 'Duka la Amina');
    const loc = ok<{ locations: { id: string }[] }>(await call('GET', '/v1/locations', owner)).locations[0].id;
    const manager = await staff(owner, MANAGER_PHONE, 'Wanjiru', 'MANAGER');
    t.clock.advanceMinutes(2);
    const attendant = await staff(owner, ATTENDANT_PHONE, 'Baraka', 'ATTENDANT');
    expect(
      await cmd(manager.token, 'product.create', {
        product_id: MAIZE,
        name: 'Maize flour 2kg',
        pack_types: [
          { pack_type_id: PIECE, name: 'piece', units_per_pack: 1, sell_price: '180' },
          { pack_type_id: CARTON, name: 'carton of 24', units_per_pack: 24, sell_price: '4200' },
        ],
      }),
    ).toMatchObject({ status: 'ACCEPTED' });
    expect(await cmd(owner, 'pack_type.upsert', { pack_type_id: PIECE, product_id: MAIZE, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' })).toMatchObject({ status: 'ACCEPTED' });
    expect(await cmd(manager.token, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: CARTON, quantity: 10 }, { pack_type_id: PIECE, quantity: 20 }] })).toMatchObject({ status: 'ACCEPTED' });
    const attCursor = ok<{ start_cursor: string }>(await call('GET', '/v1/sync/snapshot', attendant.token)).start_cursor;

    // 2. 3 pieces and 1 carton, part cash, part M-Pesa.
    expect(
      await cmd(attendant.token, 'sale.create', {
        sale_id: SALE_A,
        local_ref: 'A-0001',
        location_id: loc,
        lines: [
          { pack_type_id: PIECE, quantity: 3, unit_price: '180' },
          { pack_type_id: CARTON, quantity: 1, unit_price: '4100' },
        ],
        payments: [
          { method: 'CASH', amount: '640' },
          { method: 'MPESA', amount: '4000', mpesa_code: 'qk12ab34cd' },
        ],
      }),
    ).toEqual({ command_id: expect.any(String), status: 'ACCEPTED', result: { sale_id: SALE_A, sale_number: 1, total: '4640.00', paid_total: '4640.00', balance_due: '0.00', flags: [] } });

    // 3. A wrong phone total.
    expect(
      await cmd(attendant.token, 'sale.create', { sale_id: SALE_B, local_ref: 'A-0002', location_id: loc, total: '170', lines: [{ pack_type_id: PIECE, quantity: 1, unit_price: '180' }], payments: [{ method: 'CASH', amount: '180' }] }),
    ).toMatchObject({ status: 'FLAGGED', reason: 'TOTAL_MISMATCH', result: { sale_number: 2, total: '180.00' } });

    // 4. Bigger than the stock.
    expect(await cmd(attendant.token, 'sale.create', { sale_id: SALE_C, local_ref: 'A-0003', location_id: loc, lines: [{ pack_type_id: CARTON, quantity: 12, unit_price: '4200' }] })).toMatchObject({
      status: 'FLAGGED',
      reason: 'STOCK_NEGATIVE',
      result: { sale_number: 3, balance_due: '50400.00' },
    });

    // 5. The same M-Pesa code.
    expect(
      await cmd(attendant.token, 'sale.create', { sale_id: SALE_D, local_ref: 'A-0004', location_id: loc, lines: [{ pack_type_id: PIECE, quantity: 1, unit_price: '180' }], payments: [{ method: 'MPESA', amount: '180', mpesa_code: 'QK12AB34CD' }] }),
    ).toMatchObject({ status: 'FLAGGED', reason: 'DUPLICATE_MPESA_CODE', result: { sale_number: 4 } });

    // 6. A balance paid off.
    expect(await cmd(attendant.token, 'payment.attach', { sale_id: SALE_C, payments: [{ method: 'CASH', amount: '50400' }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { paid_total: '50400.00', balance_due: '0.00' },
    });

    // 7. The void with the manager's PIN.
    expect(await cmd(attendant.token, 'sale.void', { sale_id: SALE_A, reason: 'CUSTOMER_CANCELLED' })).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    const approvers = ok<{ approvers: { display_name: string }[] }>(await call('GET', '/v1/stock/approvers?purpose=SALE_VOID', attendant.token));
    expect(approvers.approvers.map((a) => a.display_name).sort()).toEqual(['Amina', 'Wanjiru']);
    const approval = ok<{ approval_id: string }>(
      await call('POST', '/v1/stock/approvals', attendant.token, { approver_membership_id: manager.membershipId, approver_pin: '2468', purpose: 'SALE_VOID' }),
      201,
    ).approval_id;
    expect(await cmd(attendant.token, 'sale.void', { sale_id: SALE_A, reason: 'CUSTOMER_CANCELLED', approval_id: approval })).toMatchObject({
      status: 'ACCEPTED',
      result: { sale_id: SALE_A, approved_by_membership_id: manager.membershipId },
    });

    // 8. Who sees which sales, and costs.
    expect(await cmd(manager.token, 'sale.create', { sale_id: SALE_E, local_ref: 'W-0001', location_id: loc, lines: [{ pack_type_id: PIECE, quantity: 1, unit_price: '180' }], payments: [{ method: 'CASH', amount: '180' }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { sale_number: 5 },
    });
    expect(ok<{ sales: Row[] }>(await call('GET', '/v1/sales', manager.token)).sales.map((s) => s.sale_number)).toEqual([5, 4, 3, 2, 1]);
    expect(ok<{ sales: Row[] }>(await call('GET', '/v1/sales', attendant.token)).sales.map((s) => s.sale_number)).toEqual([4, 3, 2, 1]);
    const hidden = await call('GET', `/v1/sales/${SALE_E}`, attendant.token);
    expect(hidden.statusCode).toBe(404);
    expect((hidden.json() as { error: { code: string } }).error.code).toBe('SALE_NOT_FOUND');
    const asAttendant = ok<Row & { items: Row[]; payments: Row[] }>(await call('GET', `/v1/sales/${SALE_A}`, attendant.token));
    expect(asAttendant).toMatchObject({
      status: 'VOIDED',
      void_reason: 'CUSTOMER_CANCELLED',
      voided_by: { display_name: 'Baraka' },
      void_approved_by: { display_name: 'Wanjiru' },
    });
    expect(asAttendant.payments.map((p) => [p.status, p.mpesa_code])).toEqual(expect.arrayContaining([['REVERSED', null], ['REVERSED', 'QK12AB34CD']]));
    for (const i of asAttendant.items) expect(i).not.toHaveProperty('cost_price');
    const asOwner = ok<{ items: Row[] }>(await call('GET', `/v1/sales/${SALE_A}`, owner));
    expect(asOwner.items.map((i) => i.cost_price)).toEqual(['150.00', null]);

    // 9. A phone catches up; stock after the void.
    const changes = ok<{ changes: { table: string; op: string; id: string; row?: Row }[] }>(await call('GET', `/v1/sync/changes?cursor=${encodeURIComponent(attCursor)}`, attendant.token)).changes;
    const sales = changes.filter((c) => c.table === 'sale');
    expect(new Set(sales.map((c) => c.id))).toEqual(new Set([SALE_A, SALE_B, SALE_C, SALE_D]));
    expect(sales.find((c) => c.id === SALE_A)!.row).toMatchObject({ status: 'VOIDED' });
    expect(changes.filter((c) => c.table === 'payment' && c.row!.sale_id === SALE_A).map((c) => c.row!.status)).toEqual(['REVERSED', 'REVERSED']);
    expect(changes.some((c) => c.table === 'stock_balance')).toBe(true);
    expect(JSON.stringify(changes)).not.toContain(SALE_E);
    expect(changes.filter((c) => c.op === 'delete')).toEqual([]);
    const stock = ok<{ balances: { pack_type_id: string; quantity: number }[] }>(await call('GET', '/v1/stock', manager.token)).balances;
    expect(Object.fromEntries(stock.map((s) => [s.pack_type_id, s.quantity]))).toEqual({ [CARTON]: -2, [PIECE]: 17 });
    const voids = ok<{ movements: { pack_type_id: string; quantity_change: number }[] }>(await call('GET', '/v1/stock/movements?type=SALE_VOID', manager.token)).movements;
    expect(Object.fromEntries(voids.map((m) => [m.pack_type_id, m.quantity_change]))).toEqual({ [PIECE]: 3, [CARTON]: 1 });

    // 10. A second business sees none of it.
    const second = await signup(SECOND, 'Duka B');
    expect(ok<{ sales: Row[] }>(await call('GET', '/v1/sales', second)).sales).toEqual([]);
    const foreign = await call('GET', `/v1/sales/${SALE_A}`, second);
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { error: { code: string } }).error.code).toBe('SALE_NOT_FOUND');
  });
});
