import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';

// Phase D4 test 3: the manual walkthrough of docs/phase-d-walkthrough.md
// (design section 12), step by step, with the same values as the document,
// so the document cannot silently go stale. The dev fixed codes are switched
// on exactly as the document says (the code 123456 for listed targets).

const CODE = '123456';
const OWNER = { phone: '0712000401', email: 'sync-owner@example.com' };
const MANAGER_PHONE = '0712000402';
const ATTENDANT_PHONE = '0712000403';
const SECOND = { phone: '0712000409', email: 'sync-second@example.com' };
const ALLOWLIST = ['+254712000401', '+254712000402', '+254712000403', '+254712000409', OWNER.email, SECOND.email].join(',');

const MAIZE = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CARTON = '33333333-3333-4333-8333-333333333333';

let commandSeq = 0;
const commandId = () => `dddddddd-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

type Row = Record<string, unknown> & { id: string };
interface Page {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}
interface Changes {
  changes: { table: string; op: string; id: string; row?: Row }[];
  next_cursor: string;
  has_more: boolean;
}

describe('D4 test 3: the Phase D walkthrough runs end to end', { timeout: 120_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.170' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json() as T;
  };
  const cmd = async (token: string, type: string, payload: object) =>
    ok<{ results: { status: string; reason?: string }[] }>(
      await call('POST', '/v1/sync/commands', token, { commands: [{ command_id: commandId(), type, occurred_at: t.clock.now().toISOString(), payload }] }),
    ).results[0];
  const snap = (token: string, query: string) => call('GET', `/v1/sync/snapshot${query}`, token).then((r) => ok<Page>(r));
  const changes = (token: string, cursor: string) => call('GET', `/v1/sync/changes?cursor=${encodeURIComponent(cursor)}`, token);

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

  it('runs the six steps of docs/phase-d-walkthrough.md', async () => {
    // 1. Owner, manager and attendant; the manager creates maize flour with a barcode;
    //    the owner sets a cost; the manager receives stock.
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
        barcodes: [{ barcode: '6161101560029', pack_type_id: PIECE }],
      }),
    ).toMatchObject({ status: 'ACCEPTED' });
    expect(await cmd(owner, 'pack_type.upsert', { pack_type_id: PIECE, product_id: MAIZE, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' })).toMatchObject({ status: 'ACCEPTED' });
    expect(await cmd(manager.token, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: CARTON, quantity: 10 }, { pack_type_id: PIECE, quantity: 5 }] })).toMatchObject({ status: 'ACCEPTED' });

    // 2. The attendant downloads the snapshot and keeps start_cursor; no cost anywhere.
    //    The manager starts one too (MGR_CURSOR, used in step 5).
    const start = await snap(attendant.token, '?limit=500');
    expect(start).toMatchObject({ table: 'location', next_cursor: null, next_table: 'product', start_cursor: expect.any(String) });
    const attCursor = start.start_cursor!;
    expect((await snap(attendant.token, '?table=product&limit=500')).rows.map((r) => r.name)).toEqual(['Maize flour 2kg']);
    const packs1 = await snap(attendant.token, '?table=pack_type&limit=1');
    expect(packs1).toMatchObject({ table: 'pack_type', next_cursor: expect.any(String), next_table: null });
    const packs2 = await snap(attendant.token, `?table=pack_type&cursor=${encodeURIComponent(packs1.next_cursor!)}&limit=1`);
    expect(packs2).toMatchObject({ next_cursor: null, next_table: 'product_barcode' });
    for (const r of [...packs1.rows, ...packs2.rows]) expect(r).not.toHaveProperty('cost_price');
    expect((await snap(attendant.token, '?table=product_barcode&limit=500')).rows.map((r) => r.barcode)).toEqual(['6161101560029']);
    const balances = await snap(attendant.token, '?table=stock_balance&limit=500');
    expect(balances).toMatchObject({ next_cursor: null, next_table: 'sale' }); // the sale tables follow since E4
    expect(balances.rows.map((r) => Number(r.quantity)).sort((a, b) => a - b)).toEqual([5, 10]);
    const mgrCursor = (await snap(manager.token, '?limit=500')).start_cursor!;

    // 3. The manager edits a price, adds a barcode and breaks a carton.
    expect(await cmd(manager.token, 'pack_type.upsert', { pack_type_id: PIECE, product_id: MAIZE, name: 'piece', units_per_pack: 1, sell_price: '190' })).toMatchObject({ status: 'ACCEPTED' });
    expect(await cmd(manager.token, 'barcode.add', { barcode: '16161101560026', product_id: MAIZE, pack_type_id: CARTON })).toMatchObject({ status: 'ACCEPTED' });
    expect(await cmd(manager.token, 'stock.convert', { location_id: loc, from_pack_type_id: CARTON, to_pack_type_id: PIECE, quantity: 1 })).toMatchObject({ status: 'ACCEPTED' });

    // 4. The attendant gets exactly those changes; calling again with the new cursor gives nothing.
    const got = ok<Changes>(await changes(attendant.token, attCursor));
    expect(got.has_more).toBe(false);
    expect(got.changes.map((c) => [c.table, c.op])).toEqual([
      ['pack_type', 'upsert'],
      ['product_barcode', 'upsert'],
      ['stock_balance', 'upsert'],
      ['stock_balance', 'upsert'],
    ]);
    expect(got.changes[0].row).toMatchObject({ id: PIECE, sell_price: '190.00' });
    expect(got.changes[0].row).not.toHaveProperty('cost_price');
    expect(got.changes[1].row).toMatchObject({ barcode: '16161101560026', pack_type_id: CARTON });
    expect(got.changes.slice(2).map((c) => [c.row!.pack_type_id, c.row!.quantity])).toEqual([
      [CARTON, 9],
      [PIECE, 29],
    ]);
    expect(ok<Changes>(await changes(attendant.token, got.next_cursor))).toEqual({ changes: [], next_cursor: got.next_cursor, has_more: false });

    // 5. The manager is given costs.view: the attendant's cursor still works; the manager's old one is 410,
    //    and a fresh snapshot shows costs.
    expect((await call('PATCH', `/v1/staff/${manager.membershipId}`, owner, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    expect((await changes(attendant.token, got.next_cursor)).statusCode).toBe(200);
    const refused = await changes(manager.token, mgrCursor);
    expect(refused.statusCode).toBe(410);
    expect((refused.json() as { error: { code: string } }).error.code).toBe('SNAPSHOT_REQUIRED');
    const withCosts = await snap(manager.token, '?table=pack_type&limit=500');
    expect(withCosts.rows.find((r) => r.id === PIECE)).toMatchObject({ sell_price: '190.00', cost_price: '150.00' });

    // 6. A second business sees none of it.
    t.clock.advanceMinutes(2);
    const second = await signup(SECOND, 'Duka B');
    const secondStart = await snap(second, '?limit=500');
    expect(secondStart.rows.map((r) => r.name)).toEqual(['Main shop']);
    expect(secondStart.rows[0].id).not.toBe(loc);
    expect((await snap(second, '?table=product&limit=500')).rows).toEqual([]);
    expect(ok<Changes>(await changes(second, secondStart.start_cursor!)).changes).toEqual([]);
  });
});
