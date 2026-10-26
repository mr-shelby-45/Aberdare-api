import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignedCursor } from '../src/common/paging/signed-cursor.js';
import { ApiError } from '../src/common/errors/api.error.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import { ChangeFeedService } from '../src/modules/sync/change-feed.service.js';
import type { ChangePosition } from '../src/modules/sync/change-log.repository.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';
import { type Shop, seedShop } from './helpers/shop.js';
import { stockApi } from './helpers/stock-api.js';

// Phase D1: change_log transaction ids, the changes cursor, the
// finished-transactions query, the prune and the device stamp
// (docs/phase-d-design.md sections 3, 4 and 7). Numbers in test names refer
// to the D1 list in section 11. D1 test 1's inventories are in
// test/step4-migrations.spec.ts and test/b5-hardening.spec.ts.

describe('D1: change_log, cursor, prune and device stamp', { timeout: 180_000 }, () => {
  let t: TestApp;
  let tenants: TenantRunner;
  let feed: ChangeFeedService;
  let stock: StockService;

  beforeAll(async () => {
    t = await startTestApp();
    tenants = t.app.get(TenantRunner, { strict: false });
    feed = t.app.get(ChangeFeedService, { strict: false });
    stock = t.app.get(StockService, { strict: false });
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctx = (s: Shop) => ({ occurredAt: t.clock.now(), createdByMembershipId: s.member, syncCommandId: null });
  /** The transaction id of the current tenant transaction. */
  const xid = async () => (await currentTx().$queryRaw<{ x: string }[]>`SELECT pg_current_xact_id()::text AS x`)[0].x;
  const logRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ id: string; txid: string; table_name: string; operation: string; row_id: string }>(
          'SELECT id::text AS id, txid::text AS txid, table_name, operation, row_id FROM change_log WHERE business_id = $1 ORDER BY txid, id',
          [businessId],
        )).rows,
    );
  /** A raw app_user connection holding one tenant transaction open. */
  async function openTransaction(businessId: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    return client;
  }
  /** Any error from fn, as status and code (or null). */
  async function failure(fn: () => Promise<unknown>): Promise<{ status: number; code: string; message: string } | null> {
    try {
      await fn();
      return null;
    } catch (err) {
      if (err instanceof ApiError) return { status: err.getStatus(), code: err.code, message: err.message };
      throw err;
    }
  }

  // ---------------------------------------------------------------- 1. privileges
  it('1. app_user cannot update or delete change_log, nor write the horizon; it can read the horizon and run the prune', async () => {
    const s = await seedShop(tenants);
    const results = await asAppUser(async (c) => {
      const attempt = async (sql: string) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.business_id', $1, true)", [s.biz]);
        try {
          const r = await c.query(sql);
          await c.query('COMMIT');
          return `ok ${r.rowCount}`;
        } catch (e) {
          await c.query('ROLLBACK');
          return (e as Error).message;
        }
      };
      return {
        update: await attempt("UPDATE change_log SET operation = 'UPDATE'"),
        delete: await attempt('DELETE FROM change_log'),
        horizonWrite: await attempt('UPDATE change_log_horizon SET pruned_through_id = 9'),
        horizonRead: await attempt('SELECT * FROM change_log_horizon'),
        prune: await attempt("SELECT change_log_prune('2000-01-01T00:00:00Z')"),
      };
    });
    expect(results).toEqual({
      update: expect.stringMatching(/permission denied for table change_log$/),
      delete: expect.stringMatching(/permission denied for table change_log$/),
      horizonWrite: expect.stringMatching(/permission denied for table change_log_horizon/),
      horizonRead: 'ok 1',
      prune: 'ok 1',
    });
    expect(await logRows(s.biz)).toHaveLength(4); // seedShop's location, product, piece, carton
  });

  // ---------------------------------------------------------------- 2. txid on every row
  it('2. every change_log row carries its own transaction id: insert, update and delete, every covered table, both stock statements', async () => {
    const s = await seedShop(tenants);
    const expected = new Map<string, string[]>();
    const step = async (fn: () => Promise<unknown>) =>
      tenants.run(s.biz, async () => {
        await fn();
        const ops = (await currentTx().$queryRaw<{ t: string; o: string }[]>`
          SELECT table_name AS t, operation AS o FROM change_log WHERE txid = pg_current_xact_id() ORDER BY id`).map((r) => `${r.t}:${r.o}`);
        expected.set(await xid(), ops);
        return ops;
      });
    const barcodeId = randomUUID();
    const steps = [
      await step(() => currentTx().$executeRaw`UPDATE location SET name = 'Main shop 2' WHERE id = ${s.loc}::uuid`),
      await step(() => currentTx().$executeRaw`UPDATE product SET name = 'Soda 500ml' WHERE business_id = ${s.biz}::uuid`),
      await step(() => currentTx().$executeRaw`UPDATE pack_type SET sell_price = 55 WHERE id = ${s.piece}::uuid`),
      await step(async () => {
        const productId = (await currentTx().$queryRaw<{ id: string }[]>`SELECT product_id AS id FROM pack_type WHERE id = ${s.piece}::uuid`)[0].id;
        await currentTx().$executeRaw`
          INSERT INTO product_barcode (id, business_id, barcode, product_id, pack_type_id, created_by_membership_id)
          VALUES (${barcodeId}::uuid, ${s.biz}::uuid, '6161101560029', ${productId}::uuid, ${s.piece}::uuid, ${s.member}::uuid)`;
      }),
      await step(() => currentTx().$executeRaw`DELETE FROM product_barcode WHERE id = ${barcodeId}::uuid`),
      await step(() => stock.receive(s.loc, s.piece, 10, ctx(s))), // upsert: insert
      await step(() => stock.decreaseStrict(s.loc, s.piece, 3, ctx(s))), // strict update
      await step(() => stock.decreaseForSale(s.loc, s.piece, 20, ctx(s))), // sale-mode upsert: update, below zero
    ];
    expect(steps).toEqual([
      ['location:UPDATE'],
      ['product:UPDATE'],
      ['pack_type:UPDATE'],
      ['product_barcode:INSERT'],
      ['product_barcode:DELETE'],
      ['stock_balance:INSERT'],
      ['stock_balance:UPDATE'],
      ['stock_balance:UPDATE'],
    ]);
    // Every row in the log has a txid, and each transaction's rows carry exactly its own id.
    const rows = await logRows(s.biz);
    expect(rows.every((r) => /^\d+$/.test(r.txid))).toBe(true);
    for (const [txid, ops] of expected) {
      expect(rows.filter((r) => r.txid === txid).map((r) => `${r.table_name}:${r.operation}`), txid).toEqual(ops);
    }
    // The inserts of seedShop (one transaction) share one txid.
    const seeded = rows.filter((r) => ![...expected.keys()].includes(r.txid));
    expect(seeded.map((r) => r.table_name).sort()).toEqual(['location', 'pack_type', 'pack_type', 'product']);
    expect(new Set(seeded.map((r) => r.txid)).size).toBe(1);
  });

  // ---------------------------------------------------------------- 3. the gap (run 5 times)
  it('3. gap test: an open T1 hides its row and the later committed T2; after T1 commits both arrive once, in (txid, id) order', async () => {
    const s = await seedShop(tenants);
    // The phone's cursor from before either change.
    const before = await tenants.run(s.biz, () => feed.startCursor(s.biz, { costs: false, allSales: false }));
    const start = await tenants.run(s.biz, () => feed.open(before, s.biz, { costs: false, allSales: false }));

    // T1 writes first (lower change_log id, lower txid) and stays open.
    const t1 = await openTransaction(s.biz);
    try {
      await t1.query("INSERT INTO location (business_id, name) VALUES ($1, 'T1 store')", [s.biz]);
      const t1xid = (await t1.query<{ x: string }>('SELECT pg_current_xact_id()::text AS x')).rows[0].x;
      // T2 writes later and commits first.
      const t2xid = await tenants.run(s.biz, async () => {
        await currentTx().$executeRaw`INSERT INTO location (business_id, name) VALUES (${s.biz}::uuid, 'T2 store')`;
        return xid();
      });
      expect(BigInt(t2xid)).toBeGreaterThan(BigInt(t1xid));

      // Neither is returned while T1 is open: T2's row waits behind T1.
      const whileOpen = await tenants.run(s.biz, () => feed.finishedAfter(start, 100));
      expect(whileOpen).toEqual([]);

      await t1.query('COMMIT');
      const after = await tenants.run(s.biz, () => feed.finishedAfter(start, 100));
      expect(after.map((r) => [r.txid, r.tableName, r.operation])).toEqual([
        [t1xid, 'location', 'INSERT'],
        [t2xid, 'location', 'INSERT'],
      ]);
      // A phone paging one row at a time from the old cursor sees each exactly once.
      const seen: string[] = [];
      let position: ChangePosition = start;
      for (;;) {
        const page = await tenants.run(s.biz, () => feed.finishedAfter(position, 1));
        if (page.length === 0) break;
        seen.push(page[0].id);
        position = { txid: page[0].txid, id: page[0].id };
      }
      expect(seen).toEqual(after.map((r) => r.id));
    } finally {
      await t1.end();
    }
  });

  // ---------------------------------------------------------------- 4. rollback
  it('4. a rolled-back transaction leaves no change_log row', async () => {
    const s = await seedShop(tenants);
    const before = await logRows(s.biz);
    await expect(
      tenants.run(s.biz, async () => {
        await currentTx().$executeRaw`INSERT INTO location (business_id, name) VALUES (${s.biz}::uuid, 'Never')`;
        await stock.receive(s.loc, s.piece, 5, ctx(s));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await logRows(s.biz)).toEqual(before);
    const start = await tenants.run(s.biz, () => feed.open(feed.sign(s.biz, { txid: '0', id: '0' }, { costs: false, allSales: false }), s.biz, { costs: false, allSales: false }));
    expect((await tenants.run(s.biz, () => feed.finishedAfter(start, 100))).map((r) => r.tableName).sort()).toEqual(['location', 'pack_type', 'pack_type', 'product']);
  });

  // ---------------------------------------------------------------- 5. the cursor
  it('5. tampered, unsigned, malformed and another business’s cursors are the same 422; a costs mismatch is 410 either way', async () => {
    const a = await seedShop(tenants, 'Shop A');
    const b = await seedShop(tenants, 'Shop B');
    const good = await tenants.run(a.biz, () => feed.startCursor(a.biz, { costs: false, allSales: false }));
    const open = (biz: string, raw: string, costs: boolean) => failure(() => tenants.run(biz, () => feed.open(raw, biz, { costs, allSales: false })));

    expect(await open(a.biz, good, false)).toBeNull();
    const tampered = `${good.slice(0, 5)}${good[5] === 'A' ? 'B' : 'A'}${good.slice(6)}`;
    const unsigned = good.split('.')[0];
    const otherKind = t.app.get(SignedCursor, { strict: false }).sign('products', { name: 'x', id: randomUUID(), include_archived: false });
    const invalid = { status: 422, code: 'VALIDATION_FAILED', message: 'The cursor is not valid.' };
    for (const raw of [tampered, unsigned, 'not-a-cursor', '', otherKind]) {
      expect(await open(a.biz, raw, false), raw).toEqual(invalid);
    }
    // Business A's genuine cursor, sent by business B: identical to a tampered one.
    expect(await open(b.biz, good, false)).toEqual(invalid);

    // Issued without costs, read by a member who now sees costs: 410; and the other way round.
    const snapshot = { status: 410, code: 'SNAPSHOT_REQUIRED', message: expect.any(String) };
    expect(await open(a.biz, good, true)).toEqual(snapshot);
    const withCosts = await tenants.run(a.biz, () => feed.startCursor(a.biz, { costs: true, allSales: false }));
    expect(await open(a.biz, withCosts, false)).toEqual(snapshot);
    expect(await open(a.biz, withCosts, true)).toBeNull();
  });

  // ---------------------------------------------------------------- 5a. device stamp
  it('5a. the device stamp: set once, not again within 5 minutes, again after; no log or audit row; app_user may update no other device column', async () => {
    const api = stockApi(t, '198.51.100.130', 94_000_000);
    const w = await api.world();
    const devices = t.app.get(DevicesService, { strict: false });
    const deviceId = w.attendant.deviceId!;
    const stamp = () => tenants.run(w.owner.businessId, () => devices.stampSync(deviceId));
    const stamped = async () =>
      asAdmin(async (c) => (await c.query<{ at: Date | null }>('SELECT last_sync_at AS at FROM device WHERE id = $1', [deviceId])).rows[0].at);
    const counts = () =>
      asAdmin(async (c) => ({
        deviceLog: Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM change_log WHERE table_name = 'device'")).rows[0].n),
        audit: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM audit_log WHERE business_id = $1', [w.owner.businessId])).rows[0].n),
      }));
    const other = await asAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM device WHERE id <> $1 AND business_id = $2', [deviceId, w.owner.businessId])).rows);
    const before = await counts();

    expect(await stamped()).toBeNull();
    const first = t.clock.now();
    expect(await stamp()).toBe(true);
    expect((await stamped())?.toISOString()).toBe(first.toISOString());
    t.clock.advanceMinutes(4);
    expect(await stamp()).toBe(false);
    t.clock.advanceMinutes(1);
    expect(await stamp()).toBe(false); // exactly 5 minutes: not yet
    t.clock.advance(1000);
    const second = t.clock.now();
    expect(await stamp()).toBe(true);
    expect((await stamped())?.toISOString()).toBe(second.toISOString());

    // 20 at once after another 6 minutes: exactly one writes, none fails.
    t.clock.advanceMinutes(6);
    const third = t.clock.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => stamp()));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await stamped())?.toISOString()).toBe(third.toISOString());

    // Only this device was stamped; no change_log or audit row.
    for (const d of other) {
      expect(await asAdmin(async (c) => (await c.query('SELECT last_sync_at FROM device WHERE id = $1', [d.id])).rows[0].last_sync_at)).toBeNull();
    }
    expect(await counts()).toEqual(before);

    // app_user may update the five columns the app writes, and no other.
    const tryUpdate = (column: string, value: string) =>
      asAppUser(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.business_id', $1, true)", [w.owner.businessId]);
        try {
          await c.query(`UPDATE device SET ${column} = ${value} WHERE id = $1`, [deviceId]);
          await c.query('ROLLBACK');
          return 'allowed';
        } catch (e) {
          await c.query('ROLLBACK');
          return (e as Error).message;
        }
      });
    for (const [column, value] of [['name', "'x'"], ['is_shared', 'true'], ['status', "'ACTIVE'"], ['last_seen_at', 'now()'], ['last_sync_at', 'now()']]) {
      expect(await tryUpdate(column, value), column).toBe('allowed');
    }
    for (const [column, value] of [
      ['secret_hash', "'x'"],
      ['platform', "'ios'"],
      ['push_token', "'x'"],
      ['business_id', `'${randomUUID()}'`],
      ['registered_by_membership_id', `'${w.owner.membershipId}'`],
      ['created_at', 'now()'],
      ['id', `'${randomUUID()}'`],
    ]) {
      expect(await tryUpdate(column, value), column).toMatch(/permission denied for table device/);
    }
  });

  // ---------------------------------------------------------------- 6. prune
  it('6. prune: rows older than 30 days by the Clock go, newer stay; cursors before the horizon are 410, at or after it accepted; other businesses keep newer rows', async () => {
    const a = await seedShop(tenants, 'Shop A');
    const b = await seedShop(tenants, 'Shop B');
    const now = t.clock.now().getTime();
    const daysAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString();
    // Shop A: four seeded rows made old, then two newer changes; shop B: all newer.
    await asAdmin((c) => c.query('UPDATE change_log SET changed_at = $1 WHERE business_id = $2', [daysAgo(31), a.biz]));
    await asAdmin((c) => c.query('UPDATE change_log SET changed_at = $1 WHERE business_id = $2', [daysAgo(29), b.biz]));
    await tenants.run(a.biz, () => currentTx().$executeRaw`INSERT INTO location (business_id, name) VALUES (${a.biz}::uuid, 'Store 1')`);
    await tenants.run(a.biz, () => currentTx().$executeRaw`INSERT INTO location (business_id, name) VALUES (${a.biz}::uuid, 'Store 2')`);
    await asAdmin((c) =>
      c.query("UPDATE change_log SET changed_at = $1 WHERE business_id = $2 AND table_name = 'location' AND row_id <> $3", [daysAgo(29.9), a.biz, a.loc]),
    );
    const aRows = await logRows(a.biz);
    const bRows = await logRows(b.biz);
    expect(aRows).toHaveLength(6);

    expect(await feed.prune()).toBe('4');
    const left = await logRows(a.biz);
    expect(left.map((r) => r.id)).toEqual(aRows.slice(4).map((r) => r.id));
    expect(await logRows(b.biz)).toEqual(bRows);
    // The horizon is the newest removed position.
    const removed = aRows.slice(0, 4).sort((x, y) => (BigInt(x.txid) === BigInt(y.txid) ? Number(BigInt(x.id) - BigInt(y.id)) : BigInt(x.txid) < BigInt(y.txid) ? -1 : 1));
    const newest = removed[removed.length - 1];
    expect(await asAdmin(async (c) => (await c.query('SELECT pruned_through_txid::text AS txid, pruned_through_id::text AS id FROM change_log_horizon')).rows[0])).toEqual({
      txid: newest.txid,
      id: newest.id,
    });

    const at = (p: ChangePosition) => feed.sign(a.biz, p, { costs: false, allSales: false });
    const open = (raw: string) => failure(() => tenants.run(a.biz, () => feed.open(raw, a.biz, { costs: false, allSales: false })));
    expect(await open(at({ txid: '0', id: '0' }))).toMatchObject({ status: 410, code: 'SNAPSHOT_REQUIRED' });
    expect(await open(at({ txid: newest.txid, id: String(BigInt(newest.id) - 1n) }))).toMatchObject({ status: 410, code: 'SNAPSHOT_REQUIRED' });
    expect(await open(at({ txid: newest.txid, id: newest.id }))).toBeNull();
    expect(await open(at({ txid: left[0].txid, id: left[0].id }))).toBeNull();
    // From the horizon the remaining rows all arrive.
    const fromHorizon = await tenants.run(a.biz, () => feed.finishedAfter({ txid: newest.txid, id: newest.id }, 100));
    expect(fromHorizon.map((r) => r.id)).toEqual(left.map((r) => r.id));

    // A second prune with nothing old removes nothing and leaves the horizon.
    expect(await feed.prune()).toBe('0');
    expect(await asAdmin(async (c) => (await c.query('SELECT pruned_through_id::text AS id FROM change_log_horizon')).rows[0].id)).toBe(newest.id);
  });
});
