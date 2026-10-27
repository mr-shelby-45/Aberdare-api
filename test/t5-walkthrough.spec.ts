import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';

// Phase T5: the manual walkthrough of docs/phase-t-walkthrough.md (design
// section 12), step by step, with the same values as the document, so the
// document cannot silently go stale. The dev fixed codes are switched on
// exactly as the document says (the code 123456 for listed targets).

const CODE = '123456';
const OWNER = { phone: '0712000601', email: 'field-owner@example.com' };
const MANAGER_PHONE = '0712000602';
const FIELD_PHONE = '0712000603';
const SECOND = { phone: '0712000609', email: 'field-second@example.com' };
const ALLOWLIST = ['+254712000601', '+254712000602', '+254712000603', '+254712000609', OWNER.email, SECOND.email].join(',');

const MAIZE = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CARTON = '33333333-3333-4333-8333-333333333333';
const SALE_A = 'b1b1b1b1-0000-4000-8000-000000000001';
const SALE_B = 'b1b1b1b1-0000-4000-8000-000000000002';
const SALE_C = 'b1b1b1b1-0000-4000-8000-000000000003';
const SALE_WRONG = 'b1b1b1b1-0000-4000-8000-000000000004';
const SALE_LATE = 'b1b1b1b1-0000-4000-8000-000000000005';
const SETTLEMENT = 'c1c1c1c1-0000-4000-8000-000000000001';

