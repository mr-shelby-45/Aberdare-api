import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ChangeFeedService } from '../src/modules/sync/change-feed.service.js';
import { SYNC_TABLE_NAMES } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, OWNER_PASSWORD, type Pack, type World, stockApi } from './helpers/stock-api.js';

// Phase D3: GET /v1/sync/changes (docs/phase-d-design.md section 6). Numbers
// in test names refer to the D3 list in section 11.

type Row = Record<string, unknown> & { id: string };
interface Change {
  table: string;
  op: 'upsert' | 'delete';
  id: string;
  row?: Row;
  key?: { barcode: string | null };
}
interface ChangesPage {
  changes: Change[];
  next_cursor: string;
  has_more: boolean;
}
interface SnapshotPage {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}
type Copy = Record<string, Map<string, Row>>;

describe('D3: changes', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.150', 96_000_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------- the phone
  const get = (url: string, token: string) =>
    t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: '198.51.100.150' });
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });
  async function snapshot(token: string): Promise<{ start: string; copy: Copy }> {
    const copy: Copy = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, new Map<string, Row>()]));
    let res = await get('/v1/sync/snapshot?limit=500', token);
    expect(res.statusCode, res.body).toBe(200);
    let p = res.json() as SnapshotPage;
    const start = p.start_cursor!;
    for (;;) {
      for (const r of p.rows) copy[p.table].set(r.id, r);
      if (p.next_cursor) res = await get(`/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=500`, token);
      else if (p.next_table) res = await get(`/v1/sync/snapshot?table=${p.next_table}&limit=500`, token);
      else break;
      expect(res.statusCode, res.body).toBe(200);
      p = res.json() as SnapshotPage;
    }
    return { start, copy };
  }
  async function changes(token: string, cursor: string, limit = 200): Promise<ChangesPage> {
    const res = await get(`/v1/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as ChangesPage;
  }
  /** Every page until has_more is false; the cursor the phone ends with. */
  async function drain(token: string, cursor: string, limit = 200): Promise<{ all: Change[]; pages: ChangesPage[]; cursor: string }> {
    const pages: ChangesPage[] = [];
    for (;;) {
      const p = await changes(token, cursor, limit);
      pages.push(p);
      cursor = p.next_cursor;
      if (!p.has_more) break;
    }
    return { all: pages.flatMap((p) => p.changes), pages, cursor };
  }
  const apply = (copy: Copy, list: Change[]) => {
    for (const c of list) {
      if (c.op === 'upsert') copy[c.table].set(c.id, c.row!);
      else copy[c.table].delete(c.id);
    }
  };
  const asPlain = (copy: Copy) => Object.fromEntries(Object.entries(copy).map(([n, m]) => [n, [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1))]));

  // ---------------------------------------------------------------- seeding
  async function shop(name = 'Duka A'): Promise<World & { beans: Pack; barcode: string }> {
    const w = await api.world(name);
    const beans = await api.newProduct(w.owner, 'Beans 1kg');
    const barcode = '6161101560029';
    expect((await api.sendOne(w.owner.token, api.command('barcode.add', { barcode, product_id: w.maize.productId, pack_type_id: w.maize.piece }))).status).toBe('ACCEPTED');
    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 30 }, { pack_type_id: w.maize.carton, quantity: 4 }] }));
    return { ...w, beans, barcode };
  }
  const cmd = async (token: string, type: string, payload: object) => {
    const r = await api.sendOne(token, api.command(type, payload));
    expect(r.status, `${type} ${JSON.stringify(r)}`).not.toBe('REJECTED');
    return r;
  };
  const rename = (m: Member, productId: string, name: string) => cmd(m.token, 'product.update', { product_id: productId, name });

  // ---------------------------------------------------------------- 1. every kind of change
  it('1. after the snapshot, each kind of change appears once with its current state, and the copy equals a fresh snapshot', async () => {
    const w = await shop();
    const { start, copy } = await snapshot(w.attendant.token);
    const sugar = await api.newProduct(w.owner, 'Sugar 2kg'); // new product
    await rename(w.owner, w.maize.productId, 'Maize flour 2kg (new)'); // edit
    await cmd(w.owner.token, 'product.update', { product_id: w.beans.productId, archived: true }); // archive
    await cmd(w.owner.token, 'barcode.add', { barcode: '16161101560026', product_id: w.maize.productId, pack_type_id: w.maize.carton }); // barcode add
    await cmd(w.owner.token, 'barcode.remove', { barcode: w.barcode }); // barcode remove
    const store = await api.newLocation(w.owner, 'Back store'); // location change
    expect((await api.call('PATCH', `/v1/locations/${store}`, w.owner.token, { name: 'Back store 2' })).statusCode).toBe(200);
    await cmd(w.manager.token, 'stock.receive', { location_id: store, lines: [{ pack_type_id: sugar.piece, quantity: 9 }] }); // receive
    await cmd(w.manager.token, 'stock.adjust', { location_id: w.loc, pack_type_id: w.maize.piece, quantity_change: -2, reason: 'DAMAGED' }); // adjust
    await cmd(w.manager.token, 'stock.count', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, expected_quantity: 28, counted_quantity: 27 }] }); // count
    await cmd(w.manager.token, 'stock.convert', { location_id: w.loc, from_pack_type_id: w.maize.carton, to_pack_type_id: w.maize.piece, quantity: 1 }); // convert
    await api.sell(w, w.loc, w.maize.piece, 3); // sale-mode decrease

    const { all } = await drain(w.attendant.token, start);
    // Each record once.
    const keys = all.map((c) => `${c.table}:${c.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const find = (table: string, id: string) => all.find((c) => c.table === table && c.id === id);
    expect(find('product', sugar.productId)).toMatchObject({ op: 'upsert', row: { name: 'Sugar 2kg', archived_at: null } });
    expect(find('pack_type', sugar.piece)).toMatchObject({ op: 'upsert' });
    expect(find('product', w.maize.productId)).toMatchObject({ op: 'upsert', row: { name: 'Maize flour 2kg (new)' } });
    expect(find('product', w.beans.productId)?.row?.archived_at).toEqual(expect.any(String));
    const removed = all.filter((c) => c.table === 'product_barcode' && c.op === 'delete');
    expect(removed).toEqual([{ table: 'product_barcode', op: 'delete', id: expect.any(String), key: { barcode: w.barcode } }]);
    expect(all.filter((c) => c.table === 'product_barcode' && c.op === 'upsert').map((c) => c.row!.barcode)).toEqual(['16161101560026']);
    expect(find('location', store)).toMatchObject({ op: 'upsert', row: { name: 'Back store 2' } });
    const piece = all.find((c) => c.table === 'stock_balance' && c.row?.pack_type_id === w.maize.piece && c.row?.location_id === w.loc);
    expect(piece?.row?.quantity).toBe(30 - 2 - 1 + 24 - 3); // 48: adjust, count, convert, sale, as it is now
    expect(all.filter((c) => c.table === 'stock_balance').length).toBe(3); // piece, carton, sugar at the store

    // The rebuilt copy equals a fresh snapshot, row for row.
    apply(copy, all);
    expect(asPlain(copy)).toEqual(asPlain((await snapshot(w.attendant.token)).copy));
  });

  // ---------------------------------------------------------------- 2. collapse and order
  it('2. several changes to one record collapse into one with the latest state, placed where the record first appears', async () => {
    const w = await shop();
    const { start } = await snapshot(w.attendant.token);
    const sugar = await api.newProduct(w.owner, 'Sugar 2kg'); // product and its pack types in one transaction
    for (const name of ['Sugar A', 'Sugar B', 'Sugar C']) await rename(w.owner, sugar.productId, name);
    const p = await changes(w.attendant.token, start);
    const forSugar = p.changes.filter((c) => c.id === sugar.productId);
    expect(forSugar).toEqual([{ table: 'product', op: 'upsert', id: sugar.productId, row: expect.objectContaining({ name: 'Sugar C' }) }]);
    // The parent comes before its pack types, although it changed again later.
    const at = (id: string) => p.changes.findIndex((c) => c.id === id);
    expect(at(sugar.productId)).toBeLessThan(at(sugar.piece));
    expect(at(sugar.productId)).toBeLessThan(at(sugar.carton));
  });

  // ---------------------------------------------------------------- 3. pages
  it('3. limit is respected, has_more is right, paging to the end delivers everything once, and an empty page still has a cursor', async () => {
    const w = await shop();
    const { start } = await snapshot(w.attendant.token);
    for (let i = 0; i < 6; i++) await api.newProduct(w.owner, `Item ${i}`); // 6 products, 12 pack types: 18 log rows
    const whole = await drain(w.attendant.token, start, 500);
    expect(whole.pages).toHaveLength(1);
    expect(whole.all).toHaveLength(18);
    const paged = await drain(w.attendant.token, start, 4);
    expect(paged.pages.map((p) => p.has_more)).toEqual([true, true, true, true, false]);
    expect(paged.pages.every((p) => p.changes.length <= 4)).toBe(true);
    expect(paged.all.map((c) => `${c.table}:${c.id}`)).toEqual(whole.all.map((c) => `${c.table}:${c.id}`));
    // At the end: an empty page with a valid cursor, also when called again.
    const empty = await changes(w.attendant.token, paged.cursor);
    expect(empty).toEqual({ changes: [], next_cursor: expect.any(String), has_more: false });
    expect((await changes(w.attendant.token, empty.next_cursor)).changes).toEqual([]);
    // The same cursor twice gives the same answer (phones may retry).
    expect(await changes(w.attendant.token, start, 4)).toEqual(paged.pages[0]);
    // limit 0 and a missing cursor are refused.
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(start)}&limit=0`, w.attendant.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await get('/v1/sync/changes', w.attendant.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  // ---------------------------------------------------------------- 4. costs
  it('4. an attendant never gets cost_price; a manager who gains costs.view gets 410 and recovers by a snapshot; the same the other way', async () => {
    const w = await shop();
    const att = await snapshot(w.attendant.token);
    const mgr = await snapshot(w.manager.token);
    await cmd(w.owner.token, 'pack_type.upsert', { pack_type_id: w.maize.piece, product_id: w.maize.productId, name: 'piece', units_per_pack: 1, sell_price: '190', cost_price: '150' });
    await cmd(w.owner.token, 'barcode.remove', { barcode: w.barcode });
    const seen = (await drain(w.attendant.token, att.start)).all;
    expect(seen.find((c) => c.id === w.maize.piece)?.row).not.toHaveProperty('cost_price');
    expect(seen.find((c) => c.id === w.maize.piece)?.row?.sell_price).toBe('190.00');
    for (const c of seen.filter((x) => x.op === 'delete')) expect(Object.keys(c).sort()).toEqual(['id', 'key', 'op', 'table']);
    expect(JSON.stringify(seen)).not.toContain('"150.00"'); // the cost value, quoted (a random id can contain 150)

    // The manager gains costs.view: the old cursor needs a new snapshot.
    expect((await api.call('PATCH', `/v1/staff/${w.manager.membershipId}`, w.owner.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(mgr.start)}`, w.manager.token))).toEqual({ status: 410, code: 'SNAPSHOT_REQUIRED' });
    const fresh = await snapshot(w.manager.token);
    expect(fresh.copy.pack_type.get(w.maize.piece)?.cost_price).toBe('150.00');
    expect((await changes(w.manager.token, fresh.start)).changes).toEqual([]);
    // And loses it again.
    expect((await api.call('PATCH', `/v1/staff/${w.manager.membershipId}`, w.owner.token, { extra_permissions: [] })).statusCode).toBe(204);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(fresh.start)}`, w.manager.token))).toEqual({ status: 410, code: 'SNAPSHOT_REQUIRED' });
    // The attendant's cursor is unaffected.
    expect((await changes(w.attendant.token, att.start)).changes.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- 5. retention
  it('5. a cursor older than the retained history is 410 SNAPSHOT_REQUIRED', async () => {
    const w = await shop();
    const { start } = await snapshot(w.attendant.token);
    await api.newProduct(w.owner, 'Sugar 2kg');
    await asAdmin((c) => c.query("UPDATE change_log SET changed_at = changed_at - interval '400 days' WHERE business_id = $1", [w.owner.businessId]));
    expect(Number(await t.app.get(ChangeFeedService, { strict: false }).prune())).toBeGreaterThan(0);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(start)}`, w.attendant.token))).toEqual({ status: 410, code: 'SNAPSHOT_REQUIRED' });
    // A fresh snapshot gives a cursor that works again.
    expect((await changes(w.attendant.token, (await snapshot(w.attendant.token)).start)).changes).toEqual([]);
  });

  // ---------------------------------------------------------------- 6. deleted since
  it('6. a record deleted before the request is returned as a delete, even though it was also added in the same window', async () => {
    const w = await shop();
    const { start, copy } = await snapshot(w.attendant.token);
    await cmd(w.owner.token, 'barcode.add', { barcode: '99887766', product_id: w.maize.productId, pack_type_id: w.maize.carton });
    const added = await asAdmin(async (c) => (await c.query<{ id: string }>("SELECT id FROM product_barcode WHERE barcode = '99887766'")).rows[0].id);
    await cmd(w.owner.token, 'barcode.remove', { barcode: '99887766' });
    const { all } = await drain(w.attendant.token, start);
    expect(all.filter((c) => c.id === added)).toEqual([{ table: 'product_barcode', op: 'delete', id: added, key: { barcode: '99887766' } }]);
    apply(copy, all);
    expect(asPlain(copy)).toEqual(asPlain((await snapshot(w.attendant.token)).copy));
  });

  // ---------------------------------------------------------------- 7. isolation
  it("7. another business's changes never appear and never move a cursor", async () => {
    const a = await shop('Duka A');
    const b = await shop('Duka B');
    const sa = await snapshot(a.attendant.token);
    const end = (await drain(a.attendant.token, sa.start)).cursor;
    for (let i = 0; i < 3; i++) await api.newProduct(b.owner, `B item ${i}`);
    await cmd(b.manager.token, 'stock.receive', { location_id: b.loc, lines: [{ pack_type_id: b.maize.piece, quantity: 5 }] });
    const after = await changes(a.attendant.token, end);
    expect(after).toEqual({ changes: [], next_cursor: end, has_more: false });
    const bIds = new Set((await drain(b.attendant.token, (await snapshot(b.attendant.token)).start)).all.map((c) => c.id));
    expect((await drain(a.attendant.token, sa.start)).all.some((c) => bIds.has(c.id))).toBe(false);
    // B's cursor is refused by A (the same 422 as a tampered one).
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(end)}`, b.attendant.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  // ---------------------------------------------------------------- 8. out-of-order commits (run 5 times)
  it('8. a phone polling while transactions commit out of order ends with every change, none skipped', async () => {
    const w = await shop();
    const { start, copy } = await snapshot(w.attendant.token);
    let cursor = start;
    const poll = async () => {
      const d = await drain(w.attendant.token, cursor);
      apply(copy, d.all);
      cursor = d.cursor;
      return d.all;
    };
    // T1 renames the location first (lower change_log id) and stays open.
    const t1 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await t1.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("SELECT set_config('app.business_id', $1, true)", [w.owner.businessId]);
      await t1.query("UPDATE location SET name = 'Renamed by T1' WHERE id = $1", [w.loc]);
      // T2 commits later changes while T1 is open, and the phone polls.
      await rename(w.owner, w.maize.productId, 'Renamed by T2');
      const whileOpen = await poll();
      expect(whileOpen.map((c) => c.id)).not.toContain(w.loc);
      await rename(w.owner, w.beans.productId, 'Renamed by T3');
      await poll();
      await t1.query('COMMIT');
    } finally {
      await t1.end();
    }
    await poll();
    expect(copy.location.get(w.loc)?.name).toBe('Renamed by T1');
    expect(copy.product.get(w.maize.productId)?.name).toBe('Renamed by T2');
    expect(copy.product.get(w.beans.productId)?.name).toBe('Renamed by T3');
    expect(asPlain(copy)).toEqual(asPlain((await snapshot(w.attendant.token)).copy));
  });

  // ---------------------------------------------------------------- 9. devices
  it('9. a revoked device is refused with its valid cursor; another active device of the same member uses the same cursor', async () => {
    const w = await shop();
    const first = await snapshot(w.owner.token);
    await api.newProduct(w.owner, 'Sugar 2kg');
    // The owner logs in on a second phone.
    const login = await api.post('/v1/auth/login', { email: w.owner.email, password: OWNER_PASSWORD, device: { name: 'Second phone', platform: 'android' } });
    expect(login.statusCode, login.body).toBe(200);
    const second = api.json<{ access_token: string }>(login).access_token;
    const firstDevice = await asAdmin(
      async (c) => (await c.query<{ id: string }>("SELECT id FROM device WHERE registered_by_membership_id = $1 AND name = $2", [w.owner.membershipId, "Owner's phone"])).rows[0].id,
    );
    const revoke = await t.app.inject({ method: 'DELETE', url: `/v1/devices/${firstDevice}`, headers: { authorization: `Bearer ${second}` }, remoteAddress: '198.51.100.150' });
    expect(revoke.statusCode).toBe(204);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(first.start)}`, w.owner.token))).toEqual({ status: 403, code: 'DEVICE_REVOKED' });
    const viaSecond = await changes(second, first.start);
    expect(viaSecond.changes.some((c) => c.table === 'product' && c.row?.name === 'Sugar 2kg')).toBe(true);
    // A suspended member is refused too.
    // (Through the second phone: the owner's first device is revoked.)
    expect((await api.post(`/v1/staff/${w.attendant.membershipId}/suspend`, undefined, second)).statusCode).toBe(204);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(first.start)}`, w.attendant.token))).toEqual({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
    expect(randomUUID()).not.toBe(firstDevice);
  });
});
