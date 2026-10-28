import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PRESET_PERMISSIONS } from '../src/common/auth/permissions.js';
import { TenantRunner } from '../src/database/tenant.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase T6: payments in the settlement window (docs/phase-t-design.md
// section 6, as changed in T6). A payment counts in, and its reversal out, in
// the settlement whose snapshot first sees it; only the attendant's own
// payments on their personal devices (registered by them, not shared, any
// status) count.

interface Settlement {
  expected_cash: string;
  cash_received: string;
  cash_variance: string;
  mpesa_unverified_total: string;
  sale_count: number;
  voided_count: number;
  unpaid_total: string;
  earlier_sales_cash: string;
}

describe('T6: payments in the settlement window', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.196', 99_600_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  interface FieldWorld extends World {
    f1: Member;
    van: string;
  }
  const sync = async (token: string) => expect((await api.call('GET', '/v1/sync/snapshot?limit=1', token)).statusCode).toBe(200);
  /** A shop, a field attendant whose van holds 40 pieces, and a synced phone. */
  async function fieldWorld(): Promise<FieldWorld> {
    const w = await api.world('Duka A');
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const created = await api.post('/v1/locations', { name: 'Van 1', kind: 'FIELD', assigned_membership_id: f1.membershipId }, w.owner.token);
    expect(created.statusCode, created.body).toBe(201);
    const van = api.json<{ id: string }>(created).id;
    expect((await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 100 }] }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('stock.issue', { from_location_id: w.loc, to_location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 40 }] }))).status).toBe('ACCEPTED');
    await sync(f1.token);
    return { ...w, f1, van };
  }
  /** A sale of `qty` pieces at the van, by this token. */
  async function sale(w: FieldWorld, token: string, qty: number, payments: object[] = []): Promise<string> {
    const id = randomUUID();
    const r = await api.sendOne(token, api.command('sale.create', { sale_id: id, local_ref: 'F', location_id: w.van, lines: [{ pack_type_id: w.maize.piece, quantity: qty, unit_price: '180' }], payments }));
    expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    return id;
  }
  const cash = (amount: string) => ({ method: 'CASH', amount });
  /** Closes the van with the count equal to the balance (no adjustments); returns the stored settlement. */
  async function close(w: FieldWorld, cashReceived: string, phoneToken = w.f1.token): Promise<Settlement & { id: string }> {
    await sync(phoneToken);
    const balance = await asAdmin(async (c) => (await c.query<{ quantity: number }>('SELECT quantity FROM stock_balance WHERE location_id = $1 AND pack_type_id = $2', [w.van, w.maize.piece])).rows[0].quantity);
    const id = randomUUID();
    const r = await api.sendOne(
      w.manager.token,
      api.command('settlement.close', { settlement_id: id, field_location_id: w.van, cash_received: cashReceived, lines: [{ pack_type_id: w.maize.piece, counted_quantity: Math.max(0, balance) }] }),
    );
    expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    t.clock.advanceMinutes(1); // later sales are not AFTER_SETTLEMENT
    return { id, ...(await settlementOf(w, id)) };
  }
  const settlementOf = async (w: FieldWorld, id: string) => {
    const res = await api.call('GET', `/v1/field/settlements/${id}`, w.manager.token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Settlement;
  };
  const dispatch = (w: World, membershipId: string, deviceId: string, permissions: ReadonlySet<string>, cmd: object) =>
    t.app.get(SyncService, { strict: false }).processCommands({ businessId: w.owner.businessId, membershipId, deviceId, permissions }, [cmd]);
  async function device(w: World, registeredBy: Member, shared: boolean): Promise<{ deviceId: string; deviceSecret: string }> {
    const d = await t.app.get(TenantRunner, { strict: false }).run(w.owner.businessId, () =>
      t.app.get(DevicesService, { strict: false }).register({ name: 'Device', platform: 'android', registeredByMembershipId: registeredBy.membershipId, now: t.clock.now() }),
    );
    if (shared) {
      expect((await api.call('PATCH', `/v1/devices/${d.deviceId}`, w.owner.token, { is_shared: true })).statusCode).toBe(204);
      expect((await api.call('POST', `/v1/devices/${d.deviceId}/members`, w.owner.token, { membership_id: registeredBy.membershipId })).statusCode).toBe(204);
    }
    return d;
  }
  async function pinLogin(d: { deviceId: string; deviceSecret: string }, membershipId?: string): Promise<string> {
    const res = await api.post('/v1/auth/pin', { device_id: d.deviceId, device_secret: d.deviceSecret, pin: STAFF_PIN, ...(membershipId ? { membership_id: membershipId } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    return api.json<{ access_token: string }>(res).access_token;
  }
  async function lockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const waiting = await asAdmin(
        async (c) => Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n),
      );
      if (waiting >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`fewer than ${n} backends waited for a lock`);
  }

  // ---------------------------------------------------------------- 1. a late payment
  it('1. a payment after the close counts in the next settlement, once, as cash of an earlier sale', async () => {
    const w = await fieldWorld();
    const s = await sale(w, w.f1.token, 2); // on credit: 360 due
    const s1 = await close(w, '0');
    expect(s1).toMatchObject({ expected_cash: '0.00', unpaid_total: '360.00', sale_count: 1, earlier_sales_cash: '0.00' });

    // The customer pays the hawker at 6pm.
    expect((await api.sendOne(w.f1.token, api.command('payment.attach', { sale_id: s, payments: [cash('360')] }))).status).toBe('ACCEPTED');
    const s2 = await close(w, '360');
    expect(s2).toMatchObject({ expected_cash: '360.00', cash_variance: '0.00', sale_count: 0, earlier_sales_cash: '360.00' });
    const s3 = await close(w, '0');
    expect(s3).toMatchObject({ expected_cash: '0.00', earlier_sales_cash: '0.00' });
    // The first settlement is final and unchanged.
    expect(await settlementOf(w, s1.id)).toMatchObject({ expected_cash: '0.00', unpaid_total: '360.00' });
    // The preview agrees with the stored figures.
    const preview = await api.call('GET', `/v1/field/settlements/preview?location_id=${w.van}`, w.manager.token);
    expect(preview.json()).toMatchObject({ expected_cash: '0.00', earlier_sales_cash: '0.00' });
  });

  // ---------------------------------------------------------------- 2. a late refund
  it('2. a void after the close takes the refund out of the next settlement (negative expected cash); reversed_txid is set', async () => {
    const w = await fieldWorld();
    const s = await sale(w, w.f1.token, 3, [cash('300'), { method: 'MPESA', amount: '240', mpesa_code: 'LATEREF01' }]);
    const s1 = await close(w, '300');
    expect(s1).toMatchObject({ expected_cash: '300.00', mpesa_unverified_total: '240.00', cash_variance: '0.00' });

    expect((await api.sendOne(w.manager.token, api.command('sale.void', { sale_id: s, reason: 'CUSTOMER_CANCELLED' }))).status).toBe('ACCEPTED');
    const s2 = await close(w, '0');
    expect(s2).toMatchObject({ expected_cash: '-300.00', mpesa_unverified_total: '-240.00', cash_variance: '300.00', earlier_sales_cash: '-300.00', voided_count: 0 });

    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ ok: boolean }>("SELECT (status = 'REVERSED' AND reversed_txid IS NOT NULL AND location_id = $2) AS ok FROM payment WHERE sale_id = $1", [s, w.van])).rows,
    );
    expect(rows.map((r) => r.ok)).toEqual([true, true]);
    // The database refuses a reversal without its txid, and a payment at another location than its sale.
    await expect(asAdmin((c) => c.query("UPDATE payment SET reversed_txid = NULL WHERE sale_id = $1", [s]))).rejects.toThrow(/payment_reversed_txid_with_status/);
    await expect(asAdmin((c) => c.query('UPDATE payment SET location_id = $2 WHERE sale_id = $1', [s, w.loc]))).rejects.toThrow(/payment_business_id_sale_id_location_id_fkey/);
  });

  // ---------------------------------------------------------------- 3. forced: an attach still saving during a close
  it('3. forced: a payment whose transaction is still running at the close counts in the next settlement', async () => {
    const w = await fieldWorld();
    const s = await sale(w, w.f1.token, 2);
    await sync(w.f1.token);
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let attach: Promise<{ status: string }>;
    let s1: Settlement & { id: string };
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM sale WHERE id = $1 FOR UPDATE', [s]);
      attach = api.sendOne(w.f1.token, api.command('payment.attach', { sale_id: s, payments: [cash('360')] }));
      await lockWaiters(1); // the attach has claimed its command and waits at the sale row
      s1 = await close(w, '0');
    } finally {
      await held.query('ROLLBACK');
      await held.end();
    }
    expect((await attach).status).toBe('ACCEPTED');
    expect(s1).toMatchObject({ expected_cash: '0.00', earlier_sales_cash: '0.00' });
    const s2 = await close(w, '360');
    expect(s2).toMatchObject({ expected_cash: '360.00', earlier_sales_cash: '360.00' });
  });

  // ---------------------------------------------------------------- 4. Ian 1: shared tablets
  it('4. a payment the hawker records on a shared tablet is not in their expected cash (owner\'s tablet and their own shared one)', async () => {
    const w = await fieldWorld();
    const ownersTablet = await device(w, w.owner, true);
    await api.call('POST', `/v1/devices/${ownersTablet.deviceId}/members`, w.owner.token, { membership_id: w.f1.membershipId });
    const hawkersTablet = await device(w, w.f1, true); // registered by the hawker, then made shared: only is_shared excludes it
    await sale(w, await pinLogin(ownersTablet, w.f1.membershipId), 1, [cash('100')]);
    await sale(w, await pinLogin(hawkersTablet, w.f1.membershipId), 1, [cash('150')]);
    await sale(w, w.f1.token, 1, [cash('50')]); // the hawker's own phone
    const s1 = await close(w, '50');
    expect(s1).toMatchObject({ expected_cash: '50.00', sale_count: 3, cash_variance: '0.00' });
  });

  // ---------------------------------------------------------------- 5. Ian 2: a revoked phone
  it('5. a payment on the hawker\'s phone that was later revoked still counts', async () => {
    const w = await fieldWorld();
    await sale(w, w.f1.token, 1, [cash('70')]);
    const phone2 = await pinLogin(await device(w, w.f1, false)); // a new personal phone
    expect((await api.call('DELETE', `/v1/devices/${w.f1.deviceId}`, w.owner.token)).statusCode).toBe(204);
    const s1 = await close(w, '70', phone2);
    expect(s1).toMatchObject({ expected_cash: '70.00', cash_variance: '0.00' });
  });

  // ---------------------------------------------------------------- 6. Ian 3: a manager on the hawker's phone
  it('6. a payment by a manager on the hawker\'s personal phone is not counted', async () => {
    const w = await fieldWorld();
    const s = await sale(w, w.f1.token, 2);
    await sale(w, w.f1.token, 1, [cash('180')]); // the hawker's own payment, counted
    // The API cannot do this today (a PIN login on a personal phone is always its owner), so the
    // dispatcher gets the actor directly: the rule must hold in the query, not only at login.
    const [r] = await dispatch(w, w.manager.membershipId, w.f1.deviceId!, PRESET_PERMISSIONS.MANAGER, api.command('payment.attach', { sale_id: s, payments: [cash('360')] }));
    expect(r.status).toBe('ACCEPTED');
    const s1 = await close(w, '180');
    expect(s1).toMatchObject({ expected_cash: '180.00', unpaid_total: '0.00' });
  });

  // ---------------------------------------------------------------- 7. Ian 4: a manager on their own device
  it('7. a manager attaching a payment from their own device to a hawker\'s sale is not counted', async () => {
    const w = await fieldWorld();
    const s = await sale(w, w.f1.token, 2);
    await sale(w, w.f1.token, 1, [cash('180')]); // the hawker's own payment, counted
    expect((await api.sendOne(w.manager.token, api.command('payment.attach', { sale_id: s, payments: [cash('360')] }))).status).toBe('ACCEPTED');
    const s1 = await close(w, '180');
    expect(s1).toMatchObject({ expected_cash: '180.00', unpaid_total: '0.00' });
  });

  // ---------------------------------------------------------------- 8. the hawker on someone else's personal device
  it('8. a payment by the hawker on a personal device registered by someone else is not counted', async () => {
    const w = await fieldWorld();
    const s = await sale(w, w.f1.token, 2);
    await sale(w, w.f1.token, 1, [cash('180')]); // the hawker's own payment, counted
    // Also not possible through the API today (see test 6): the hawker on the manager's phone.
    const [r] = await dispatch(w, w.f1.membershipId, w.manager.deviceId!, PRESET_PERMISSIONS.FIELD_ATTENDANT, api.command('payment.attach', { sale_id: s, payments: [cash('360')] }));
    expect(r.status).toBe('ACCEPTED');
    const s1 = await close(w, '180');
    expect(s1).toMatchObject({ expected_cash: '180.00', unpaid_total: '0.00' });
  });
});
