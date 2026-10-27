import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SignedCursor } from '../src/common/paging/signed-cursor.js';
import { SYNC_TABLE_NAMES } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase T2: the location scope (docs/phase-t-design.md sections 4 and 7).
// Test numbers follow the T2 list in section 11.

type Row = { id: string } & Record<string, unknown>;
interface Change {
  table: string;
  op: 'upsert' | 'delete';
  id: string;
  row?: Row;
}
interface SnapshotPage {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}
type Copy = Record<string, Map<string, Row>>;

describe('T2: location scope', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.191', 99_100_000);
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
    f2: Member;
    van1: string;
    van2: string;
  }
  const errorOf = (res: LightMyRequestResponse) => {
    const e = (res.json() as { error?: { code: string; message: string } }).error;
    return { status: res.statusCode, code: e?.code, message: e?.message };
  };
  async function fieldLocation(w: World, member: Member, name: string): Promise<string> {
    const res = await api.post('/v1/locations', { name, kind: 'FIELD', assigned_membership_id: member.membershipId }, w.owner.token);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ id: string }>(res).id;
  }
  const receive = (w: World, loc: string, lines: { pack: string; qty: number }[]) =>
    api.sendOne(w.manager.token, api.command('stock.receive', { location_id: loc, lines: lines.map((l) => ({ pack_type_id: l.pack, quantity: l.qty })) }));
  /** A business with two field attendants, each with a stocked van, and stock at the main shop. */
  async function fieldWorld(name = 'Duka A'): Promise<FieldWorld> {
    const w = await api.world(name);
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const f2 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Wafula');
    const van1 = await fieldLocation(w, f1, 'Van 1');
    const van2 = await fieldLocation(w, f2, 'Van 2');
    for (const loc of [w.loc, van1, van2]) expect((await receive(w, loc, [{ pack: w.maize.piece, qty: 20 }, { pack: w.maize.carton, qty: 2 }])).status).toBe('ACCEPTED');
    return { ...w, f1, f2, van1, van2 };
  }
  const sale = (loc: string, extra: object = {}) =>
    api.command('sale.create', { sale_id: randomUUID(), local_ref: 'F', location_id: loc, lines: [{ pack_type_id: '', quantity: 1, unit_price: '180' }], ...extra });
  const sell = (w: World, loc: string, payments: object[] = []) => {
    const cmd = sale(loc, { lines: [{ pack_type_id: w.maize.piece, quantity: 1, unit_price: '180' }], payments });
    return { cmd, saleId: (cmd.payload as { sale_id: string }).sale_id };
  };
  const mint = async (caller: Member, approver: Member, purpose: string) => {
    const res = await api.post('/v1/stock/approvals', { approver_membership_id: approver.membershipId, approver_pin: STAFF_PIN, purpose }, caller.token);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ approval_id: string }>(res).approval_id;
  };
  const consumed = async (id: string) => (await asAdmin((c) => c.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM approval WHERE id = $1', [id]))).rows[0].consumed_at;
  async function snapshot(token: string): Promise<{ start: string; copy: Copy }> {
    const copy: Copy = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, new Map<string, Row>()]));
    let res = await api.call('GET', '/v1/sync/snapshot?limit=500', token);
    const start = (res.json() as SnapshotPage).start_cursor!;
    for (;;) {
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json() as SnapshotPage;
      for (const r of p.rows) copy[p.table].set(r.id, r);
      if (p.next_cursor) res = await api.call('GET', `/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=500`, token);
      else if (p.next_table) res = await api.call('GET', `/v1/sync/snapshot?table=${p.next_table}&limit=500`, token);
      else return { start, copy };
    }
  }
  async function drain(token: string, cursor: string): Promise<{ all: Change[]; cursor: string }> {
    const all: Change[] = [];
    for (;;) {
      const res = await api.call('GET', `/v1/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=500`, token);
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json() as { changes: Change[]; next_cursor: string; has_more: boolean };
      all.push(...p.changes);
      cursor = p.next_cursor;
      if (!p.has_more) return { all, cursor };
    }
  }

  // ---------------------------------------------------------------- 1. sales
  it('1. a field attendant sells only from their own location; every other location is the same LOCATION_NOT_FOUND as a missing one', async () => {
    const w = await fieldWorld();
    const b = await api.world('Duka B');
    expect((await api.sendOne(w.f1.token, sell(w, w.van1).cmd)).status).toBe('ACCEPTED');
    const answers = [];
    for (const loc of [randomUUID(), w.loc, w.van2, b.loc]) answers.push(await api.sendOne(w.f1.token, sell(w, loc).cmd));
    for (const a of answers) expect({ ...a, command_id: null }).toEqual({ command_id: null, status: 'REJECTED', reason: 'LOCATION_NOT_FOUND', message: answers[0].message });
    // A field attendant with no location cannot sell anywhere.
    const f3 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Kamau');
    for (const loc of [w.loc, w.van1]) expect(await api.sendOne(f3.token, sell(w, loc).cmd)).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_NOT_FOUND' });
    // Everyone else is unrestricted: an attendant and the manager sell at a van.
    expect((await api.sendOne(w.attendant.token, sell(w, w.van2).cmd)).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, sell(w, w.van1).cmd)).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 2. offline sales into archived or reassigned locations
  it('2. a sale into the attendant\'s location after it was archived or reassigned is still accepted for them', async () => {
    const w = await fieldWorld();
    expect((await api.call('PATCH', `/v1/locations/${w.van1}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect((await api.sendOne(w.f1.token, sell(w, w.van1).cmd)).status).toBe('ACCEPTED');
    // The van goes to a new attendant (a new location for them); F1's offline sale into the old one still counts.
    const f3 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Kamau');
    const van3 = await fieldLocation(w, f3, 'Van 1 (Kamau)');
    expect((await api.sendOne(w.f1.token, sell(w, w.van1).cmd)).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.f1.token, sell(w, van3).cmd)).toMatchObject({ reason: 'LOCATION_NOT_FOUND' });
    expect((await api.sendOne(f3.token, sell(w, van3).cmd)).status).toBe('FLAGGED'); // saved; the new van has no stock yet (STOCK_NEGATIVE)
    expect(await api.sendOne(f3.token, sell(w, w.van1).cmd)).toMatchObject({ reason: 'LOCATION_NOT_FOUND' });
  });

  // ---------------------------------------------------------------- 3. attach, void, convert
  it('3. payment.attach, sale.void and stock.convert outside the scope are refused as not found, and no approval is used', async () => {
    const w = await fieldWorld();
    // An attendant sells at the main shop, then becomes a field attendant with a van: that sale is now outside their scope.
    const own = sell(w, w.loc);
    expect((await api.sendOne(w.attendant.token, own.cmd)).status).toBe('ACCEPTED');
    expect((await api.call('PATCH', `/v1/staff/${w.attendant.membershipId}`, w.owner.token, { role_preset: 'FIELD_ATTENDANT' })).statusCode).toBe(204);
    const van = await fieldLocation(w, w.attendant, 'Van A');
    await receive(w, van, [{ pack: w.maize.carton, qty: 2 }]);
    const attach = api.command('payment.attach', { sale_id: own.saleId, payments: [{ method: 'CASH', amount: '1' }] });
    expect(await api.sendOne(w.attendant.token, attach)).toMatchObject({ status: 'REJECTED', reason: 'SALE_NOT_FOUND' });
    const voidApproval = await mint(w.attendant, w.manager, 'SALE_VOID');
    expect(await api.sendOne(w.attendant.token, api.command('sale.void', { sale_id: own.saleId, reason: 'MISTAKE', approval_id: voidApproval }))).toMatchObject({ status: 'REJECTED', reason: 'SALE_NOT_FOUND' });
    expect(await consumed(voidApproval)).toBeNull();
    const convertApproval = await mint(w.attendant, w.manager, 'STOCK_CONVERT');
    const convert = (loc: string) => api.command('stock.convert', { location_id: loc, from_pack_type_id: w.maize.carton, to_pack_type_id: w.maize.piece, quantity: 1, approval_id: convertApproval });
    expect(await api.sendOne(w.attendant.token, convert(w.loc))).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_NOT_FOUND' });
    expect(await consumed(convertApproval)).toBeNull();
    // In scope, the same approvals work.
    expect((await api.sendOne(w.attendant.token, convert(van))).status).toBe('ACCEPTED');
    const inScope = sell(w, van);
    expect((await api.sendOne(w.attendant.token, inScope.cmd)).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.attendant.token, api.command('payment.attach', { sale_id: inScope.saleId, payments: [{ method: 'CASH', amount: '1' }] }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.attendant.token, api.command('sale.void', { sale_id: inScope.saleId, reason: 'MISTAKE', approval_id: voidApproval }))).status).toBe('ACCEPTED');
    // The out-of-scope sale is untouched.
    const row = (await asAdmin((c) => c.query<{ status: string; paid_total: string }>('SELECT status, paid_total::text FROM sale WHERE id = $1', [own.saleId]))).rows[0];
    expect(row).toEqual({ status: 'COMPLETED', paid_total: '0.00' });
  });

  // ---------------------------------------------------------------- 4. reads
  it('4. stock, movements and locations show a field attendant only their own locations; managers still see all', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.f1.token, sell(w, w.van1).cmd)).status).toBe('ACCEPTED');
    const get = <T>(url: string, token: string) => api.call('GET', url, token).then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as T;
    });
    type Balances = { balances: { location_id: string }[]; next_cursor: string | null };
    type Movements = { movements: { location_id: string }[]; next_cursor: string | null };
    expect(new Set((await get<Balances>('/v1/stock', w.f1.token)).balances.map((b) => b.location_id))).toEqual(new Set([w.van1]));
    expect(new Set((await get<Movements>('/v1/stock/movements', w.f1.token)).movements.map((m) => m.location_id))).toEqual(new Set([w.van1]));
    // A location_id filter outside the scope: the same empty list as an unknown id.
    for (const loc of [w.loc, w.van2, randomUUID()]) {
      expect(await get<Balances>(`/v1/stock?location_id=${loc}`, w.f1.token), loc).toEqual({ balances: [], next_cursor: null });
      expect(await get<Movements>(`/v1/stock/movements?location_id=${loc}`, w.f1.token), loc).toEqual({ movements: [], next_cursor: null });
    }
    expect(new Set((await get<Balances>(`/v1/stock?location_id=${w.van1}`, w.f1.token)).balances.map((b) => b.location_id))).toEqual(new Set([w.van1]));
    // Managers see every location.
    expect(new Set((await get<Balances>('/v1/stock', w.manager.token)).balances.map((b) => b.location_id))).toEqual(new Set([w.loc, w.van1, w.van2]));
    // Locations: only their own, archived ones only on request.
    type Locations = { locations: { id: string }[] };
    expect((await get<Locations>('/v1/locations', w.f1.token)).locations.map((l) => l.id)).toEqual([w.van1]);
    expect((await api.call('PATCH', `/v1/locations/${w.van1}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect((await get<Locations>('/v1/locations', w.f1.token)).locations).toEqual([]);
    expect((await get<Locations>('/v1/locations?include_archived=true', w.f1.token)).locations.map((l) => l.id)).toEqual([w.van1]);
    expect((await get<Locations>('/v1/locations', w.manager.token)).locations.map((l) => l.id).sort()).toEqual([w.loc, w.van2].sort());
  });

  // ---------------------------------------------------------------- 5. snapshot and changes
  it('5. snapshot and changes carry only the attendant\'s own location and balances; other rows are skipped, never delete markers', async () => {
    const w = await fieldWorld();
    const snap = await snapshot(w.f1.token);
    expect([...snap.copy.location.keys()]).toEqual([w.van1]);
    expect(new Set([...snap.copy.stock_balance.values()].map((b) => b.location_id))).toEqual(new Set([w.van1]));
    expect(snap.copy.product.size).toBe(1);
    expect(snap.copy.pack_type.size).toBe(2);
    // Activity everywhere: stock at the shop and both vans, renames of all three, sales at both vans.
    await receive(w, w.loc, [{ pack: w.maize.piece, qty: 5 }]);
    await receive(w, w.van2, [{ pack: w.maize.piece, qty: 5 }]);
    await receive(w, w.van1, [{ pack: w.maize.carton, qty: 1 }]);
    for (const [loc, name] of [[w.loc, 'Main shop 2'], [w.van2, 'Van 2b'], [w.van1, 'Van 1b']]) {
      expect((await api.call('PATCH', `/v1/locations/${loc}`, w.owner.token, { name })).statusCode).toBe(200);
    }
    expect((await api.sendOne(w.f2.token, sell(w, w.van2).cmd)).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.f1.token, sell(w, w.van1).cmd)).status).toBe('ACCEPTED');
    const d = await drain(w.f1.token, snap.start);
    expect(d.all.filter((c) => c.op === 'delete')).toEqual([]);
    expect(d.all.filter((c) => c.table === 'location').map((c) => [c.id, c.row!.name])).toEqual([[w.van1, 'Van 1b']]);
    expect(new Set(d.all.filter((c) => c.table === 'stock_balance').map((c) => c.row!.location_id))).toEqual(new Set([w.van1]));
    expect(JSON.stringify(d.all)).not.toContain(w.loc);
    expect(JSON.stringify(d.all)).not.toContain(w.van2);
    // The cursor moved past the hidden rows.
    expect((await drain(w.f1.token, d.cursor)).all).toEqual([]);
    // The manager receives everything.
    const m = await snapshot(w.manager.token);
    expect(new Set(m.copy.location.keys())).toEqual(new Set([w.loc, w.van1, w.van2]));
  });

  // ---------------------------------------------------------------- 6. the cursor
  it('6. a change in scope gives 410 SNAPSHOT_REQUIRED; an old cursor without scope is 422', async () => {
    const w = await fieldWorld();
    const required = { status: 410, code: 'SNAPSHOT_REQUIRED', message: expect.any(String) };
    const changes = (token: string, cursor: string) => api.call('GET', `/v1/sync/changes?cursor=${encodeURIComponent(cursor)}`, token);
    // Unchanged scope: fine.
    const f1Start = (await snapshot(w.f1.token)).start;
    expect((await changes(w.f1.token, f1Start)).statusCode).toBe(200);
    const mgrStart = (await snapshot(w.manager.token)).start;
    // A new field location for F1 (the old one archived): F1's cursor is refused, the manager's is not.
    expect((await api.call('PATCH', `/v1/locations/${w.van1}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect((await changes(w.f1.token, f1Start)).statusCode).toBe(200); // archiving keeps it in scope
    await fieldLocation(w, w.f1, 'Van 1 new');
    expect(errorOf(await changes(w.f1.token, f1Start))).toEqual(required);
    expect((await changes(w.manager.token, mgrStart)).statusCode).toBe(200);
    // A preset change from FIELD_ATTENDANT, and to it.
    const f2Start = (await snapshot(w.f2.token)).start;
    expect((await api.call('PATCH', `/v1/staff/${w.f2.membershipId}`, w.owner.token, { role_preset: 'ATTENDANT' })).statusCode).toBe(204);
    expect(errorOf(await changes(w.f2.token, f2Start))).toEqual(required);
    const attStart = (await snapshot(w.attendant.token)).start;
    expect((await api.call('PATCH', `/v1/staff/${w.attendant.membershipId}`, w.owner.token, { role_preset: 'FIELD_ATTENDANT' })).statusCode).toBe(204);
    expect(errorOf(await changes(w.attendant.token, attStart))).toEqual(required);
    // A cursor issued before T2 (no scope) is refused like a tampered one.
    const legacy = t.app.get(SignedCursor, { strict: false }).sign('sync-changes', { business_id: w.owner.businessId, txid: '0', id: '0', costs: false, all_sales: true });
    expect(errorOf(await changes(w.manager.token, legacy))).toEqual({ status: 422, code: 'VALIDATION_FAILED', message: 'The cursor is not valid.' });
  });

  // ---------------------------------------------------------------- 7. suspended member, revoked device
  it('7. a suspended field attendant and a revoked device are refused as before', async () => {
    const w = await fieldWorld();
    expect((await api.post(`/v1/staff/${w.f1.membershipId}/suspend`, undefined, w.owner.token)).statusCode).toBe(204);
    expect((await api.post('/v1/sync/commands', { commands: [sell(w, w.van1).cmd] }, w.f1.token)).statusCode).toBe(403);
    expect((await api.call('GET', '/v1/stock', w.f1.token)).statusCode).toBe(403);
    const revoke = await t.app.inject({ method: 'DELETE', url: `/v1/devices/${w.f2.deviceId}`, headers: { authorization: `Bearer ${w.owner.token}` }, remoteAddress: '198.51.100.191' });
    expect(revoke.statusCode).toBe(204);
    expect(errorOf(await api.call('GET', '/v1/sync/snapshot', w.f2.token))).toMatchObject({ status: 403, code: 'DEVICE_REVOKED' });
  });

  // ---------------------------------------------------------------- 8. tenant isolation
  it('8. another business\'s locations, balances and attendants never appear', async () => {
    const a = await fieldWorld('Duka A');
    const b = await fieldWorld('Duka B');
    const aSnap = await snapshot(a.f1.token);
    const text = JSON.stringify([...aSnap.copy.location.values(), ...aSnap.copy.stock_balance.values()]);
    for (const id of [b.loc, b.van1, b.van2, b.f1.membershipId]) expect(text).not.toContain(id);
    expect(JSON.stringify(api.json(await api.call('GET', '/v1/stock', a.manager.token)))).not.toContain(b.van1);
    expect(await api.sendOne(a.f1.token, sell(a, b.van1).cmd)).toMatchObject({ reason: 'LOCATION_NOT_FOUND' });
    // B's field attendant, same ids pattern, sees only B's van.
    expect([...(await snapshot(b.f1.token)).copy.location.keys()]).toEqual([b.van1]);
  });
});
