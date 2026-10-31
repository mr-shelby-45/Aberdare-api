import { SCHEDULES, INTEGRITY_BUSINESS_QUEUE, STALE_BUSINESS_QUEUE } from '../src/jobs/scheduled-jobs.service.js';
import { StockIntegrityService } from '../src/modules/stock/stock-integrity.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type World, stockApi } from './helpers/stock-api.js';
import { type TestWorker, startTestWorker } from './helpers/worker.js';

// Phase F5: the scheduled jobs (docs/phase-f-design.md section 7). Test
// numbers follow the F5 list in section 11. The jobs' work is called directly
// with the shared fake clock; test 5 checks the schedules and the fan-out.

const DAY = 86_400_000;

describe('F5: scheduled jobs', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  const workers: TestWorker[] = [];

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.200', 99_950_000);
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

  const worker = async (schedules = false) => {
    const w = await startTestWorker(t.clock, { schedules, listen: false });
    workers.push(w);
    return w;
  };
  const errorEvents = () =>
    asAdmin(async (c) => (await c.query<{ source: string; code: string; detail: string | null; business_id: string | null }>('SELECT source, code, detail, business_id FROM error_event ORDER BY created_at')).rows);
  const staleNotes = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ recipient: string; data: Record<string, unknown> }>("SELECT recipient_membership_id AS recipient, data FROM notification WHERE business_id = $1 AND type = 'device.stale' ORDER BY created_at, id", [businessId])).rows,
    );
  const setDevice = (deviceId: string, lastSyncAt: Date | null, createdAt?: Date) =>
    asAdmin((c) => c.query('UPDATE device SET last_sync_at = $2, created_at = coalesce($3, created_at) WHERE id = $1', [deviceId, lastSyncAt, createdAt ?? null]));
  const receive = async (w: World) => {
    expect((await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 5 }] }))).status).toBe('ACCEPTED');
  };
  async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  // ---------------------------------------------------------------- 1. the change log prune
  it('1. changelog.prune removes change_log rows past the retention by the Clock, moves the horizon, and an older cursor gets 410', async () => {
    const w = await api.world();
    const wk = await worker();
    const cursor = (await api.call('GET', '/v1/sync/snapshot?limit=1', w.manager.token)).json() as { start_cursor: string };
    await api.newProduct(w.owner, 'Old product');
    // Make the rows so far 40 days old (the Clock decides the cut-off: 30 days).
    await asAdmin((c) => c.query("UPDATE change_log SET changed_at = changed_at - interval '40 days' WHERE business_id = $1", [w.owner.businessId]));
    await api.newProduct(w.owner, 'New product');
    const before = await asAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM change_log WHERE business_id = $1', [w.owner.businessId])).rows[0].n));
    const removed = Number(await wk.scheduled.pruneChangeLog());
    expect(removed).toBeGreaterThan(0);
    const after = await asAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM change_log WHERE business_id = $1', [w.owner.businessId])).rows[0].n));
    expect(after).toBe(before - removed);
    expect(after).toBeGreaterThan(0); // the new product's rows stay
    expect((await asAdmin((c) => c.query('SELECT pruned_through_id FROM change_log_horizon'))).rows[0].pruned_through_id).not.toBe('0');
    const res = await api.call('GET', `/v1/sync/changes?cursor=${encodeURIComponent(cursor.start_cursor)}`, w.manager.token);
    expect([res.statusCode, (res.json() as { error: { code: string } }).error.code]).toEqual([410, 'SNAPSHOT_REQUIRED']);
  });

  // ---------------------------------------------------------------- 2. stock integrity
  it('2. stock.integrity: clean data writes nothing; a corrupted balance writes one error_event for that business only, no notification; again on the next run; one business failing never stops the others', async () => {
    const a = await api.world('Duka A');
    const b = await api.world('Duka B');
    await receive(a);
    await receive(b);
    const wk = await worker();
    expect(await wk.scheduled.checkIntegrity(a.owner.businessId)).toBe(0);
    expect(await errorEvents()).toEqual([]);
    await asAdmin((c) => c.query('UPDATE stock_balance SET quantity = quantity + 1 WHERE business_id = $1', [a.owner.businessId]));
    expect(await wk.scheduled.checkIntegrity(a.owner.businessId)).toBe(1);
    expect(await wk.scheduled.checkIntegrity(b.owner.businessId)).toBe(0);
    const short = `${a.loc.slice(0, 8)}:${a.maize.piece.slice(0, 8)}`;
    expect(await errorEvents()).toEqual([{ source: 'stock.integrity', code: 'INTEGRITY_MISMATCH', detail: `pools=1 ${short}`, business_id: a.owner.businessId }]);
    expect((await asAdmin((c) => c.query('SELECT count(*)::int AS n FROM notification'))).rows[0].n).toBe(0);
    await wk.scheduled.checkIntegrity(a.owner.businessId);
    expect((await errorEvents()).map((e) => e.code)).toEqual(['INTEGRITY_MISMATCH', 'INTEGRITY_MISMATCH']);

    // Through the fan-out, with the first business's check failing: the other is still checked.
    await asAdmin((c) => c.query('TRUNCATE error_event'));
    vi.spyOn(wk.app.get(StockIntegrityService), 'check').mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'P9999' }));
    expect(await wk.scheduled.fanOut(INTEGRITY_BUSINESS_QUEUE)).toBe(2);
    await waitFor(() => (wk.lines().match(/"msg":"integrity checked"/g) ?? []).length >= 2, 'both businesses checked');
    const events = await errorEvents();
    expect(events.map((e) => e.code).sort()).toEqual(['P9999', ...(events.some((e) => e.code === 'INTEGRITY_MISMATCH') ? ['INTEGRITY_MISMATCH'] : [])].sort());
    expect(events.find((e) => e.code === 'P9999')!.source).toBe('stock.integrity');
  });

  // ---------------------------------------------------------------- 3. stale devices
  it('3. devices.stale: 3 days and 1 minute without sync notifies owners once; twice notifies once; a new episode notifies again; revoked never; never-synced by creation date', async () => {
    const w = await api.world();
    const wk = await worker();
    const now = () => t.clock.now().getTime();
    await setDevice(w.manager.deviceId!, new Date(now() - 3 * DAY - 60_000));
    expect(await wk.scheduled.staleDevices(w.owner.businessId)).toBe(1);
    expect(await wk.scheduled.staleDevices(w.owner.businessId)).toBe(1); // still stale, same episode
    let notes = await staleNotes(w.owner.businessId);
    expect(notes).toEqual([{ recipient: w.owner.membershipId, data: { device_id: w.manager.deviceId, membership_id: w.manager.membershipId, days: 3 } }]);
    // It syncs again, then goes stale again: a new episode.
    await setDevice(w.manager.deviceId!, new Date(now()));
    expect(await wk.scheduled.staleDevices(w.owner.businessId)).toBe(0);
    t.clock.advance(3 * DAY + 60_000);
    expect(await wk.scheduled.staleDevices(w.owner.businessId)).toBe(1);
    notes = await staleNotes(w.owner.businessId);
    expect(notes).toHaveLength(2);
    // A revoked device never; a device that never synced is judged by its creation date.
    await setDevice(w.attendant.deviceId!, new Date(now() - 10 * DAY));
    await asAdmin((c) => c.query("UPDATE device SET status = 'REVOKED' WHERE id = $1", [w.attendant.deviceId]));
    const owners = await asAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM device WHERE registered_by_membership_id = $1', [w.owner.membershipId])).rows);
    await setDevice(owners[0].id, null, new Date(now() - 4 * DAY));
    const fresh = await asAdmin(async (c) => (await c.query<{ id: string }>("INSERT INTO device (business_id, name, platform, secret_hash, status, registered_by_membership_id, created_at) VALUES ($1, 'New', 'android', 'x', 'ACTIVE', $2, $3) RETURNING id", [w.owner.businessId, w.owner.membershipId, new Date(now() - DAY)])).rows[0].id);
    expect(await wk.scheduled.staleDevices(w.owner.businessId)).toBe(2); // the manager's (same episode) and the owner's never-synced one
    notes = await staleNotes(w.owner.businessId);
    // Rows of one run share created_at (the Clock), so compare them as a set.
    expect(notes.map((n) => String(n.data.device_id)).sort()).toEqual([w.manager.deviceId!, w.manager.deviceId!, owners[0].id].sort());
    expect(notes.find((n) => n.data.device_id === owners[0].id)!.data).toEqual({ device_id: owners[0].id, membership_id: w.owner.membershipId, days: 4 });
    expect(notes.some((n) => n.data.device_id === w.attendant.deviceId || n.data.device_id === fresh)).toBe(false);
    expect(await errorEvents()).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. the purges
  it('4. the purges remove notifications and error events older than 90 days by the Clock and keep newer ones', async () => {
    const w = await api.world();
    const wk = await worker();
    const at = (days: number) => new Date(t.clock.now().getTime() - days * DAY);
    await asAdmin(async (c) => {
      for (const [key, days] of [['old', 91], ['edge', 89]] as const) {
        await c.query(
          "INSERT INTO notification (business_id, type, recipient_membership_id, channel, data, status, sent_at, dedupe_key, created_at) VALUES ($1, 'sale.flagged', $2, 'IN_APP', '{}', 'SENT', $3, $4, $3)",
          [w.owner.businessId, w.owner.membershipId, at(days), key],
        );
        await c.query("INSERT INTO error_event (source, code, detail, created_at) VALUES ('f5', 'TEST', $1, $2)", [key, at(days)]);
      }
    });
    expect(await wk.scheduled.purgeNotifications()).toBe('1');
    expect(await wk.scheduled.purgeErrorEvents()).toBe('1');
    expect((await asAdmin((c) => c.query('SELECT dedupe_key FROM notification'))).rows).toEqual([{ dedupe_key: 'edge' }]);
    expect((await errorEvents()).map((e) => e.detail)).toEqual(['edge']);
  });

  // ---------------------------------------------------------------- 5. schedules and the fan-out
  it('5. two workers register each schedule once; the fan-out enqueues exactly one job per business', async () => {
    const businesses = [await api.world('Duka A'), await api.world('Duka B'), await api.world('Duka C')].map((w) => w.owner.businessId);
    const [w1] = [await worker(true), await worker(true)];
    const rows = await asAdmin(async (c) => (await c.query<{ name: string; n: number }>('SELECT name, count(*)::int AS n FROM pgboss.schedule GROUP BY name ORDER BY name')).rows);
    expect(rows).toEqual([...Object.keys(SCHEDULES), 'notifications.sweep'].sort().map((name) => ({ name, n: 1 })));
    expect(await w1.scheduled.fanOut(STALE_BUSINESS_QUEUE)).toBe(3);
    const jobs = await asAdmin(
      async (c) => (await c.query<{ b: string }>("SELECT data->>'businessId' AS b FROM pgboss.job WHERE name = $1 AND data->>'businessId' = ANY($2)", [STALE_BUSINESS_QUEUE, businesses])).rows,
    );
    expect(jobs.map((j) => j.b).sort()).toEqual([...businesses].sort());
  });

  // ---------------------------------------------------------------- 6. twice in a row
  it('6. every job is safe to run twice in a row', async () => {
    const w = await api.world();
    await receive(w);
    const wk = await worker();
    await setDevice(w.manager.deviceId!, new Date(t.clock.now().getTime() - 4 * DAY));
    for (let i = 0; i < 2; i++) {
      await wk.scheduled.pruneChangeLog();
      await wk.scheduled.purgeNotifications();
      await wk.scheduled.purgeErrorEvents();
      expect(await wk.scheduled.checkIntegrity(w.owner.businessId)).toBe(0);
      expect(await wk.scheduled.staleDevices(w.owner.businessId)).toBe(1);
    }
    expect(await staleNotes(w.owner.businessId)).toHaveLength(1);
    expect(await errorEvents()).toEqual([]);
  });
});
