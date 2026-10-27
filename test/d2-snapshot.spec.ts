import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TenantRunner } from '../src/database/tenant.js';
import { ChangeFeedService } from '../src/modules/sync/change-feed.service.js';
import { SnapshotService } from '../src/modules/sync/snapshot.service.js';
import { SYNC_TABLE_NAMES, SyncTables } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type Pack, type World, stockApi } from './helpers/stock-api.js';

// Phase D2: GET /v1/sync/snapshot (docs/phase-d-design.md section 5). Numbers
// in test names refer to the D2 list in section 11.

type Row = Record<string, unknown> & { id: string };
/** Order-free comparison of rows of mixed values. */
const sorted = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
interface Page {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}

describe('D2: snapshot', { timeout: 180_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.140', 95_000_000);
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

  const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, remoteAddress: '198.51.100.140' });
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });
  async function page(token: string, query = ''): Promise<Page> {
    const res = await get(`/v1/sync/snapshot${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Page;
  }
  /** The whole download as a phone does it: start, then follow next_cursor and next_table. */
  async function download(token: string, limit = 2): Promise<{ start: string; pages: Page[]; byTable: Record<string, Row[]> }> {
    const pages: Page[] = [await page(token, `?limit=${limit}`)];
    for (;;) {
      const last = pages[pages.length - 1];
      if (last.next_cursor) pages.push(await page(token, `?table=${last.table}&cursor=${encodeURIComponent(last.next_cursor)}&limit=${limit}`));
      else if (last.next_table) pages.push(await page(token, `?table=${last.next_table}&limit=${limit}`));
      else break;
    }
    const byTable: Record<string, Row[]> = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, []]));
    for (const p of pages) byTable[p.table].push(...p.rows);
    return { start: pages[0].start_cursor!, pages, byTable };
  }

  /** A shop with two locations, two products (one archived), costs, barcodes and balances. */
  async function shop(name = 'Duka A'): Promise<World & { beans: Pack; store: string }> {
    const w = await api.world(name);
    const beans = await api.newProduct(w.owner, 'Beans 1kg');
    const store = await api.newLocation(w.owner, 'Back store');
    const cost = api.command('pack_type.upsert', { pack_type_id: w.maize.piece, product_id: w.maize.productId, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150.5' });
    expect((await api.sendOne(w.owner.token, cost)).status).toBe('ACCEPTED');
    for (const [code, pack] of [['6161101560029', w.maize.piece], ['16161101560026', w.maize.carton]]) {
      expect((await api.sendOne(w.owner.token, api.command('barcode.add', { barcode: code, product_id: w.maize.productId, pack_type_id: pack }))).status).toBe('ACCEPTED');
    }
    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 7 }, { pack_type_id: w.maize.carton, quantity: 2 }] }));
    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: store, lines: [{ pack_type_id: beans.piece, quantity: 3 }] }));
    await api.sendOne(w.manager.token, api.command('stock.adjust', { location_id: store, pack_type_id: beans.piece, quantity_change: -3, reason: 'LOST' })); // a zero balance
    expect((await api.sendOne(w.owner.token, api.command('product.update', { product_id: beans.productId, archived: true }))).status).toBe('ACCEPTED');
    return { ...w, beans, store };
  }
  const counts = (businessId: string) =>
    asAdmin(async (c) => {
      const n = async (table: string) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE business_id = $1`, [businessId])).rows[0].n);
      return { location: await n('location'), product: await n('product'), pack_type: await n('pack_type'), product_barcode: await n('product_barcode'), stock_balance: await n('stock_balance'), sale: await n('sale'), sale_item: await n('sale_item'), payment: await n('payment') };
    });

  // ---------------------------------------------------------------- 1. the whole download
  it('1. a new member downloads every row exactly once, in table order, with the shapes of the Phase B and C reads', async () => {
    const w = await shop();
    const fresh = await api.activeStaff(w.owner, 'ATTENDANT', 'Dalmas');
    const d = await download(fresh.token, 2);

    // Table order, and every table finished before the next starts.
    const order = d.pages.map((p) => p.table).filter((n, i, all) => all.indexOf(n) === i);
    expect(order).toEqual([...SYNC_TABLE_NAMES]);
    expect(d.pages.every((p) => p.rows.length <= 2)).toBe(true);
    // Every row exactly once, and all of them.
    const expected = await counts(w.owner.businessId);
    for (const name of SYNC_TABLE_NAMES) {
      const ids = d.byTable[name].map((r) => r.id);
      expect(new Set(ids).size, name).toBe(ids.length);
      expect(ids.length, name).toBe(expected[name]);
      expect([...ids].sort(), name).toEqual(ids); // keyset by id
    }
    expect(d.pages[d.pages.length - 1]).toMatchObject({ table: 'payment', next_cursor: null, next_table: null }); // the last table since E4

    // Shapes and values against the Phase B and C reads.
    const locations = api.json<{ locations: { id: string; name: string; is_default: boolean; archived: boolean }[] }>(await get('/v1/locations?include_archived=true', fresh.token)).locations;
    expect(sorted(d.byTable.location.map((l) => [l.id, l.name, l.is_default, l.archived_at !== null]))).toEqual(sorted(locations.map((l) => [l.id, l.name, l.is_default, l.archived])));
    expect(Object.keys(d.byTable.location[0]).sort()).toEqual(['archived_at', 'assigned_membership_id', 'id', 'is_default', 'kind', 'name']); // kind and assignee since T1
    for (const productId of [w.maize.productId, w.beans.productId]) {
      const read = api.json<{ id: string; name: string; sku: string | null; archived: boolean; pack_types: Row[]; barcodes: { barcode: string; pack_type_id: string }[] }>(
        await get(`/v1/products/${productId}`, fresh.token),
      );
      const p = d.byTable.product.find((r) => r.id === productId)!;
      expect({ name: p.name, sku: p.sku, archived: p.archived_at !== null }).toEqual({ name: read.name, sku: read.sku, archived: read.archived });
      for (const pt of read.pack_types) {
        const s = d.byTable.pack_type.find((r) => r.id === pt.id)!;
        expect({ name: s.name, units_per_pack: s.units_per_pack, sell_price: s.sell_price, archived: s.archived_at !== null, product_id: s.product_id }).toEqual({
          name: pt.name,
          units_per_pack: pt.units_per_pack,
          sell_price: pt.sell_price,
          archived: pt.archived,
          product_id: productId,
        });
      }
      expect(sorted(d.byTable.product_barcode.filter((b) => b.product_id === productId).map((b) => [b.barcode, b.pack_type_id]))).toEqual(
        sorted(read.barcodes.map((b) => [b.barcode, b.pack_type_id])),
      );
    }
    expect(Object.keys(d.byTable.product_barcode[0]).sort()).toEqual(['barcode', 'id', 'pack_type_id', 'product_id']);
    const balances = api.json<{ balances: { location_id: string; pack_type_id: string; quantity: number }[] }>(await get('/v1/stock?include_zero=true&include_archived=true&limit=100', fresh.token)).balances;
    expect(sorted(d.byTable.stock_balance.map((b) => [b.location_id, b.pack_type_id, b.quantity]))).toEqual(sorted(balances.map((b) => [b.location_id, b.pack_type_id, b.quantity])));
    expect(Object.keys(d.byTable.stock_balance[0]).sort()).toEqual(['id', 'location_id', 'pack_type_id', 'quantity', 'updated_at']);
  });

  // ---------------------------------------------------------------- 2. start_cursor
  it('2. start_cursor is on the first page only, and a change made during the download is delivered from it', async () => {
    const w = await shop();
    const feed = t.app.get(ChangeFeedService, { strict: false });
    const tenants = t.app.get(TenantRunner, { strict: false });
    const first = await page(w.attendant.token, '?limit=1');
    expect(first.start_cursor).toEqual(expect.any(String));
    // A product created during the download, after its table's first page.
    const late = await api.newProduct(w.owner, 'Sugar 2kg');
    const rest: Page[] = [];
    let last: Page = first;
    for (;;) {
      if (last.next_cursor) last = await page(w.attendant.token, `?table=${last.table}&cursor=${encodeURIComponent(last.next_cursor)}&limit=1`);
      else if (last.next_table) last = await page(w.attendant.token, `?table=${last.next_table}&limit=1`);
      else break;
      rest.push(last);
    }
    expect(rest.every((p) => p.start_cursor === undefined)).toBe(true);
    // The late product's rows come through the change feed from start_cursor, each record once.
    const changes = await tenants.run(w.owner.businessId, async () =>
      feed.finishedAfter(await feed.open(first.start_cursor!, w.owner.businessId, { costs: false, allSales: false }), 500),
    );
    const changed = new Set(changes.map((c) => `${c.tableName}:${c.rowId}`));
    for (const key of [`product:${late.productId}`, `pack_type:${late.piece}`, `pack_type:${late.carton}`]) expect(changed.has(key), key).toBe(true);
    // Nothing written before the download started is delivered again.
    expect(changes.every((c) => [late.productId, late.piece, late.carton].includes(c.rowId))).toBe(true);
  });

  it('2. a change committed while the first page is being read is not lost (start_cursor is taken before reading)', async () => {
    const w = await shop();
    const feed = t.app.get(ChangeFeedService, { strict: false });
    const tenants = t.app.get(TenantRunner, { strict: false });
    // T1 renames the default location and stays open until the first page has been read.
    const t1 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await t1.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("SELECT set_config('app.business_id', $1, true)", [w.owner.businessId]);
      await t1.query("UPDATE location SET name = 'Renamed during download' WHERE id = $1", [w.loc]);
      const locationTable = t.app.get(SyncTables, { strict: false }).get('location');
      const original = locationTable.page.bind(locationTable);
      vi.spyOn(locationTable, 'page').mockImplementationOnce(async (...args) => {
        const rows = await original(...args);
        await t1.query('COMMIT'); // between the read and anything after it
        return rows;
      });
      const first = await page(w.attendant.token, '?limit=500');
      expect(first.rows.find((r) => r.id === w.loc)?.name).toBe('Main shop'); // read before T1 committed
      const changes = await tenants.run(w.owner.businessId, async () =>
        feed.finishedAfter(await feed.open(first.start_cursor!, w.owner.businessId, { costs: false, allSales: false }), 500),
      );
      expect(changes.filter((c) => c.tableName === 'location' && c.rowId === w.loc && c.operation === 'UPDATE')).toHaveLength(1);
    } finally {
      await t1.end();
    }
  });

  // ---------------------------------------------------------------- 3. permissions
  it('3. cost_price only with costs.view; stock_balance empty without stock.view', async () => {
    const w = await shop();
    const costOf = (d: { byTable: Record<string, Row[]> }) => d.byTable.pack_type.find((r) => r.id === w.maize.piece)!;
    expect(costOf(await download(w.attendant.token, 500))).not.toHaveProperty('cost_price');
    expect(costOf(await download(w.manager.token, 500))).not.toHaveProperty('cost_price');
    const owner = await download(w.owner.token, 500);
    expect(costOf(owner).cost_price).toBe('150.50');
    expect(owner.byTable.pack_type.find((r) => r.id === w.maize.carton)!.cost_price).toBeNull();
    expect(owner.byTable.stock_balance.length).toBeGreaterThan(0);
    // No preset lacks stock.view, so this reader is built directly (the route passes the session's permissions).
    const snapshots = t.app.get(SnapshotService, { strict: false });
    const tenants = t.app.get(TenantRunner, { strict: false });
    const withoutStock = await tenants.run(w.owner.businessId, () =>
      snapshots.page({ table: 'stock_balance' }, { businessId: w.owner.businessId, membershipId: w.attendant.membershipId, deviceId: w.attendant.deviceId!, permissions: new Set(['sales.create']) }),
    );
    expect(withoutStock).toEqual({ table: 'stock_balance', rows: [], nextCursor: null, nextTable: 'sale' }); // sale follows since E4
  });

  // ---------------------------------------------------------------- 4. archived rows
  it('4. archived products, pack types and locations are included, with archived_at', async () => {
    const w = await shop();
    const archive = api.command('pack_type.upsert', { pack_type_id: w.maize.carton, product_id: w.maize.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4200.00', archived: true });
    expect((await api.sendOne(w.owner.token, archive)).status).toBe('ACCEPTED');
    expect((await api.call('PATCH', `/v1/locations/${w.store}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    const d = await download(w.attendant.token, 500);
    expect(d.byTable.product.find((r) => r.id === w.beans.productId)!.archived_at).toEqual(expect.any(String));
    expect(d.byTable.product.find((r) => r.id === w.maize.productId)!.archived_at).toBeNull();
    expect(d.byTable.pack_type.find((r) => r.id === w.maize.carton)!.archived_at).toEqual(expect.any(String));
    expect(d.byTable.location.find((r) => r.id === w.store)!.archived_at).toEqual(expect.any(String));
  });

  // ---------------------------------------------------------------- 5. isolation
  it("5. another business's rows never appear, identical names never mix; business_id as a parameter is 422, as a header ignored", async () => {
    const a = await shop('Duka A');
    const b = await shop('Duka B');
    const da = await download(a.attendant.token, 3);
    const db = await download(b.attendant.token, 3);
    const idsA = new Set(Object.values(da.byTable).flat().map((r) => r.id));
    const idsB = new Set(Object.values(db.byTable).flat().map((r) => r.id));
    expect([...idsA].some((id) => idsB.has(id))).toBe(false);
    expect(sorted(da.byTable.product.map((p) => p.name))).toEqual(sorted(["Beans 1kg", "Maize flour 2kg"]));
    expect(sorted(db.byTable.product.map((p) => p.name))).toEqual(sorted(["Beans 1kg", "Maize flour 2kg"]));
    expect(da.byTable.product.map((p) => p.id).sort()).toEqual([a.beans.productId, a.maize.productId].sort());
    expect(errorOf(await get(`/v1/sync/snapshot?business_id=${b.owner.businessId}`, a.attendant.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    const withHeader = (await get('/v1/sync/snapshot?limit=500', a.attendant.token, { business_id: b.owner.businessId, 'x-business-id': b.owner.businessId })).json() as Page;
    expect(withHeader.rows.map((r) => r.id).sort()).toEqual(da.byTable.location.map((r) => r.id).sort());
  });

  // ---------------------------------------------------------------- 6. page cursors
  it('6. a tampered page cursor, one for another table, another business or without table is 422', async () => {
    const a = await shop('Duka A');
    const b = await shop('Duka B');
    const first = await page(a.attendant.token, '?limit=1');
    const c = first.next_cursor!;
    expect(c).toEqual(expect.any(String));
    const tampered = `${c.slice(0, 5)}${c[5] === 'A' ? 'B' : 'A'}${c.slice(6)}`;
    for (const [query, token] of [
      [`?table=location&cursor=${encodeURIComponent(tampered)}`, a.attendant.token],
      [`?table=product&cursor=${encodeURIComponent(c)}`, a.attendant.token],
      [`?cursor=${encodeURIComponent(c)}`, a.attendant.token],
      [`?table=location&cursor=${encodeURIComponent(c)}`, b.attendant.token],
      [`?table=location&cursor=${encodeURIComponent(first.start_cursor!)}`, a.attendant.token],
      ['?table=sales', a.attendant.token],
      ['?limit=0', a.attendant.token],
    ]) {
      expect(errorOf(await get(`/v1/sync/snapshot${query}`, token)), query).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    }
    expect(errorOf(await get(`/v1/sync/snapshot?table=location&cursor=${encodeURIComponent(c)}`, a.attendant.token)).status).toBe(200);
  });

  // ---------------------------------------------------------------- 7. who may download
  it('7. a suspended member, a revoked device and a request without a token are refused; a device revoked between pages is refused on the next page', async () => {
    const w = await shop();
    expect(errorOf(await get('/v1/sync/snapshot'))).toEqual({ status: 401, code: expect.any(String) });
    const first = await page(w.manager.token, '?limit=1');
    // Revoked between two pages.
    const revoke = await t.app.inject({ method: 'DELETE', url: `/v1/devices/${w.manager.deviceId}`, headers: { authorization: `Bearer ${w.owner.token}` }, remoteAddress: '198.51.100.140' });
    expect(revoke.statusCode).toBe(204);
    expect(errorOf(await get(`/v1/sync/snapshot?table=location&cursor=${encodeURIComponent(first.next_cursor!)}&limit=1`, w.manager.token))).toEqual({ status: 403, code: 'DEVICE_REVOKED' });
    expect(errorOf(await get('/v1/sync/snapshot', w.manager.token))).toEqual({ status: 403, code: 'DEVICE_REVOKED' });
    // A suspended member (devices have no suspended status; decided in D1).
    expect((await api.post(`/v1/staff/${w.attendant.membershipId}/suspend`, undefined, w.owner.token)).statusCode).toBe(204);
    expect(errorOf(await get('/v1/sync/snapshot', w.attendant.token))).toEqual({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
  });

  // ---------------------------------------------------------------- 8. device stamp
  it('8. the first page stamps last_sync_at on the calling device and on no other device of the business', async () => {
    const w = await shop();
    const stamps = () =>
      asAdmin(async (c) =>
        Object.fromEntries((await c.query<{ id: string; at: Date | null }>('SELECT id, last_sync_at AS at FROM device WHERE business_id = $1', [w.owner.businessId])).rows.map((r) => [r.id, r.at?.toISOString() ?? null])),
      );
    const before = await stamps();
    expect(Object.values(before).every((v) => v === null)).toBe(true);
    await page(w.attendant.token, '?limit=1');
    const after = await stamps();
    expect(after[w.attendant.deviceId!]).toBe(t.clock.now().toISOString());
    for (const [id, at] of Object.entries(after)) if (id !== w.attendant.deviceId) expect(at, id).toBeNull();
    // The next page within 5 minutes does not write again.
    t.clock.advanceMinutes(1);
    const deviceMember: Member = w.attendant;
    await page(deviceMember.token, '?table=product&limit=1');
    expect((await stamps())[w.attendant.deviceId!]).toBe(after[w.attendant.deviceId!]);
    expect(randomUUID()).not.toBe(w.attendant.deviceId);
  });
});
