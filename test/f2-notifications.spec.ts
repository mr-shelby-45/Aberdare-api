import { randomUUID } from 'node:crypto';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository.js';
import { type NotificationEvent, type NotificationTarget, NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type World, stockApi } from './helpers/stock-api.js';

// Phase F2: the notification service (creating) and the three reads
// (docs/phase-f-design.md section 5). Test numbers follow the F2 list in
// section 11. notify() is called here directly in a tenant transaction, as the
// commands will call it in F4.

interface Row {
  id: string;
  type: string;
  data: Record<string, unknown>;
  message: string;
  created_at: string;
  read_at: string | null;
}

describe('F2: notifications', { timeout: 180_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.197', 99_700_000);
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

  const svc = () => t.app.get(NotificationsService, { strict: false });
  const tenants = () => t.app.get(TenantRunner, { strict: false });
  const notify = (w: World, event: NotificationEvent, targets: NotificationTarget[], exclude: string[] = []) => tenants().run(w.owner.businessId, () => svc().notify(event, targets, { exclude }));
  const flagged = (saleId = randomUUID(), saleNumber = 1): NotificationEvent => ({
    type: 'sale.flagged',
    dedupeKey: `sale.flagged:${saleId}`,
    data: { sale_id: saleId, sale_number: saleNumber, flags: ['STOCK_NEGATIVE'] },
  });
  const rowsOf = (businessId: string) =>
    asAdmin(
      async (c) =>
        (
          await c.query<{ recipient: string; channel: string; status: string; sent: boolean; due: boolean; dedupe_key: string }>(
            `SELECT recipient_membership_id AS recipient, channel, status, sent_at IS NOT NULL AS sent, next_attempt_at IS NOT NULL AS due, dedupe_key
               FROM notification WHERE business_id = $1 ORDER BY recipient_membership_id, channel, dedupe_key`,
            [businessId],
          )
        ).rows,
    );
  const errorEvents = () => asAdmin(async (c) => (await c.query<{ source: string; code: string; detail: string | null; business_id: string | null }>('SELECT source, code, detail, business_id FROM error_event ORDER BY created_at')).rows);
  const list = async (token: string, query = '') => {
    const res = await api.call('GET', `/v1/notifications${query}`, token);
    return { status: res.statusCode, body: res.json() as { notifications: Row[]; next_cursor: string | null; error?: { code: string } } };
  };
  const unread = async (token: string) => (await api.call('GET', '/v1/notifications/unread-count', token)).json() as { unread: number };
  const markRead = (token: string, body: unknown) => api.call('POST', '/v1/notifications/read', token, body);
  const byId = (ids: string[]) => [...ids].sort();

  // ---------------------------------------------------------------- 1. creating
  it('1. one row per recipient and channel in the caller\'s transaction; a rollback leaves none; the same event twice leaves one; a failure is an error_event and the caller still commits', async () => {
    const w = await api.world();
    const targets: NotificationTarget[] = [
      { to: 'OWNERS', channels: ['IN_APP'] },
      { to: [w.manager.membershipId], channels: ['IN_APP', 'PUSH'] },
    ];
    const event = flagged();
    expect(await notify(w, event, targets)).toBe(3);
    expect(await rowsOf(w.owner.businessId)).toEqual(
      [
        { recipient: w.owner.membershipId, channel: 'IN_APP', status: 'SENT', sent: true, due: false, dedupe_key: event.dedupeKey },
        { recipient: w.manager.membershipId, channel: 'IN_APP', status: 'SENT', sent: true, due: false, dedupe_key: event.dedupeKey },
        { recipient: w.manager.membershipId, channel: 'PUSH', status: 'PENDING', sent: false, due: true, dedupe_key: event.dedupeKey },
      ].sort((a, b) => (a.recipient + a.channel).localeCompare(b.recipient + b.channel)),
    );
    // The same event again (a retried command): no new row, and no error swallowed.
    expect(await notify(w, event, targets)).toBe(0);
    expect(await rowsOf(w.owner.businessId)).toHaveLength(3);
    expect(await errorEvents()).toEqual([]);

    // A rolled-back event notifies nobody.
    const rolled = flagged();
    await expect(
      tenants().run(w.owner.businessId, async () => {
        await svc().notify(rolled, targets);
        throw new Error('the command failed');
      }),
    ).rejects.toThrow('the command failed');
    expect((await rowsOf(w.owner.businessId)).filter((r) => r.dedupe_key === rolled.dedupeKey)).toEqual([]);

    // A failing statement inside notify: rolled back to the savepoint, one error_event, and the caller goes on and commits.
    const repo = t.app.get(NotificationsRepository, { strict: false });
    vi.spyOn(repo, 'insertMany').mockImplementationOnce(async () => {
      await currentTx().$executeRawUnsafe('SELECT 1 / 0');
      return 0;
    });
    const later = flagged();
    await tenants().run(w.owner.businessId, async () => {
      expect(await svc().notify(flagged(), targets)).toBe(0);
      // The transaction is still usable: the caller's own work commits.
      expect(await svc().notify(later, [{ to: 'OWNERS', channels: ['IN_APP'] }])).toBe(1);
    });
    expect((await rowsOf(w.owner.businessId)).filter((r) => r.dedupe_key === later.dedupeKey)).toHaveLength(1);
    expect(await errorEvents()).toEqual([{ source: 'notifications', code: '22012', detail: 'notify sale.flagged', business_id: w.owner.businessId }]);

    // A programming error (a data key not allowed) never fails the caller either.
    expect(await notify(w, { type: 'sale.flagged', dedupeKey: 'x:1', data: { customer_name: 'Amina' } }, targets)).toBe(0);
    expect((await errorEvents()).map((e) => e.code)).toEqual(['22012', 'Error']);
    expect(JSON.stringify(await errorEvents())).not.toContain('Amina');
  });

  // ---------------------------------------------------------------- 2. recipients
  it('2. recipients: active owners only; suspended and invited members, the excluded actor and a business without an active owner get nothing', async () => {
    const w = await api.world();
    const suspended = await api.activeStaff(w.owner, 'ATTENDANT', 'Suspended');
    expect((await api.post(`/v1/staff/${suspended.membershipId}/suspend`, {}, w.owner.token)).statusCode).toBe(204);
    const invited = api.json<{ membership_id: string }>(await api.post('/v1/staff', { phone: '0799700901', display_name: 'Invited', role_preset: 'MANAGER' }, w.owner.token)).membership_id;
    const explicit = [suspended.membershipId, invited, w.manager.membershipId, w.attendant.membershipId];
    expect(await notify(w, flagged(), [{ to: explicit, channels: ['IN_APP'] }, { to: 'OWNERS', channels: ['IN_APP'] }], [w.attendant.membershipId])).toBe(2);
    expect(byId((await rowsOf(w.owner.businessId)).map((r) => r.recipient))).toEqual(byId([w.owner.membershipId, w.manager.membershipId]));
    // The owner as the actor: owners except the actor is nobody here.
    expect(await notify(w, flagged(), [{ to: 'OWNERS', channels: ['IN_APP'] }], [w.owner.membershipId])).toBe(0);
    // A business whose only owner is not active: nothing, no failure.
    const b = await api.world('Duka B');
    await asAdmin((c) => c.query("UPDATE membership SET status = 'SUSPENDED' WHERE id = $1", [b.owner.membershipId]));
    expect(await notify(b, flagged(), [{ to: 'OWNERS', channels: ['IN_APP', 'PUSH'] }])).toBe(0);
    expect(await rowsOf(b.owner.businessId)).toEqual([]);
    expect(await errorEvents()).toEqual([]);
  });

  // ---------------------------------------------------------------- 3. the list
  it('3. GET /v1/notifications: only the caller\'s IN_APP rows, newest first, unread filter, signed paging, limits, no business parameter', async () => {
    const w = await api.world();
    const mine: string[] = [];
    for (let n = 1; n <= 5; n++) {
      t.clock.advanceMinutes(1);
      await notify(w, flagged(randomUUID(), n), [{ to: [w.manager.membershipId], channels: ['IN_APP', 'PUSH'] }, { to: 'OWNERS', channels: ['IN_APP'] }]);
    }
    const all = await list(w.manager.token, '?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.notifications.map((n) => n.data.sale_number)).toEqual([5, 4, 3, 2, 1]); // newest first; the PUSH rows never listed
    mine.push(...all.body.notifications.map((n) => n.id));
    expect(all.body.notifications[0]).toEqual({
      id: mine[0],
      type: 'sale.flagged',
      data: { sale_id: expect.any(String), sale_number: 5, flags: ['STOCK_NEGATIVE'] },
      message: 'Sale #5 was flagged: Stock went negative.',
      created_at: expect.any(String),
      read_at: null,
    });
    // Paging by 2.
    const pages: number[][] = [];
    let cursor: string | null = null;
    do {
      const page = await list(w.manager.token, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status).toBe(200);
      pages.push(page.body.notifications.map((n) => n.data.sale_number as number));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(pages).toEqual([[5, 4], [3, 2], [1]]);
    // The unread filter, and a cursor bound to it.
    expect((await markRead(w.manager.token, { ids: [mine[1], mine[3]] })).statusCode).toBe(204);
    const unreadPage = await list(w.manager.token, '?unread=true&limit=2');
    expect(unreadPage.body.notifications.map((n) => n.data.sale_number)).toEqual([5, 3]);
    const switched = await list(w.manager.token, `?unread=false&cursor=${encodeURIComponent(unreadPage.body.next_cursor!)}`);
    expect([switched.status, switched.body.error?.code]).toEqual([422, 'VALIDATION_FAILED']);
    // The first character, which always changes the signed bytes. (The last one of a base64url
    // MAC carries only 4 bits: swapping A and B there left the cursor genuine in about 6% of
    // runs, found in G1f.)
    const first = unreadPage.body.next_cursor!;
    const tampered = `${first[0] === 'e' ? 'f' : 'e'}${first.slice(1)}`;
    expect((await list(w.manager.token, `?unread=true&cursor=${encodeURIComponent(tampered)}`)).status).toBe(422);
    for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?unread=yes', `?business_id=${w.owner.businessId}`]) {
      expect((await list(w.manager.token, q)).status, q).toBe(422);
    }
    // The owner sees only their own five; the attendant none.
    expect((await list(w.owner.token)).body.notifications).toHaveLength(5);
    expect((await list(w.attendant.token)).body.notifications).toEqual([]);
    // No name in any message or data.
    const text = JSON.stringify((await list(w.manager.token, '?limit=100')).body);
    for (const name of ['Baraka', 'Chebet', 'Amina']) expect(text).not.toContain(name);
    // A suspended member and a revoked device are refused.
    expect((await api.post(`/v1/staff/${w.manager.membershipId}/suspend`, {}, w.owner.token)).statusCode).toBe(204);
    expect((await list(w.manager.token)).body.error?.code).toBe('MEMBERSHIP_INACTIVE');
    expect((await api.call('DELETE', `/v1/devices/${w.attendant.deviceId}`, w.owner.token)).statusCode).toBe(204);
    expect((await list(w.attendant.token)).body.error?.code).toBe('DEVICE_REVOKED');
  });

  // ---------------------------------------------------------------- 4. unread count and mark read
  it('4. unread-count matches the list; marking read touches only the caller\'s rows, ignores others\' and unknown ids identically, all:true, repeats change nothing', async () => {
    const w = await api.world();
    for (let n = 1; n <= 3; n++) {
      t.clock.advanceMinutes(1);
      await notify(w, flagged(randomUUID(), n), [{ to: [w.manager.membershipId, w.attendant.membershipId], channels: ['IN_APP'] }]);
    }
    expect(await unread(w.manager.token)).toEqual({ unread: 3 });
    const managerIds = (await list(w.manager.token)).body.notifications.map((n) => n.id);
    const attendantIds = (await list(w.attendant.token)).body.notifications.map((n) => n.id);
    // The manager marks one of their own, one of the attendant's and an unknown id: one answer for all.
    const res = await markRead(w.manager.token, { ids: [managerIds[0], attendantIds[0], randomUUID()] });
    expect([res.statusCode, res.body]).toEqual([204, '']);
    expect(await unread(w.manager.token)).toEqual({ unread: 2 });
    expect(await unread(w.attendant.token)).toEqual({ unread: 3 }); // untouched
    const firstRead = (await list(w.manager.token)).body.notifications.find((n) => n.id === managerIds[0])!.read_at;
    t.clock.advanceMinutes(1);
    expect((await markRead(w.manager.token, { ids: [managerIds[0]] })).statusCode).toBe(204);
    expect((await list(w.manager.token)).body.notifications.find((n) => n.id === managerIds[0])!.read_at).toBe(firstRead); // not moved
    expect((await markRead(w.manager.token, { all: true })).statusCode).toBe(204);
    expect(await unread(w.manager.token)).toEqual({ unread: 0 });
    expect(await unread(w.attendant.token)).toEqual({ unread: 3 });
    expect((await list(w.manager.token, '?unread=true')).body.notifications).toEqual([]);
    expect((await markRead(w.manager.token, { all: true })).statusCode).toBe(204);
    // Bad bodies.
    for (const body of [{}, { ids: [], all: true }, { ids: [] }, { ids: ['not-a-uuid'] }, { all: false }, { ids: Array.from({ length: 101 }, () => randomUUID()) }, { ids: [managerIds[0]], all: true }]) {
      expect((await markRead(w.manager.token, body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
  });

  // ---------------------------------------------------------------- 5. isolation
  it('5. identical events in two businesses never mix; a member of B never sees A\'s notifications', async () => {
    const a = await api.world('Duka A');
    const b = await api.world('Duka B');
    const event = flagged();
    expect(await notify(a, event, [{ to: 'OWNERS', channels: ['IN_APP'] }])).toBe(1);
    expect(await notify(b, event, [{ to: 'OWNERS', channels: ['IN_APP'] }])).toBe(1);
    // A's member named as a recipient in B's transaction is not a member of B: nothing.
    expect(await notify(b, flagged(), [{ to: [a.manager.membershipId], channels: ['IN_APP'] }])).toBe(0);
    const aRows = (await list(a.owner.token)).body.notifications;
    const bRows = (await list(b.owner.token)).body.notifications;
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].id).not.toBe(bRows[0].id);
    expect((await markRead(b.owner.token, { ids: [aRows[0].id] })).statusCode).toBe(204);
    expect(await unread(a.owner.token)).toEqual({ unread: 1 });
    expect(await errorEvents()).toEqual([]);
  });

  // ---------------------------------------------------------------- concurrency
  it('concurrency: the same event notified 20 times at once makes exactly one row per recipient and channel', async () => {
    const w = await api.world();
    const event = flagged();
    const targets: NotificationTarget[] = [{ to: 'OWNERS', channels: ['IN_APP', 'PUSH'] }, { to: [w.manager.membershipId], channels: ['IN_APP'] }];
    const counts = await Promise.all(Array.from({ length: 20 }, () => notify(w, event, targets)));
    expect(counts.reduce((s, n) => s + n, 0)).toBe(3);
    expect(await rowsOf(w.owner.businessId)).toHaveLength(3);
    expect(await errorEvents()).toEqual([]);
  });
});
