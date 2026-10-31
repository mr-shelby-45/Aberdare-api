import { randomUUID } from 'node:crypto';
import { TenantRunner } from '../src/database/tenant.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository.js';
import { type NotificationTarget, NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type World, stockApi } from './helpers/stock-api.js';
import { type TestWorker, startTestWorker } from './helpers/worker.js';

// Phase F3: push delivery (docs/phase-f-design.md section 5). Test numbers
// follow the F3 list in section 11; 8 (the wake-up) and 9 (the push-token
// endpoint) were added with the F3 proposal. The worker shares the API test
// app's fake clock; most tests drive dispatch and sweep by hand.

interface RowState {
  status: string;
  attempts: number;
  last_error: string | null;
  sent: boolean;
  next_attempt_at: Date | null;
}

describe('F3: push delivery', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  const workers: TestWorker[] = [];

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.198', 99_800_000);
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

  const worker = async (options: { listen?: boolean } = {}) => {
    const w = await startTestWorker(t.clock, { schedules: false, listen: options.listen ?? false });
    workers.push(w);
    return w;
  };
  const tenants = () => t.app.get(TenantRunner, { strict: false });
  const delivery = (w: TestWorker) => w.app.get(NotificationDeliveryService);
  let seq = 0;
  /** One sale.flagged event to these members, on the given channels (default PUSH and IN_APP). */
  const notify = (w: World, to: string[], channels: NotificationTarget['channels'] = ['PUSH', 'IN_APP']) => {
    const saleId = randomUUID();
    return tenants()
      .run(w.owner.businessId, () =>
        t.app.get(NotificationsService, { strict: false }).notify({ type: 'sale.flagged', dedupeKey: `sale.flagged:${saleId}`, data: { sale_id: saleId, sale_number: ++seq, flags: ['STOCK_NEGATIVE'] } }, [{ to, channels }]),
      )
      .then(() => saleId);
  };
  const setToken = async (m: Member, token: string | null) => {
    const res = await api.call('PUT', '/v1/devices/me/push-token', m.token, { push_token: token });
    expect(res.statusCode, res.body).toBe(204);
  };
  const pushRow = async (saleId: string) =>
    asAdmin(
      async (c) =>
        (
          await c.query<RowState>(
            "SELECT status, attempts, last_error, sent_at IS NOT NULL AS sent, next_attempt_at FROM notification WHERE channel = 'PUSH' AND data->>'sale_id' = $1",
            [saleId],
          )
        ).rows[0],
    );
  const errorEvents = () => asAdmin(async (c) => (await c.query<{ source: string; code: string }>('SELECT source, code FROM error_event ORDER BY created_at')).rows);
  const tokenOf = (deviceId: string) => asAdmin(async (c) => (await c.query<{ push_token: string | null }>('SELECT push_token FROM device WHERE id = $1', [deviceId])).rows[0].push_token);
  const openTransactions = () =>
    asAdmin(async (c) => Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'app_user' AND state LIKE 'idle in transaction%'")).rows[0].n));
  async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 20_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  // ---------------------------------------------------------------- 1. a push is delivered
  it('1. a PENDING push is claimed, sent outside any transaction to personal devices with a token, and marked SENT; IN_APP rows never reach a sender', async () => {
    const w = await api.world();
    const wk = await worker();
    await setToken(w.manager, 'tok-manager');
    // A shared tablet the manager registered, holding a token: never pushed to.
    const tablet = await asAdmin(async (c) => (await c.query<{ id: string }>("INSERT INTO device (business_id, name, platform, secret_hash, is_shared, status, registered_by_membership_id, push_token) VALUES ($1, 'Tablet', 'android', 'x', true, 'ACTIVE', $2, 'tok-tablet') RETURNING id", [w.owner.businessId, w.manager.membershipId])).rows[0].id);
    expect(tablet).toBeTruthy();
    const sale = await notify(w, [w.manager.membershipId]);
    const r = await delivery(wk).dispatchBusiness(w.owner.businessId);
    expect(r).toMatchObject({ claimed: 1, sent: 1, retried: 0, dead: 0, more: false });
    expect(wk.push.outbox).toHaveLength(1);
    expect(wk.push.outbox[0]).toEqual({
      token: 'tok-manager',
      answer: 'OK',
      push: { notificationId: expect.any(String), type: 'sale.flagged', data: { sale_id: sale, sale_number: seq, flags: ['STOCK_NEGATIVE'] }, message: `Sale #${seq} was flagged: Stock went negative.` },
    });
    expect(wk.push.calledInsideTransaction).toEqual([]);
    expect(await pushRow(sale)).toMatchObject({ status: 'SENT', attempts: 1, sent: true, last_error: null, next_attempt_at: null });
    // Nothing left to claim; the IN_APP row was never claimed.
    expect((await delivery(wk).dispatchBusiness(w.owner.businessId)).claimed).toBe(0);
    expect(wk.push.outbox).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 2. retries
  it('2. retries: fails twice then succeeds (SENT, attempts 3, after 30 s and 2 min); fails three times (DEAD, one error_event, last_error a code)', async () => {
    const w = await api.world();
    const wk = await worker();
    await setToken(w.manager, 'tok-r');
    wk.push.script('tok-r', 'FAILED', 'RETRY');
    const sale = await notify(w, [w.manager.membershipId]);
    const d = () => delivery(wk).dispatchBusiness(w.owner.businessId);
    expect(await d()).toMatchObject({ claimed: 1, retried: 1 });
    expect(await pushRow(sale)).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'PUSH_FAILED_ONCE' });
    expect((await d()).claimed).toBe(0); // not due yet
    t.clock.advance(29_999);
    expect((await d()).claimed).toBe(0);
    t.clock.advance(1);
    expect(await d()).toMatchObject({ claimed: 1, retried: 1 });
    expect(await pushRow(sale)).toMatchObject({ status: 'PENDING', attempts: 2, last_error: 'PUSH_RETRY' });
    t.clock.advance(119_999);
    expect((await d()).claimed).toBe(0);
    t.clock.advance(1);
    expect(await d()).toMatchObject({ claimed: 1, sent: 1 });
    expect(await pushRow(sale)).toMatchObject({ status: 'SENT', attempts: 3, last_error: null });
    expect(await errorEvents()).toEqual([]);

    // Three failures: DEAD after the third, one error_event, never a fourth attempt.
    wk.push.script('tok-r', 'FAILED', 'FAILED', 'FAILED');
    const second = await notify(w, [w.manager.membershipId]);
    await d();
    t.clock.advance(30_000);
    await d();
    t.clock.advance(120_000);
    expect(await d()).toMatchObject({ claimed: 1, dead: 1 });
    expect(await pushRow(second)).toMatchObject({ status: 'DEAD', attempts: 3, last_error: 'PUSH_FAILED', sent: false });
    expect(await errorEvents()).toEqual([{ source: 'notifications.push', code: 'PUSH_FAILED' }]);
    t.clock.advance(3_600_000);
    expect((await d()).claimed).toBe(0);
  });

  // ---------------------------------------------------------------- 3. dead tokens
  it('3. DEAD_TOKEN clears that token and makes the row DEAD (no retry, no error_event); a later push to that member is DEAD with NO_PUSH_TOKEN; a newly set token is kept', async () => {
    const w = await api.world();
    const wk = await worker();
    await setToken(w.manager, 'tok-dead');
    wk.push.script('tok-dead', 'DEAD_TOKEN');
    const sale = await notify(w, [w.manager.membershipId]);
    expect(await delivery(wk).dispatchBusiness(w.owner.businessId)).toMatchObject({ claimed: 1, dead: 1 });
    expect(await pushRow(sale)).toMatchObject({ status: 'DEAD', attempts: 1, last_error: 'DEAD_TOKEN' });
    expect(await tokenOf(w.manager.deviceId!)).toBeNull();
    expect(await errorEvents()).toEqual([]);
    const later = await notify(w, [w.manager.membershipId]);
    expect(await delivery(wk).dispatchBusiness(w.owner.businessId)).toMatchObject({ claimed: 1, dead: 1 });
    expect(await pushRow(later)).toMatchObject({ status: 'DEAD', last_error: 'NO_PUSH_TOKEN' });
    // The one push asked was the first, answered DEAD_TOKEN; nothing was sent for the later one.
    expect(wk.push.outbox.map((o) => [o.token, o.answer])).toEqual([['tok-dead', 'DEAD_TOKEN']]);
    expect(await errorEvents()).toEqual([]);
    // A token the phone set after the dead one was reported is never cleared by that report.
    await setToken(w.manager, 'tok-new');
    await tenants().run(w.owner.businessId, () => t.app.get(DevicesService, { strict: false }).clearPushToken(w.manager.deviceId!, 'tok-dead'));
    expect(await tokenOf(w.manager.deviceId!)).toBe('tok-new');
  });

  // ---------------------------------------------------------------- 4. concurrency
  it('4. concurrency: 3 workers and 30 pending pushes send each exactly once; the same claim attempted 20 times at once succeeds once', async () => {
    const w = await api.world();
    const wks = [await worker(), await worker(), await worker()];
    await setToken(w.manager, 'tok-c');
    const sales: string[] = [];
    for (let i = 0; i < 30; i++) sales.push(await notify(w, [w.manager.membershipId], ['PUSH']));
    for (let round = 0; round < 5; round++) await Promise.all(wks.map((wk) => delivery(wk).dispatchBusiness(w.owner.businessId)));
    const sent = wks.flatMap((wk) => wk.push.outbox.map((o) => o.push.notificationId));
    expect(sent).toHaveLength(30);
    expect(new Set(sent).size).toBe(30);
    for (const s of sales) expect((await pushRow(s)).status).toBe('SENT');

    const one = await notify(w, [w.manager.membershipId], ['PUSH']);
    const now = t.clock.now();
    const repo = t.app.get(NotificationsRepository, { strict: false });
    const claims = await Promise.all(Array.from({ length: 20 }, () => tenants().run(w.owner.businessId, () => repo.claimDuePush(now, new Date(now.getTime() + 300_000), 50))));
    expect(claims.flat()).toHaveLength(1);
    expect(await pushRow(one)).toMatchObject({ status: 'SENDING', attempts: 1 });
  });

  // ---------------------------------------------------------------- 5. crashes and the sweeper
  it('5. the sweeper takes back an expired lease and the push is sent; a lost wake-up is sent by the sweep job; a lease still running is left; the at-least-once case', async () => {
    const w = await api.world();
    const wk = await worker();
    await setToken(w.manager, 'tok-s');
    const repo = t.app.get(NotificationsRepository, { strict: false });
    const claimNow = () => {
      const now = t.clock.now();
      return tenants().run(w.owner.businessId, () => repo.claimDuePush(now, new Date(now.getTime() + 300_000), 50));
    };
    // A worker claimed a push and died: SENDING, lease running.
    const crashed = await notify(w, [w.manager.membershipId], ['PUSH']);
    const [claim] = await claimNow();
    t.clock.advance(4 * 60_000);
    expect(await wk.jobs.sweepAll()).toBe(0);
    expect((await pushRow(crashed)).status).toBe('SENDING'); // still inside its 5 minutes
    t.clock.advance(60_000);
    expect(await wk.jobs.sweepAll()).toBe(1); // taken back, and due at once
    expect(await pushRow(crashed)).toMatchObject({ status: 'PENDING', attempts: 1 });
    // The sweep enqueued a dispatch job; the worker's own queue loop sends it.
    await waitFor(async () => (await pushRow(crashed)).status === 'SENT', 'the swept push to be sent');
    expect(await pushRow(crashed)).toMatchObject({ status: 'SENT', attempts: 2 });

    // At least once: the first worker was only slow, and its send finishes after the sweeper took the row back.
    await wk.push.send('tok-s', { notificationId: claim.id, type: claim.type, data: claim.data, message: 'late' });
    expect(await tenants().run(w.owner.businessId, () => repo.markSent(claim.id, claim.attempts, t.clock.now()))).toBe(false);
    expect(wk.push.outbox.filter((o) => o.push.notificationId === claim.id)).toHaveLength(2); // sent twice: accepted for push
    expect(await pushRow(crashed)).toMatchObject({ status: 'SENT', attempts: 2 });

    // A push whose wake-up was lost (no listener here): found by the sweep job and sent.
    const lost = await notify(w, [w.manager.membershipId], ['PUSH']);
    expect(await wk.jobs.sweepAll()).toBe(1);
    await waitFor(async () => (await pushRow(lost)).status === 'SENT', 'the lost push to be sent');

    // A lease that runs out on the last attempt: DEAD and one error_event.
    const last = await notify(w, [w.manager.membershipId], ['PUSH']);
    await asAdmin((c) => c.query("UPDATE notification SET attempts = 2 WHERE channel = 'PUSH' AND data->>'sale_id' = $1", [last]));
    await claimNow();
    t.clock.advance(5 * 60_000);
    // A dispatch never claims an expired SENDING row itself (that would be a 4th attempt): only the sweeper decides.
    expect((await delivery(wk).dispatchBusiness(w.owner.businessId)).claimed).toBe(0);
    expect(await pushRow(last)).toMatchObject({ status: 'SENDING', attempts: 3 });
    expect(await wk.jobs.sweepAll()).toBe(0);
    expect(await pushRow(last)).toMatchObject({ status: 'DEAD', attempts: 3, last_error: 'LEASE_EXPIRED' });
    expect(await errorEvents()).toEqual([{ source: 'notifications.sweep', code: 'LEASE_EXPIRED' }]);
  });

  // ---------------------------------------------------------------- 6. a bad sender
  it('6. a sender that throws or never answers leaves no transaction open and no row stuck', async () => {
    const w = await api.world();
    const wk = await worker();
    await setToken(w.manager, 'tok-bad');
    wk.push.script('tok-bad', 'THROW', 'HANG');
    const sale = await notify(w, [w.manager.membershipId], ['PUSH']);
    expect(await delivery(wk).dispatchBusiness(w.owner.businessId)).toMatchObject({ retried: 1 });
    expect(await pushRow(sale)).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'PUSH_ERROR' });
    t.clock.advance(30_000);
    const hanging = delivery(wk).dispatchBusiness(w.owner.businessId);
    await waitFor(async () => (await pushRow(sale)).status === 'SENDING', 'the claim');
    await new Promise((r) => setTimeout(r, 500));
    expect(await openTransactions()).toBe(0); // the sender is waiting; no transaction waits with it
    expect(await hanging).toMatchObject({ retried: 1 }); // the 10 s timeout
    expect(await pushRow(sale)).toMatchObject({ status: 'PENDING', attempts: 2, last_error: 'PUSH_TIMEOUT' });
    expect(await openTransactions()).toBe(0);
  });

  // ---------------------------------------------------------------- 7. logs
  it('7. no worker log line contains a token, a message text or a recipient\'s name', async () => {
    const w = await api.world();
    const wk = await worker();
    await setToken(w.manager, 'tok-SECRET-123');
    wk.push.script('tok-SECRET-123', 'RETRY');
    await notify(w, [w.manager.membershipId]);
    await delivery(wk).dispatchBusiness(w.owner.businessId);
    t.clock.advance(30_000);
    await wk.jobs.sweepAll();
    await waitFor(() => wk.lines().includes('"msg":"pushes dispatched"'), 'the dispatch job');
    expect(wk.push.outbox.map((o) => o.answer)).toEqual(['RETRY', 'OK']);
    const raw = wk.lines() + t.rawLogs();
    expect(wk.lines()).toContain('"msg":"pushes dispatched"');
    for (const secret of ['tok-SECRET-123', 'was flagged', 'Baraka', 'Chebet', 'Amina']) expect(raw, secret).not.toContain(secret);
  });

  // ---------------------------------------------------------------- 8. the wake-up
  it('8. a committed notify() wakes the worker and the push goes out within seconds, without the sweeper; a rolled-back one sends nothing', async () => {
    const w = await api.world();
    const wk = await worker({ listen: true });
    await setToken(w.manager, 'tok-wake');
    const startedAt = Date.now();
    const sale = await notify(w, [w.manager.membershipId], ['PUSH']);
    await waitFor(async () => (await pushRow(sale)).status === 'SENT', 'the woken push', 10_000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(wk.push.outbox).toHaveLength(1);
    // Rolled back: no row, no signal, nothing sent.
    const saleId = randomUUID();
    await expect(
      tenants().run(w.owner.businessId, async () => {
        await t.app.get(NotificationsService, { strict: false }).notify({ type: 'sale.flagged', dedupeKey: `sale.flagged:${saleId}`, data: { sale_id: saleId } }, [{ to: [w.manager.membershipId], channels: ['PUSH'] }]);
        throw new Error('the command failed');
      }),
    ).rejects.toThrow('the command failed');
    await new Promise((r) => setTimeout(r, 3_000));
    expect(wk.push.outbox).toHaveLength(1);
    expect(await pushRow(saleId)).toBeUndefined();
  });

  // ---------------------------------------------------------------- 9. the push-token endpoint
  it('9. PUT /v1/devices/me/push-token sets and clears only the caller\'s device; the same token on another device moves; bad bodies 422; never returned or logged', async () => {
    const w = await api.world();
    await setToken(w.manager, 'tok-share-ABC');
    expect(await tokenOf(w.manager.deviceId!)).toBe('tok-share-ABC');
    expect(await tokenOf(w.attendant.deviceId!)).toBeNull();
    // The same token reported by another phone of the business (a reinstall): it moves.
    await setToken(w.attendant, 'tok-share-ABC');
    expect(await tokenOf(w.attendant.deviceId!)).toBe('tok-share-ABC');
    expect(await tokenOf(w.manager.deviceId!)).toBeNull();
    await setToken(w.attendant, null);
    expect(await tokenOf(w.attendant.deviceId!)).toBeNull();
    for (const body of [{}, { push_token: '' }, { push_token: 5 }, { push_token: 'x'.repeat(4097) }, { push_token: 'a', device_id: w.manager.deviceId }]) {
      const res = await api.call('PUT', '/v1/devices/me/push-token', w.attendant.token, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    // Never returned: the device list shows no token.
    await setToken(w.manager, 'tok-share-ABC');
    const devices = await api.call('GET', '/v1/devices', w.owner.token);
    expect(devices.statusCode).toBe(200);
    expect(devices.body).not.toContain('tok-share-ABC');
    expect(t.rawLogs()).not.toContain('tok-share-ABC');
  });
});
