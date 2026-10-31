import { randomUUID } from 'node:crypto';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { DATA_KEYS, type NotificationType } from '../src/modules/notifications/notification-types.js';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';
import { type TestWorker, startTestWorker } from './helpers/worker.js';

// Phase F4: the events wired into the commands (docs/phase-f-design.md
// section 6). Test numbers follow the F4 list in section 11.

interface Note {
  recipient: string;
  type: string;
  channel: string;
  data: Record<string, unknown>;
}

describe('F4: notification events', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  const workers: TestWorker[] = [];

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.199', 99_900_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (workers.length > 0) await workers.pop()!.shutdown();
  });

  const notes = (businessId: string) =>
    asAdmin(
      async (c) =>
        (
          await c.query<Note>(
            'SELECT recipient_membership_id AS recipient, type, channel, data FROM notification WHERE business_id = $1 ORDER BY type, recipient_membership_id, channel',
            [businessId],
          )
        ).rows,
    );
  const errorEvents = () => asAdmin(async (c) => (await c.query<{ source: string; code: string }>('SELECT source, code FROM error_event ORDER BY created_at')).rows);
  const receive = async (w: World, pieces: number, cartons = 0) => {
    const lines = [{ pack_type_id: w.maize.piece, quantity: pieces }, { pack_type_id: w.maize.carton, quantity: cartons }].filter((l) => l.quantity > 0);
    expect((await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines }))).status).toBe('ACCEPTED');
  };
  const saleCmd = (w: World, over: Record<string, unknown> = {}, qty = 1) =>
    api.command('sale.create', { sale_id: randomUUID(), local_ref: 'F4', location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: qty, unit_price: '180' }], payments: [{ method: 'CASH', amount: String(180 * qty) }], ...over });
  const approval = async (caller: Member, approver: Member, purpose: 'STOCK_CONVERT' | 'SALE_VOID') => {
    const res = await api.post('/v1/stock/approvals', { approver_membership_id: approver.membershipId, approver_pin: STAFF_PIN, purpose }, caller.token);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ approval_id: string }>(res).approval_id;
  };
  const convertCmd = (w: World, over: Record<string, unknown> = {}) =>
    api.command('stock.convert', { location_id: w.loc, from_pack_type_id: w.maize.carton, to_pack_type_id: w.maize.piece, quantity: 1, ...over });
  const flagsOf = (n: Note) => n.data.flags as string[];

  // ---------------------------------------------------------------- 1. sale.flagged
  it('1. a flagged sale notifies each active owner once, in the sale\'s transaction; unflagged none; repeats and 20 copies once; a rolled-back sale none; the owner who sold is not told', async () => {
    const w = await api.world();
    await receive(w, 10);
    // Unflagged: nothing.
    expect((await api.sendOne(w.attendant.token, saleCmd(w))).status).toBe('ACCEPTED');
    expect(await notes(w.owner.businessId)).toEqual([]);
    // Each reason, by the attendant (the oversell last: after it every sale here is also STOCK_NEGATIVE).
    expect((await api.sendOne(w.attendant.token, saleCmd(w, { total: '170' }))).status).toBe('FLAGGED');
    expect((await api.sendOne(w.attendant.token, saleCmd(w, { payments: [{ method: 'MPESA', amount: '180', mpesa_code: 'F4CODE001' }] }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.attendant.token, saleCmd(w, { payments: [{ method: 'MPESA', amount: '180', mpesa_code: 'F4CODE001' }] }))).status).toBe('FLAGGED');
    expect((await api.sendOne(w.attendant.token, saleCmd(w, { payments: [{ method: 'CASH', amount: '200' }] }))).status).toBe('FLAGGED');
    const negative = saleCmd(w, {}, 50);
    expect((await api.sendOne(w.attendant.token, negative)).status).toBe('FLAGGED');
    const all = await notes(w.owner.businessId);
    expect(all.map((n) => [n.type, n.recipient, n.channel])).toEqual(Array.from({ length: 4 }, () => ['sale.flagged', w.owner.membershipId, 'IN_APP']));
    expect(all.map(flagsOf).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([['DUPLICATE_MPESA_CODE'], ['OVERPAYMENT'], ['STOCK_NEGATIVE'], ['TOTAL_MISMATCH']]);
    // The same command again, and 20 copies of a new one at once: one each.
    expect((await api.sendOne(w.attendant.token, negative)).status).toBe('FLAGGED');
    const copy = saleCmd(w, {}, 50);
    await Promise.all(Array.from({ length: 20 }, () => api.sendOne(w.attendant.token, copy)));
    expect(await notes(w.owner.businessId)).toHaveLength(5);
    expect(await errorEvents()).toEqual([]);

    // A sale that rolls back after its notification was written leaves none.
    const svc = t.app.get(NotificationsService, { strict: false });
    const original = svc.notify.bind(svc);
    vi.spyOn(svc, 'notify').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('crash after the notification');
    });
    const crashed = saleCmd(w, {}, 50);
    expect((await api.sendOne(w.attendant.token, crashed)).status).toBe('FAILED');
    expect(await notes(w.owner.businessId)).toHaveLength(5);

    // The owner's own flagged sale: nobody to tell (the only owner caused it).
    expect((await api.sendOne(w.owner.token, saleCmd(w, {}, 50))).status).toBe('FLAGGED');
    expect(await notes(w.owner.businessId)).toHaveLength(5);
  });

  it('1b. an AFTER_SETTLEMENT sale notifies with that flag listed', async () => {
    const w = await api.world();
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: f1.membershipId }, w.owner.token)).id;
    await receive(w, 10);
    expect((await api.sendOne(w.manager.token, api.command('stock.issue', { from_location_id: w.loc, to_location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 5 }] }))).status).toBe('ACCEPTED');
    expect((await api.call('GET', '/v1/sync/snapshot?limit=1', f1.token)).statusCode).toBe(200);
    const early = t.clock.now().toISOString();
    t.clock.advanceMinutes(1);
    expect((await api.sendOne(w.manager.token, api.command('settlement.close', { settlement_id: randomUUID(), field_location_id: van, cash_received: '0', lines: [{ pack_type_id: w.maize.piece, counted_quantity: 5 }] }))).status).toBe('ACCEPTED');
    const late = api.command('sale.create', { sale_id: randomUUID(), local_ref: 'L', location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 1, unit_price: '180' }], payments: [{ method: 'CASH', amount: '180' }] }, early);
    expect((await api.sendOne(f1.token, late)).status).toBe('FLAGGED');
    const flagged = (await notes(w.owner.businessId)).filter((n) => n.type === 'sale.flagged');
    expect(flagged.map(flagsOf)).toEqual([['AFTER_SETTLEMENT']]);
  });

  // ---------------------------------------------------------------- 2. stock.converted
  it('2. stock.convert by a manager notifies the owner; by the owner nobody; with an approval, stock.converted plus approval.used', async () => {
    const w = await api.world();
    await receive(w, 0, 5);
    const byManager = await api.sendOne(w.manager.token, convertCmd(w));
    expect(byManager.status).toBe('ACCEPTED');
    let all = await notes(w.owner.businessId);
    expect(all).toEqual([{ recipient: w.owner.membershipId, type: 'stock.converted', channel: 'IN_APP', data: { conversion_id: expect.any(String), converter_membership_id: w.manager.membershipId } }]);
    const byOwner = await api.sendOne(w.owner.token, convertCmd(w));
    expect(byOwner.status, JSON.stringify(byOwner)).toBe('ACCEPTED');
    expect(await notes(w.owner.businessId)).toHaveLength(1);
    // The attendant converts with the manager's PIN.
    const id = await approval(w.attendant, w.manager, 'STOCK_CONVERT');
    expect((await api.sendOne(w.attendant.token, convertCmd(w, { approval_id: id }))).status).toBe('ACCEPTED');
    all = await notes(w.owner.businessId);
    const conversionId = all.find((n) => n.type === 'stock.converted' && n.data.converter_membership_id === w.attendant.membershipId)!.data.conversion_id;
    expect(all.filter((n) => n.type === 'approval.used').map((n) => [n.recipient, n.channel])).toEqual(
      [
        [w.manager.membershipId, 'IN_APP'],
        [w.manager.membershipId, 'PUSH'],
        [w.owner.membershipId, 'IN_APP'],
      ].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])),
    );
    for (const n of all.filter((x) => x.type === 'approval.used')) {
      expect(n.data).toEqual({ approval_id: id, purpose: 'STOCK_CONVERT', requester_membership_id: w.attendant.membershipId, approver_membership_id: w.manager.membershipId, target_id: conversionId });
    }
    expect(all.some((n) => n.recipient === w.attendant.membershipId)).toBe(false);
  });

  // ---------------------------------------------------------------- 3. approval.used
  it('3. approval.used for a SALE_VOID; the approver\'s push is delivered; a conversion that fails and rolls its approval back creates nothing', async () => {
    const w = await api.world();
    await receive(w, 10);
    const sale = saleCmd(w);
    expect((await api.sendOne(w.attendant.token, sale)).status).toBe('ACCEPTED');
    const saleId = (sale.payload as { sale_id: string }).sale_id;
    const id = await approval(w.attendant, w.manager, 'SALE_VOID');
    expect((await api.sendOne(w.attendant.token, api.command('sale.void', { sale_id: saleId, reason: 'MISTAKE', approval_id: id }))).status).toBe('ACCEPTED');
    const used = (await notes(w.owner.businessId)).filter((n) => n.type === 'approval.used');
    const byPair = (a: string[], b: string[]) => a.join().localeCompare(b.join());
    expect(used.map((n) => [n.recipient, n.channel]).sort(byPair)).toEqual(
      [
        [w.manager.membershipId, 'IN_APP'],
        [w.manager.membershipId, 'PUSH'],
        [w.owner.membershipId, 'IN_APP'],
      ].sort(byPair),
    );
    expect(used[0].data).toMatchObject({ purpose: 'SALE_VOID', target_id: saleId });
    // The worker delivers the approver's push.
    const res = await api.call('PUT', '/v1/devices/me/push-token', w.manager.token, { push_token: 'tok-approver' });
    expect(res.statusCode).toBe(204);
    const wk = await startTestWorker(t.clock, { schedules: false, listen: false });
    workers.push(wk);
    expect(await wk.app.get(NotificationDeliveryService).dispatchBusiness(w.owner.businessId)).toMatchObject({ sent: 1 });
    expect(wk.push.outbox.map((o) => [o.token, o.push.type, o.push.message])).toEqual([['tok-approver', 'approval.used', 'Your PIN approved a sale void.']]);

    // A conversion that is refused (not enough cartons) rolls its approval back, and notifies nobody.
    const before = (await notes(w.owner.businessId)).length;
    const refusedId = await approval(w.attendant, w.manager, 'STOCK_CONVERT');
    const refused = await api.sendOne(w.attendant.token, convertCmd(w, { approval_id: refusedId, quantity: 3 }));
    expect(refused.status).toBe('REJECTED');
    expect(await notes(w.owner.businessId)).toHaveLength(before);
    expect(await asAdmin(async (c) => (await c.query('SELECT consumed_at FROM approval WHERE id = $1', [refusedId])).rows[0].consumed_at)).toBeNull();
  });

  // ---------------------------------------------------------------- 4. settlement.variance
  it('4. settlement.variance only for a cash or line variance; not for a closer who is the only owner; the push is delivered', async () => {
    const w = await api.world();
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: f1.membershipId }, w.owner.token)).id;
    await receive(w, 20);
    expect((await api.sendOne(w.manager.token, api.command('stock.issue', { from_location_id: w.loc, to_location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 10 }] }))).status).toBe('ACCEPTED');
    const close = async (closer: Member, cash: string, counted: number) => {
      expect((await api.call('GET', '/v1/sync/snapshot?limit=1', f1.token)).statusCode).toBe(200);
      const id = randomUUID();
      const r = await api.sendOne(closer.token, api.command('settlement.close', { settlement_id: id, field_location_id: van, cash_received: cash, lines: [{ pack_type_id: w.maize.piece, counted_quantity: counted }] }));
      expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
      t.clock.advanceMinutes(1);
      return id;
    };
    const variances = async () => (await notes(w.owner.businessId)).filter((n) => n.type === 'settlement.variance');
    await close(w.manager, '0', 10); // nothing to report
    expect(await variances()).toEqual([]);
    const short = await close(w.manager, '0', 9); // one piece missing
    expect((await variances()).map((n) => [n.recipient, n.channel, n.data])).toEqual([
      [w.owner.membershipId, 'IN_APP', { settlement_id: short, attendant_membership_id: f1.membershipId, cash_variance: '0.00', lines_with_variance: 1 }],
      [w.owner.membershipId, 'PUSH', { settlement_id: short, attendant_membership_id: f1.membershipId, cash_variance: '0.00', lines_with_variance: 1 }],
    ]);
    // Cash over, closed by the only owner: nobody else to tell.
    await close(w.owner, '50', 9);
    expect(await variances()).toHaveLength(2);
    // The owner's push is delivered.
    expect((await api.call('PUT', '/v1/devices/me/push-token', w.owner.token, { push_token: 'tok-owner' })).statusCode).toBe(204);
    const wk = await startTestWorker(t.clock, { schedules: false, listen: false });
    workers.push(wk);
    expect(await wk.app.get(NotificationDeliveryService).dispatchBusiness(w.owner.businessId)).toMatchObject({ sent: 1 });
    expect(wk.push.outbox.map((o) => o.push.type)).toEqual(['settlement.variance']);
  });

  // ---------------------------------------------------------------- 5. never fails a command
  it('5. with every notification insert failing, sale.create, stock.convert, sale.void and settlement.close still succeed, each with an error_event', async () => {
    const w = await api.world();
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: f1.membershipId }, w.owner.token)).id;
    await receive(w, 20, 5);
    expect((await api.sendOne(w.manager.token, api.command('stock.issue', { from_location_id: w.loc, to_location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 5 }] }))).status).toBe('ACCEPTED');
    const sale = saleCmd(w);
    expect((await api.sendOne(w.attendant.token, sale)).status).toBe('ACCEPTED');
    const voidApproval = await approval(w.attendant, w.manager, 'SALE_VOID');
    expect((await api.call('GET', '/v1/sync/snapshot?limit=1', f1.token)).statusCode).toBe(200);

    vi.spyOn(t.app.get(NotificationsRepository, { strict: false }), 'insertMany').mockRejectedValue(Object.assign(new Error('insert failed'), { code: 'P9999' }));
    expect((await api.sendOne(w.attendant.token, saleCmd(w, {}, 99))).status).toBe('FLAGGED');
    expect((await api.sendOne(w.manager.token, convertCmd(w))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.attendant.token, api.command('sale.void', { sale_id: (sale.payload as { sale_id: string }).sale_id, reason: 'MISTAKE', approval_id: voidApproval }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('settlement.close', { settlement_id: randomUUID(), field_location_id: van, cash_received: '0', lines: [{ pack_type_id: w.maize.piece, counted_quantity: 4 }] }))).status).toBe('ACCEPTED');
    expect(await notes(w.owner.businessId)).toEqual([]);
    // sale.flagged, stock.converted, approval.used, settlement.variance: one each.
    expect(await errorEvents()).toEqual(Array.from({ length: 4 }, () => ({ source: 'notifications', code: 'P9999' })));
  });

  // ---------------------------------------------------------------- 6. suspended owners and data keys
  it('6. a suspended owner is not notified; every notification\'s data holds exactly its allowed keys', async () => {
    const w = await api.world();
    await receive(w, 1, 2);
    expect((await api.sendOne(w.manager.token, convertCmd(w))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.attendant.token, saleCmd(w, {}, 99))).status).toBe('FLAGGED');
    const id = await approval(w.attendant, w.manager, 'STOCK_CONVERT');
    expect((await api.sendOne(w.attendant.token, convertCmd(w, { approval_id: id }))).status).toBe('ACCEPTED');
    const all = await notes(w.owner.businessId);
    expect(new Set(all.map((n) => n.type))).toEqual(new Set(['stock.converted', 'sale.flagged', 'approval.used']));
    for (const n of all) expect(Object.keys(n.data).sort(), n.type).toEqual([...DATA_KEYS[n.type as NotificationType]].sort());
    // Suspended (as the superuser: the API never suspends an owner): no more notifications for them.
    await asAdmin((c) => c.query("UPDATE membership SET status = 'SUSPENDED' WHERE id = $1", [w.owner.membershipId]));
    expect((await api.sendOne(w.attendant.token, saleCmd(w, {}, 99))).status).toBe('FLAGGED');
    expect(await notes(w.owner.businessId)).toHaveLength(all.length);
  });
});
