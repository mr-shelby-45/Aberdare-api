import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type TestWorker, startTestWorker } from './helpers/worker.js';

// Phase F6 test 4: the manual walkthrough of docs/phase-f-walkthrough.md
// (design section 12), step by step, with the same values as the document,
// so it cannot silently go stale. `pnpm job:run <name>` in the document is
// queue.send(<name>) here; the SQL lines are the same statements, run as the
// superuser on the test database (with the fake clock's time where the
// document uses now()).

const CODE = '123456';
const OWNER = { phone: '0712000701', email: 'worker-owner@example.com' };
const MANAGER_PHONE = '0712000702';
const ATTENDANT_PHONE = '0712000703';
const FIELD_PHONE = '0712000704';
const SECOND = { phone: '0712000709', email: 'worker-second@example.com' };
const ALLOWLIST = ['+254712000701', '+254712000702', '+254712000703', '+254712000704', '+254712000709', OWNER.email, SECOND.email].join(',');

const MAIZE = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CARTON = '33333333-3333-4333-8333-333333333333';
const SALE_A = 'd1d1d1d1-0000-4000-8000-000000000001';
const SETTLEMENT = 'e1e1e1e1-0000-4000-8000-000000000001';
const DAY = 86_400_000;

let commandSeq = 0;
const commandId = () => `fafafafa-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

type Row = Record<string, unknown> & { id: string };
interface Result {
  status: string;
  reason?: string;
  result?: Record<string, unknown>;
}

describe('F6 test 4: the Phase F walkthrough runs end to end', { timeout: 180_000 }, () => {
  let t: TestApp;
  let worker: TestWorker;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await worker?.shutdown();
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.201' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return (status === 204 ? undefined : res.json()) as T;
  };
  const cmd = async (token: string, type: string, payload: object) =>
    ok<{ results: Result[] }>(await call('POST', '/v1/sync/commands', token, { commands: [{ command_id: commandId(), type, occurred_at: t.clock.now().toISOString(), payload }] })).results[0];
  const notifications = async (token: string) => ok<{ notifications: Row[] }>(await call('GET', '/v1/notifications', token)).notifications;
  async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

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
    return { token: active.access_token, membershipId: created.membership_id };
  }

  it('runs the nine steps of docs/phase-f-walkthrough.md', async () => {
    // 1. The API and the worker.
    worker = await startTestWorker(t.clock, { schedules: false, listen: true });

    // 2. The shop, its people, and low stock.
    const owner = await signup(OWNER, 'Duka la Amina');
    const shop = ok<{ locations: { id: string }[] }>(await call('GET', '/v1/locations', owner)).locations[0].id;
    const manager = await staff(owner, MANAGER_PHONE, 'Wanjiru', 'MANAGER');
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
    expect(await cmd(manager.token, 'stock.receive', { location_id: shop, lines: [{ pack_type_id: PIECE, quantity: 2 }, { pack_type_id: CARTON, quantity: 3 }] })).toMatchObject({ status: 'ACCEPTED' });

    // 3. An oversell: the owner sees sale.flagged, then marks it read.
    expect(await cmd(attendant.token, 'sale.create', { sale_id: SALE_A, local_ref: 'A-0001', location_id: shop, lines: [{ pack_type_id: PIECE, quantity: 5, unit_price: '180' }], payments: [{ method: 'CASH', amount: '900' }] })).toMatchObject({
      status: 'FLAGGED',
      reason: 'STOCK_NEGATIVE',
    });
    let ownerList = await notifications(owner);
    expect(ownerList.map((n) => [n.type, n.message])).toEqual([['sale.flagged', 'Sale #1 was flagged: Stock went negative.']]);
    expect(ok(await call('GET', '/v1/notifications/unread-count', owner))).toEqual({ unread: 1 });
    ok(await call('POST', '/v1/notifications/read', owner, { all: true }), 204);
    expect(ok(await call('GET', '/v1/notifications/unread-count', owner))).toEqual({ unread: 0 });

    t.clock.advanceMinutes(1); // time passes between steps, as in the document
    // 4. The manager breaks a carton into pieces: the owner is told.
    expect(await cmd(manager.token, 'stock.convert', { location_id: shop, from_pack_type_id: CARTON, to_pack_type_id: PIECE, quantity: 1 })).toMatchObject({ status: 'ACCEPTED' });
    ownerList = await notifications(owner);
    expect(ownerList[0]).toMatchObject({ type: 'stock.converted', message: 'A pack was broken into smaller units.', read_at: null });

    t.clock.advanceMinutes(1); // time passes between steps, as in the document
    // 5. The attendant voids sale A with the manager's PIN: the manager gets in-app and a (fake) push.
    ok(await call('PUT', '/v1/devices/me/push-token', manager.token, { push_token: 'walkthrough-token' }), 204);
    const approval = ok<{ approval_id: string }>(await call('POST', '/v1/stock/approvals', attendant.token, { approver_membership_id: manager.membershipId, approver_pin: '2468', purpose: 'SALE_VOID' }), 201).approval_id;
    expect(await cmd(attendant.token, 'sale.void', { sale_id: SALE_A, reason: 'MISTAKE', approval_id: approval })).toMatchObject({ status: 'ACCEPTED' });
    expect((await notifications(manager.token)).map((n) => [n.type, n.message])).toEqual([['approval.used', 'Your PIN approved a sale void.']]);
    await waitFor(() => worker.push.outbox.length === 1, 'the push');
    expect(worker.push.outbox[0]).toMatchObject({ token: 'walkthrough-token', answer: 'OK', push: { type: 'approval.used' } });
    await waitFor(() => worker.lines().includes('"msg":"push delivered"'), 'the masked log line');
    expect(worker.lines()).not.toContain('walkthrough-token');

    t.clock.advanceMinutes(1); // time passes between steps, as in the document
    // 6. A field day closes short: the owner gets settlement.variance.
    const field = await staff(owner, FIELD_PHONE, 'Otieno', 'FIELD_ATTENDANT');
    const van = ok<Row>(await call('POST', '/v1/locations', owner, { name: 'Van 1', kind: 'FIELD', assigned_membership_id: field.membershipId }), 201).id;
    expect(await cmd(manager.token, 'stock.issue', { from_location_id: shop, to_location_id: van, lines: [{ pack_type_id: PIECE, quantity: 5 }] })).toMatchObject({ status: 'ACCEPTED' });
    ok(await call('GET', '/v1/sync/snapshot?limit=1', field.token));
    expect(await cmd(manager.token, 'settlement.close', { settlement_id: SETTLEMENT, field_location_id: van, cash_received: '0', lines: [{ pack_type_id: PIECE, counted_quantity: 4 }] })).toMatchObject({
      status: 'ACCEPTED',
      result: { cash_variance: '0.00' },
    });
    ownerList = await notifications(owner);
    expect(ownerList[0]).toMatchObject({ type: 'settlement.variance', message: 'A field settlement closed with a cash variance of KES 0.00 and 1 line with a count difference.' });

    t.clock.advanceMinutes(1); // time passes between steps, as in the document
    // 7. The attendant's phone has not synced for 4 days; the stale-device job tells the owner once.
    await asAdmin((c) => c.query('UPDATE device SET last_sync_at = $2 WHERE registered_by_membership_id = $1', [attendant.membershipId, new Date(t.clock.now().getTime() - 4 * DAY)]));
    const staleCount = async () => (await notifications(owner)).filter((n) => n.type === 'device.stale').length;
    await worker.queue.send('devices.stale', {});
    await waitFor(async () => (await staleCount()) === 1, 'device.stale');
    await worker.queue.send('devices.stale', {});
    await waitFor(() => (worker.lines().match(/"msg":"stale devices checked"/g) ?? []).length >= 2, 'the second stale run');
    expect(await staleCount()).toBe(1);
    expect((await notifications(owner))[0]).toMatchObject({ type: 'device.stale', message: 'A phone has not synced for 4 days.' });

    t.clock.advanceMinutes(1); // time passes between steps, as in the document
    // 8. A balance is corrupted on purpose; the integrity job writes an error_event (no notification).
    await asAdmin((c) => c.query('UPDATE stock_balance SET quantity = quantity + 1 WHERE location_id = $1 AND pack_type_id = $2', [shop, PIECE]));
    const before = (await notifications(owner)).length;
    await worker.queue.send('stock.integrity', {});
    await waitFor(async () => (await asAdmin((c) => c.query("SELECT 1 FROM error_event WHERE code = 'INTEGRITY_MISMATCH'"))).rows.length === 1, 'the integrity error_event');
    const event = (await asAdmin((c) => c.query("SELECT source, code, detail FROM error_event WHERE code = 'INTEGRITY_MISMATCH'"))).rows[0];
    expect(event).toEqual({ source: 'stock.integrity', code: 'INTEGRITY_MISMATCH', detail: `pools=1 ${shop.slice(0, 8)}:${PIECE.slice(0, 8)}` });
    expect((await notifications(owner)).length).toBe(before);

    t.clock.advanceMinutes(1); // time passes between steps, as in the document
    // 9. A second business sees none of it.
    const second = await signup(SECOND, 'Duka B');
    expect(await notifications(second)).toEqual([]);
    expect(ok(await call('GET', '/v1/notifications/unread-count', second))).toEqual({ unread: 0 });
    ok(await call('POST', '/v1/notifications/read', second, { ids: [ownerList[0].id] }), 204);
    expect((await notifications(owner)).find((n) => n.id === ownerList[0].id)!.read_at).toBeNull();
  });
});