let commandSeq = 0;
const commandId = () => `ffffffff-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

type Row = Record<string, unknown> & { id: string };
interface Result {
  status: string;
  reason?: string;
  result?: Record<string, unknown>;
}
interface SnapshotPage {
  table: string;
  rows: Row[];
  next_cursor?: string | null;
  next_table?: string | null;
}

describe('T5: the Phase T walkthrough runs end to end', { timeout: 120_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.186' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json() as T;
  };
  const errorCode = (res: LightMyRequestResponse) => [res.statusCode, (res.json() as { error: { code: string } }).error.code];
  const cmd = async (token: string, type: string, payload: object, occurredAt = t.clock.now().toISOString()) =>
    ok<{ results: Result[] }>(await call('POST', '/v1/sync/commands', token, { commands: [{ command_id: commandId(), type, occurred_at: occurredAt, payload }] })).results[0];

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

  async function staff(ownerToken: string, phone: string, name: string, role: 'MANAGER' | 'FIELD_ATTENDANT') {
    const created = ok<{ membership_id: string; temp_pin: string }>(await call('POST', '/v1/staff', ownerToken, { phone, display_name: name, role_preset: role }), 201);
    const first = ok<{ setup_token: string }>(await call('POST', '/v1/auth/first-login', undefined, { phone, temp_pin: created.temp_pin }));
    const active = ok<{ access_token: string }>(
      await call('POST', '/v1/auth/staff/activate', undefined, { setup_token: first.setup_token, code: CODE, new_pin: '2468', device: { name: `${name} phone`, platform: 'android' } }),
    );
    return { token: active.access_token, membershipId: created.membership_id };
  }

  /** Every table of a full snapshot, as the phone would store it. */
  async function snapshot(token: string): Promise<Record<string, Row[]>> {
    const copy: Record<string, Row[]> = {};
    let res = await call('GET', '/v1/sync/snapshot?limit=500', token);
    for (;;) {
      const p = ok<SnapshotPage>(res);
      (copy[p.table] ??= []).push(...p.rows);
      if (p.next_cursor) res = await call('GET', `/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=500`, token);
      else if (p.next_table) res = await call('GET', `/v1/sync/snapshot?table=${p.next_table}&limit=500`, token);
      else return copy;
    }
  }

  it('runs the eight steps of docs/phase-t-walkthrough.md', async () => {
    // 1. The shop, the manager, the field attendant and the van.
    const owner = await signup(OWNER, 'Duka la Amina');
    const shop = ok<{ locations: { id: string }[] }>(await call('GET', '/v1/locations', owner)).locations[0].id;
    const manager = await staff(owner, MANAGER_PHONE, 'Wanjiru', 'MANAGER');
    t.clock.advanceMinutes(2);
    const field = await staff(owner, FIELD_PHONE, 'Otieno', 'FIELD_ATTENDANT');
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
    expect(await cmd(manager.token, 'stock.receive', { location_id: shop, lines: [{ pack_type_id: CARTON, quantity: 10 }, { pack_type_id: PIECE, quantity: 40 }] })).toMatchObject({ status: 'ACCEPTED' });
    const van = ok<Row>(await call('POST', '/v1/locations', owner, { name: 'Van 1', kind: 'FIELD', assigned_membership_id: field.membershipId }), 201);
    expect(van).toMatchObject({ name: 'Van 1', kind: 'FIELD', assigned_membership_id: field.membershipId, is_default: false });
    const VAN = van.id;

    // 2. The manager issues 10 pieces and 1 carton to the van.
    expect(await cmd(manager.token, 'stock.issue', { from_location_id: shop, to_location_id: VAN, reference: 'Morning load', lines: [{ pack_type_id: PIECE, quantity: 10 }, { pack_type_id: CARTON, quantity: 1 }] })).toMatchObject({
      status: 'ACCEPTED',
      result: {
        transfer_id: expect.any(String),
        lines: expect.arrayContaining([
          { pack_type_id: PIECE, from_after: 30, to_after: 10 },
          { pack_type_id: CARTON, from_after: 9, to_after: 1 },
        ]),
      },
    });

    // 3. The attendant syncs and sees only their own stock.
    const snap = await snapshot(field.token);
    expect(snap.location.map((l) => l.id)).toEqual([VAN]);
    expect(new Set(snap.stock_balance.map((b) => b.location_id))).toEqual(new Set([VAN]));
    expect(Object.fromEntries(snap.stock_balance.map((b) => [b.pack_type_id, b.quantity]))).toEqual({ [PIECE]: 10, [CARTON]: 1 });
    expect(ok<{ locations: Row[] }>(await call('GET', '/v1/locations', field.token)).locations.map((l) => l.id)).toEqual([VAN]);

    // 4. Sales: 6 pieces for cash, 3 with M-Pesa, the carton for cash; one sale at the shop is refused.
    const step4At = t.clock.now().toISOString();
    expect(await cmd(field.token, 'sale.create', { sale_id: SALE_A, local_ref: 'V-0001', location_id: VAN, lines: [{ pack_type_id: PIECE, quantity: 6, unit_price: '180' }], payments: [{ method: 'CASH', amount: '1080' }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { sale_id: SALE_A, total: '1080.00', balance_due: '0.00', flags: [] },
    });
    expect(
      await cmd(field.token, 'sale.create', { sale_id: SALE_B, local_ref: 'V-0002', location_id: VAN, lines: [{ pack_type_id: PIECE, quantity: 3, unit_price: '180' }], payments: [{ method: 'MPESA', amount: '540', mpesa_code: 'qk90tt12xy' }] }),
    ).toMatchObject({ status: 'ACCEPTED', result: { total: '540.00', balance_due: '0.00', flags: [] } });
    expect(await cmd(field.token, 'sale.create', { sale_id: SALE_C, local_ref: 'V-0003', location_id: VAN, lines: [{ pack_type_id: CARTON, quantity: 1, unit_price: '4200' }], payments: [{ method: 'CASH', amount: '4200' }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { total: '4200.00' },
    });
    expect(await cmd(field.token, 'sale.create', { sale_id: SALE_WRONG, local_ref: 'V-0004', location_id: shop, lines: [{ pack_type_id: PIECE, quantity: 1, unit_price: '180' }], payments: [{ method: 'CASH', amount: '180' }] })).toMatchObject({
      status: 'REJECTED',
      reason: 'LOCATION_NOT_FOUND',
    });

    // 5. The carton sale is voided with the manager's PIN.
    expect(await cmd(field.token, 'sale.void', { sale_id: SALE_C, reason: 'CUSTOMER_CANCELLED' })).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    const approvers = ok<{ approvers: { display_name: string }[] }>(await call('GET', '/v1/stock/approvers?purpose=SALE_VOID', field.token));
    expect(approvers.approvers.map((a) => a.display_name).sort()).toEqual(['Amina', 'Wanjiru']);
    const approval = ok<{ approval_id: string }>(
      await call('POST', '/v1/stock/approvals', field.token, { approver_membership_id: manager.membershipId, approver_pin: '2468', purpose: 'SALE_VOID' }),
      201,
    ).approval_id;
    expect(await cmd(field.token, 'sale.void', { sale_id: SALE_C, reason: 'CUSTOMER_CANCELLED', approval_id: approval })).toMatchObject({
      status: 'ACCEPTED',
      result: { sale_id: SALE_C, approved_by_membership_id: manager.membershipId },
    });

    // 6. Day end: the attendant syncs, the carton comes back, preview, count, cash, close.
    t.clock.advanceMinutes(6);
    ok(await call('GET', '/v1/sync/snapshot?limit=1', field.token));
    expect(await cmd(manager.token, 'stock.return', { from_location_id: VAN, to_location_id: shop, lines: [{ pack_type_id: CARTON, quantity: 1 }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: CARTON, from_after: 0, to_after: 10 }] },
    });
    const preview = ok<Row & { lines: Row[] }>(await call('GET', `/v1/field/settlements/preview?location_id=${VAN}`, manager.token));
    expect(preview).toMatchObject({
      location_id: VAN,
      attendant_membership_id: field.membershipId,
      last_synced_at: expect.any(String),
      expected_cash: '1080.00', // the voided carton's 4200 is reversed and left out
      mpesa_verified_total: '0.00',
      mpesa_unverified_total: '540.00',
      sale_count: 3,
      voided_count: 1,
      unpaid_total: '0.00',
    });
    expect(Object.fromEntries(preview.lines.map((l) => [l.pack_type_id, l]))).toEqual({
      [PIECE]: { pack_type_id: PIECE, issued: 10, returned: 0, sold: 9, voided_back: 0, other: 0, expected_quantity: 1 },
      [CARTON]: { pack_type_id: CARTON, issued: 1, returned: 1, sold: 1, voided_back: 1, other: 0, expected_quantity: 0 },
    });
    expect(errorCode(await call('GET', `/v1/field/settlements/preview?location_id=${VAN}`, field.token))).toEqual([403, 'PERMISSION_DENIED']);
    const close = await cmd(manager.token, 'settlement.close', {
      settlement_id: SETTLEMENT,
      field_location_id: VAN,
      cash_received: '1050',
      note: 'Short 30, piece missing',
      lines: [
        { pack_type_id: PIECE, counted_quantity: 0 },
        { pack_type_id: CARTON, counted_quantity: 0 },
      ],
    });
    expect(close).toMatchObject({ status: 'ACCEPTED', result: { settlement_id: SETTLEMENT, cash_variance: '-30.00' } });
    expect(Object.fromEntries((close.result!.lines as { pack_type_id: string; variance: number }[]).map((l) => [l.pack_type_id, l.variance]))).toEqual({ [PIECE]: -1, [CARTON]: 0 });
    const settlement = ok<Row & { lines: Row[] }>(await call('GET', `/v1/field/settlements/${SETTLEMENT}`, manager.token));
    expect(settlement).toMatchObject({ expected_cash: '1080.00', cash_received: '1050.00', cash_variance: '-30.00', sale_count: 3, voided_count: 1, note: 'Short 30, piece missing' });
    const lost = ok<{ movements: Row[] }>(await call('GET', `/v1/stock/movements?location_id=${VAN}&type=ADJUST`, manager.token)).movements;
    expect(lost.map((m) => [m.pack_type_id, m.quantity_change, m.reason])).toEqual([[PIECE, -1, 'LOST']]);

    // 7. The missing piece was sold offline; the sale arrives late and is flagged.
    t.clock.advanceMinutes(1);
    expect(
      await cmd(field.token, 'sale.create', { sale_id: SALE_LATE, local_ref: 'V-0005', location_id: VAN, lines: [{ pack_type_id: PIECE, quantity: 1, unit_price: '180' }], payments: [{ method: 'CASH', amount: '180' }] }, step4At),
    ).toMatchObject({ status: 'FLAGGED', result: { sale_id: SALE_LATE, flags: ['STOCK_NEGATIVE', 'AFTER_SETTLEMENT'] } });
    const next = ok<Row>(await call('GET', `/v1/field/settlements/preview?location_id=${VAN}`, manager.token));
    expect(next).toMatchObject({ expected_cash: '180.00', sale_count: 1, voided_count: 0 });

    // 8. A second business sees none of it.
    const second = await signup(SECOND, 'Duka B');
    expect(ok<{ settlements: Row[] }>(await call('GET', '/v1/field/settlements', second)).settlements).toEqual([]);
    expect(errorCode(await call('GET', `/v1/field/settlements/${SETTLEMENT}`, second))).toEqual([404, 'SETTLEMENT_NOT_FOUND']);
    expect(errorCode(await call('GET', `/v1/field/settlements/preview?location_id=${VAN}`, second))).toEqual([404, 'LOCATION_NOT_FOUND']);
    expect(ok<{ locations: Row[] }>(await call('GET', '/v1/locations', second)).locations.map((l) => l.id)).not.toContain(VAN);
  });
});
