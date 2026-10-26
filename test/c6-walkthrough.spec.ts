import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';

// Phase C6 test 5: the manual walkthrough of docs/phase-c-walkthrough.md
// (design section 14), step by step, with the same values as the document,
// so the document cannot silently go stale. The dev fixed codes are switched
// on exactly as the document says (the code 123456 for listed targets).

const CODE = '123456';
const OWNER = { phone: '0712000301', email: 'stock-owner@example.com' };
const MANAGER_PHONE = '0712000302';
const ATTENDANT_PHONE = '0712000303';
const SECOND = { phone: '0712000309', email: 'stock-second@example.com' };
const ALLOWLIST = ['+254712000301', '+254712000302', '+254712000303', '+254712000309', OWNER.email, SECOND.email].join(',');
const MANAGER_PIN = '2468';

// Ids the phone would generate (fixed in the document so it can be copied).
const MAIZE = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CARTON = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

let commandSeq = 0;
const commandId = () => `cccccccc-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

describe('C6 test 5: the Phase C walkthrough runs end to end', { timeout: 120_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.120' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, JSON.stringify(res.json())).toBe(status);
    return res.json() as T;
  };
  type Result = { status: string; reason?: string; result?: Record<string, unknown> };
  const cmd = async (token: string, type: string, payload: object) =>
    ok<{ results: Result[] }>(
      await call('POST', '/v1/sync/commands', token, { commands: [{ command_id: commandId(), type, occurred_at: t.clock.now().toISOString(), payload }] }),
    ).results[0];

  async function signup(who: { phone: string; email: string }, businessName: string) {
    ok(await call('POST', '/v1/auth/signup/start', undefined, who), 202);
    const verified = ok<{ signup_token: string }>(await call('POST', '/v1/auth/signup/verify', undefined, { ...who, phone_code: CODE, email_code: CODE }));
    const done = ok<{ access_token: string }>(
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
    );
    return done.access_token;
  }

  async function staff(ownerToken: string, phone: string, name: string, role: 'MANAGER' | 'ATTENDANT') {
    const created = ok<{ membership_id: string; temp_pin: string }>(await call('POST', '/v1/staff', ownerToken, { phone, display_name: name, role_preset: role }), 201);
    const first = ok<{ setup_token: string }>(await call('POST', '/v1/auth/first-login', undefined, { phone, temp_pin: created.temp_pin }));
    const active = ok<{ access_token: string }>(
      await call('POST', '/v1/auth/staff/activate', undefined, {
        setup_token: first.setup_token,
        code: CODE,
        new_pin: MANAGER_PIN,
        device: { name: `${name} phone`, platform: 'android' },
      }),
    );
    return { token: active.access_token, membershipId: created.membership_id };
  }

  it('runs the nine steps of docs/phase-c-walkthrough.md', async () => {
    // 1. Owner, manager and attendant; the manager creates maize flour (piece and carton of 24).
    const owner = await signup(OWNER, 'Duka la Amina');
    const manager = await staff(owner, MANAGER_PHONE, 'Wanjiru', 'MANAGER');
    t.clock.advanceMinutes(2);
    const attendant = await staff(owner, ATTENDANT_PHONE, 'Baraka', 'ATTENDANT');
    const loc = ok<{ locations: { id: string }[] }>(await call('GET', '/v1/locations', owner)).locations[0].id;
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

    // 2. The manager receives 10 cartons and 5 pieces; the attendant may not.
    const delivery = { location_id: loc, reference: 'INV-104', lines: [{ pack_type_id: CARTON, quantity: 10 }, { pack_type_id: PIECE, quantity: 5 }] };
    expect(await cmd(manager.token, 'stock.receive', delivery)).toEqual({
      command_id: expect.any(String),
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: CARTON, quantity_after: 10 }, { pack_type_id: PIECE, quantity_after: 5 }] },
    });
    expect(await cmd(attendant.token, 'stock.receive', delivery)).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });

    // 3. A delivery with two bad lines lists both, and saves nothing.
    expect(
      await cmd(manager.token, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: PIECE, quantity: 0 }, { pack_type_id: UNKNOWN, quantity: 3 }] }),
    ).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_LINES',
      result: { invalid_lines: [{ line: 1, reason: 'QUANTITY_INVALID' }, { line: 2, reason: 'PACK_TYPE_NOT_FOUND' }] },
    });

    // 4. The manager writes off one damaged piece.
    expect(await cmd(manager.token, 'stock.adjust', { location_id: loc, pack_type_id: PIECE, quantity_change: -1, reason: 'DAMAGED', note: 'torn bag' })).toMatchObject({
      status: 'ACCEPTED',
      result: { quantity_after: 4 },
    });

    // 5. The attendant lists approvers, gets the manager's approval, and breaks a carton.
    expect(ok<{ approvers: { membership_id: string; display_name: string }[] }>(await call('GET', '/v1/stock/approvers', attendant.token)).approvers.map((a) => a.display_name)).toEqual([
      'Amina',
      'Wanjiru',
    ]);
    const approval = ok<{ approval_id: string; valid_until: string }>(
      await call('POST', '/v1/stock/approvals', attendant.token, { approver_membership_id: manager.membershipId, approver_pin: MANAGER_PIN, purpose: 'STOCK_CONVERT' }),
      201,
    );
    const convert = { location_id: loc, from_pack_type_id: CARTON, to_pack_type_id: PIECE, quantity: 1, approval_id: approval.approval_id };
    expect(await cmd(attendant.token, 'stock.convert', convert)).toMatchObject({
      status: 'ACCEPTED',
      result: { from_after: 9, to_after: 28, units_added: 24, approved_by_membership_id: manager.membershipId },
    });

    // 6. The same approval cannot be used again.
    expect(await cmd(attendant.token, 'stock.convert', convert)).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });

    // 7. The phone counts 27 pieces while it shows 28; before the count arrives, 2 more are written off.
    //    The count applies 27 - 28 = -1 to the live balance: 28 - 2 - 1 = 25, not 27.
    expect(await cmd(manager.token, 'stock.adjust', { location_id: loc, pack_type_id: PIECE, quantity_change: -2, reason: 'DAMAGED' })).toMatchObject({
      result: { quantity_after: 26 },
    });
    expect(await cmd(manager.token, 'stock.count', { location_id: loc, lines: [{ pack_type_id: PIECE, expected_quantity: 28, counted_quantity: 27 }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: PIECE, delta: -1, quantity_after: 25 }] },
    });

    // 8. Balances and history; the attendant sees no cost key, the owner does.
    const stock = ok<{ balances: { pack_type_name: string; quantity: number }[] }>(await call('GET', '/v1/stock', attendant.token));
    expect(stock.balances.map((b) => [b.pack_type_name, b.quantity])).toEqual(
      [CARTON, PIECE].sort().map((id) => (id === CARTON ? ['carton of 24', 9] : ['piece', 25])),
    );
    const history = ok<{ movements: Record<string, unknown>[] }>(await call('GET', '/v1/stock/movements', attendant.token));
    expect(history.movements.map((m) => m.movement_type)).toEqual(
      expect.arrayContaining(['RECEIVE', 'RECEIVE', 'ADJUST', 'CONVERT_OUT', 'CONVERT_IN', 'ADJUST', 'COUNT']),
    );
    expect(history.movements).toHaveLength(7);
    expect(history.movements.every((m) => !('unit_cost' in m))).toBe(true);
    expect(ok<{ movements: Record<string, unknown>[] }>(await call('GET', '/v1/stock/movements', owner)).movements.every((m) => 'unit_cost' in m)).toBe(true);
    const converted = history.movements.find((m) => m.movement_type === 'CONVERT_IN');
    expect(converted).toMatchObject({ created_by: { membership_id: attendant.membershipId, display_name: 'Baraka' } });

    // 9. A second business sees none of it.
    t.clock.advanceMinutes(2);
    const second = await signup(SECOND, 'Duka B');
    expect(ok<{ balances: unknown[] }>(await call('GET', '/v1/stock', second)).balances).toEqual([]);
    expect(ok<{ movements: unknown[] }>(await call('GET', '/v1/stock/movements', second)).movements).toEqual([]);
  });
});
