import { createHash, randomUUID } from 'node:crypto';
import type { FakePushAnswer } from '../src/integrations/push/fake-push.sender.js';
import type { PushMessage } from '../src/integrations/push/push.sender.js';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';
import { type TestWorker, startTestWorker } from './helpers/worker.js';

// Phase F6: hardening (docs/phase-f-design.md section 11, F6 tests 1 and 2).
// F6 test 3 (grants) is the B5 inventory and F1 test 1; the walkthrough
// (F6 test 4) is test/f6-walkthrough.spec.ts.

// Three fixed seeds on every run; F6_SEED=<n> replays one exactly.
const SEEDS = process.env.F6_SEED ? [Number(process.env.F6_SEED)] : [1001, 2002, 3003];

/** mulberry32: a tiny seeded random generator, so a failing run can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  return { next, int, pick };
}

type Fate = 'OK' | 'RETRY_THEN_OK' | 'PERMANENT' | 'DEAD_TOKEN';
/** Each push's fate is fixed by the seed and its notification id, so it does not depend on timing. */
function fateOf(seed: number, notificationId: string): Fate {
  const u = createHash('sha256').update(`${seed}:${notificationId}`).digest().readUInt32BE(0) / 4294967296;
  return u < 0.55 ? 'OK' : u < 0.75 ? 'RETRY_THEN_OK' : u < 0.87 ? 'PERMANENT' : 'DEAD_TOKEN';
}

interface Shop {
  w: World;
  field: Member;
  van: string;
  attendantSales: string[];
}
interface Expected {
  businessId: string;
  type: string;
  ref: string;
  recipient: string;
  channel: string;
}

describe('F6: notification hardening', { timeout: 900_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let testNo = 0;
  const workers: TestWorker[] = [];

  beforeAll(async () => {
    t = await startTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    // Its own IP and phone range per test: the auth routes are rate limited per IP.
    testNo++;
    api = stockApi(t, `198.51.103.${testNo}`, 99_500_000 + testNo * 1000);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (workers.length > 0) await workers.pop()!.shutdown();
  });

  async function shop(name: string, tokens: { owner: boolean }): Promise<Shop> {
    const w = await api.world(name);
    const field = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Field');
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: field.membershipId }, w.owner.token)).id;
    const receive = await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 200 }, { pack_type_id: w.maize.carton, quantity: 40 }] }));
    expect(receive.status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('stock.issue', { from_location_id: w.loc, to_location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 40 }] }))).status).toBe('ACCEPTED');
    expect((await api.call('PUT', '/v1/devices/me/push-token', w.manager.token, { push_token: `tok-${randomUUID()}` })).statusCode).toBe(204);
    if (tokens.owner) expect((await api.call('PUT', '/v1/devices/me/push-token', w.owner.token, { push_token: `tok-${randomUUID()}` })).statusCode).toBe(204);
    return { w, field, van, attendantSales: [] };
  }
  const approval = async (s: Shop, purpose: 'STOCK_CONVERT' | 'SALE_VOID') => {
    const res = await api.post('/v1/stock/approvals', { approver_membership_id: s.w.manager.membershipId, approver_pin: STAFF_PIN, purpose }, s.w.attendant.token);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ approval_id: string }>(res).approval_id;
  };
  async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 60_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  /** Every IN_APP id a member can read, through all pages. */
  async function readAll(m: Member): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api.call('GET', `/v1/notifications?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, m.token);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as { notifications: { id: string }[]; next_cursor: string | null };
      ids.push(...page.notifications.map((n) => n.id));
      cursor = page.next_cursor;
    } while (cursor);
    return ids.sort();
  }

  // ---------------------------------------------------------------- 1. randomized workload
  it.each(SEEDS)('1. randomized notification workload, seed %i: one notification per intended recipient and channel, every push SENT or DEAD as its fate says, nothing crossed or leaked', async (seed) => {
    const rnd = random(seed);
    const a = await shop('Duka A', { owner: true });
    const b = await shop('Duka B', { owner: false }); // B's owner has no push token: NO_PUSH_TOKEN
    const fates = new Map<string, Fate>();
    const calls = new Map<string, number>();
    // The first pushes asked get fixed fates, so every run covers each case; the rest by the seed's hash.
    // The device of the fixed permanent failure is never answered DEAD_TOKEN: a dead token there
    // would clear it before the retries, so the push would end NO_PUSH_TOKEN and no run would see a
    // PUSH_FAILED (found in G1f: seed 1001 failed 2 of 3 replays). Its DEAD_TOKEN goes to the next
    // push on another device.
    const fixed: Fate[] = ['PERMANENT', 'DEAD_TOKEN', 'RETRY_THEN_OK'];
    let permanentToken: string | null = null;
    const decide = (push: PushMessage, _call: number, token: string): FakePushAnswer => {
      let fate = fates.get(push.notificationId);
      if (fate === undefined) {
        const next = fixed[0];
        if (next !== undefined && !(next === 'DEAD_TOKEN' && token === permanentToken)) {
          fate = fixed.shift()!;
          if (fate === 'PERMANENT') permanentToken = token;
        } else {
          fate = fateOf(seed, push.notificationId);
        }
        if (fate === 'DEAD_TOKEN' && token === permanentToken) fate = 'OK';
        fates.set(push.notificationId, fate);
      }
      const call = (calls.get(push.notificationId) ?? 0) + 1;
      calls.set(push.notificationId, call);
      if (fate === 'PERMANENT') return 'FAILED';
      if (fate === 'DEAD_TOKEN') return 'DEAD_TOKEN';
      if (fate === 'RETRY_THEN_OK' && call === 1) return 'RETRY';
      return 'OK';
    };
    const live = await startTestWorker(t.clock, { schedules: false, listen: true, configurePush: (p) => (p.decide = decide) });
    workers.push(live);

    const expected: Expected[] = [];
    const add = (s: Shop, type: string, ref: string, recipient: string, channels: string[]) => {
      for (const channel of channels) expected.push({ businessId: s.w.owner.businessId, type, ref, recipient, channel });
    };
    const outcomes: { kind: string; status: string; reason?: string }[] = [];
    const op = async (s: Shop): Promise<void> => {
      const roll = rnd.next();
      if (roll < 0.35) {
        // A sale by the attendant or (rarely) the owner; a large one oversells.
        const byOwner = rnd.next() < 0.15;
        const who = byOwner ? s.w.owner : s.w.attendant;
        const qty = rnd.next() < 0.3 ? rnd.int(50, 90) : 1;
        const payments = rnd.next() < 0.2 ? [{ method: 'CASH', amount: String(180 * qty + 20) }] : [{ method: 'CASH', amount: String(180 * qty) }];
        const saleId = randomUUID();
        const r = await api.sendOne(who.token, api.command('sale.create', { sale_id: saleId, local_ref: 'F6', location_id: s.w.loc, lines: [{ pack_type_id: s.w.maize.piece, quantity: qty, unit_price: '180' }], payments }));
        outcomes.push({ kind: 'sale', status: r.status, reason: r.reason });
        if (r.status === 'FLAGGED' && !byOwner) add(s, 'sale.flagged', saleId, s.w.owner.membershipId, ['IN_APP']);
        if ((r.status === 'ACCEPTED' || r.status === 'FLAGGED') && !byOwner) s.attendantSales.push(saleId);
      } else if (roll < 0.55) {
        // A conversion: by the manager, or by the attendant with the manager's PIN.
        const withApproval = rnd.next() < 0.5;
        const approvalId = withApproval ? await approval(s, 'STOCK_CONVERT') : undefined;
        const who = withApproval ? s.w.attendant : s.w.manager;
        const r = await api.sendOne(who.token, api.command('stock.convert', { location_id: s.w.loc, from_pack_type_id: s.w.maize.carton, to_pack_type_id: s.w.maize.piece, quantity: 1, ...(approvalId ? { approval_id: approvalId } : {}) }));
        outcomes.push({ kind: 'convert', status: r.status, reason: r.reason });
        if (r.status === 'ACCEPTED') {
          add(s, 'stock.converted', who.membershipId, s.w.owner.membershipId, ['IN_APP']);
          if (approvalId) {
            add(s, 'approval.used', approvalId, s.w.manager.membershipId, ['IN_APP', 'PUSH']);
            add(s, 'approval.used', approvalId, s.w.owner.membershipId, ['IN_APP']);
          }
        }
      } else if (roll < 0.7) {
        // A void of one of the attendant's sales, with the manager's PIN.
        const saleId = s.attendantSales.shift();
        if (!saleId) return;
        const approvalId = await approval(s, 'SALE_VOID');
        const r = await api.sendOne(s.w.attendant.token, api.command('sale.void', { sale_id: saleId, reason: 'MISTAKE', approval_id: approvalId }));
        outcomes.push({ kind: 'void', status: r.status, reason: r.reason });
        if (r.status === 'ACCEPTED') {
          add(s, 'approval.used', approvalId, s.w.manager.membershipId, ['IN_APP', 'PUSH']);
          add(s, 'approval.used', approvalId, s.w.owner.membershipId, ['IN_APP']);
        }
      } else if (roll < 0.85) {
        // A settlement of the van: counts near the balance, cash random.
        expect((await api.call('GET', '/v1/sync/snapshot?limit=1', s.field.token)).statusCode).toBe(200);
        const pools = await asAdmin(async (c) => (await c.query<{ pack_type_id: string; quantity: number }>('SELECT pack_type_id, quantity FROM stock_balance WHERE location_id = $1', [s.van])).rows);
        const settlementId = randomUUID();
        const r = await api.sendOne(
          s.w.manager.token,
          api.command('settlement.close', {
            settlement_id: settlementId,
            field_location_id: s.van,
            cash_received: rnd.next() < 0.5 ? '0' : String(rnd.int(1, 300)),
            lines: pools.map((p) => ({ pack_type_id: p.pack_type_id, counted_quantity: Math.max(0, p.quantity + (rnd.next() < 0.5 ? 0 : rnd.int(-1, 1))) })),
          }),
        );
        outcomes.push({ kind: 'settle', status: r.status, reason: r.reason });
        const data = r.result as { cash_variance: string; lines: { variance: number }[] } | undefined;
        if (r.status === 'ACCEPTED' && data && (data.cash_variance !== '0.00' || data.lines.some((l) => l.variance !== 0))) {
          add(s, 'settlement.variance', settlementId, s.w.owner.membershipId, ['IN_APP', 'PUSH']);
        }
      } else {
        // An ordinary sale at the van by the field attendant (no event unless flagged; the van may be empty).
        const saleId = randomUUID();
        const r = await api.sendOne(s.field.token, api.command('sale.create', { sale_id: saleId, local_ref: 'V', location_id: s.van, lines: [{ pack_type_id: s.w.maize.piece, quantity: 1, unit_price: '180' }], payments: [{ method: 'CASH', amount: '180' }] }));
        outcomes.push({ kind: 'van sale', status: r.status, reason: r.reason });
        if (r.status === 'FLAGGED') add(s, 'sale.flagged', saleId, s.w.owner.membershipId, ['IN_APP']);
      }
    };
    // A phone whose token died registers a new one, as a real app does (a reinstall).
    const tokenMembers = [a.w.owner.membershipId, a.w.manager.membershipId, b.w.manager.membershipId];
    const refreshTokens = () =>
      asAdmin((c) => c.query("UPDATE device SET push_token = 'tok-' || gen_random_uuid() WHERE registered_by_membership_id = ANY($1) AND push_token IS NULL AND NOT is_shared AND status = 'ACTIVE'", [tokenMembers]));
    for (let wave = 0; wave < 10; wave++) {
      await refreshTokens();
      await Promise.all(Array.from({ length: 15 }, () => op(rnd.next() < 0.7 ? a : b)));
    }
    // One stale phone per business, noticed by the stale-device job (run twice: one notification).
    for (const s of [a, b]) {
      await asAdmin((c) => c.query('UPDATE device SET last_sync_at = $2 WHERE id = $1', [s.w.attendant.deviceId, new Date(t.clock.now().getTime() - 4 * 86_400_000)]));
      expect(await live.scheduled.staleDevices(s.w.owner.businessId)).toBe(1);
      expect(await live.scheduled.staleDevices(s.w.owner.businessId)).toBe(1);
      add(s, 'device.stale', String(s.w.attendant.deviceId), s.w.owner.membershipId, ['IN_APP']);
    }
    // Only expected outcomes: never FAILED.
    const failures = JSON.stringify(t.logs.filter((l) => l.msg === 'sync command failed'));
    for (const o of outcomes) expect(o.status, `seed ${seed}: ${o.kind} ${o.reason ?? ''} ${failures}`).not.toBe('FAILED');
    for (const kind of ['sale', 'convert', 'void', 'settle']) expect(outcomes.some((o) => o.kind === kind && o.status !== 'REJECTED'), `seed ${seed}: no ${kind}`).toBe(true);

    // Each member reads exactly their own IN_APP rows (before the Clock moves: access tokens last 15 minutes).
    for (const s of [a, b]) {
      for (const m of [s.w.owner, s.w.manager, s.w.attendant, s.field]) {
        const mine = await asAdmin(async (c) => (await c.query<{ id: string }>("SELECT id FROM notification WHERE recipient_membership_id = $1 AND channel = 'IN_APP' ORDER BY id", [m.membershipId])).rows.map((r) => r.id));
        expect(await readAll(m), `seed ${seed}: ${m.membershipId}`).toEqual(mine);
      }
    }

    // Drain: the live worker stops (letting running jobs finish); a second worker, driven by hand, moves the Clock through every retry.
    await live.shutdown();
    workers.splice(workers.indexOf(live), 1);
    const drain = await startTestWorker(t.clock, { schedules: false, listen: false, configurePush: (p) => (p.decide = decide) });
    workers.push(drain);
    const delivery = drain.app.get(NotificationDeliveryService);
    const open = () => asAdmin(async (c) => Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM notification WHERE status IN ('PENDING', 'SENDING')")).rows[0].n));
    for (let round = 0; round < 20 && (await open()) > 0; round++) {
      t.clock.advance(6 * 60_000);
      await refreshTokens();
      await drain.jobs.sweepAll();
      for (const s of [a, b]) while ((await delivery.dispatchBusiness(s.w.owner.businessId)).more);
    }
    await waitFor(async () => (await open()) === 0, 'every push to finish');

    // Exactly the intended notifications: per business, type, reference, recipient and channel.
    const rows = await asAdmin(
      async (c) =>
        (
          await c.query<{ business_id: string; type: string; dedupe_key: string; recipient: string; channel: string; data: Record<string, unknown>; id: string; status: string; last_error: string | null; attempts: number }>(
            'SELECT business_id, type, dedupe_key, recipient_membership_id AS recipient, channel, data, id, status, last_error, attempts FROM notification',
          )
        ).rows,
    );
    const refOf = (r: (typeof rows)[number]) =>
      r.type === 'stock.converted' ? String(r.data.converter_membership_id) : r.type === 'device.stale' ? String(r.data.device_id) : r.dedupe_key.split(':')[1];
    const key = (e: Expected | { businessId: string; type: string; ref: string; recipient: string; channel: string }) => `${e.businessId}|${e.type}|${e.ref}|${e.recipient}|${e.channel}`;
    const actualKeys = rows.map((r) => key({ businessId: r.business_id, type: r.type, ref: refOf(r), recipient: r.recipient, channel: r.channel })).sort();
    expect(actualKeys, `seed ${seed}`).toEqual(expected.map(key).sort());
    // Nothing crossed businesses: every recipient is a member of the row's business.
    const crossed = await asAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM notification n JOIN membership m ON m.id = n.recipient_membership_id WHERE m.business_id <> n.business_id')).rows[0].n));
    expect(crossed).toBe(0);
    // Every push ended as its fate says; a member without a token (or whose token died) gets NO_PUSH_TOKEN.
    const pushes = rows.filter((r) => r.channel === 'PUSH');
    expect(pushes.length, `seed ${seed}: pushes`).toBeGreaterThan(0);
    // A member's token dies when any push to them is answered DEAD_TOKEN; their later or retried pushes then find none.
    const tokenDied = new Set(pushes.filter((p) => fates.get(p.id) === 'DEAD_TOKEN').map((p) => p.recipient));
    const noToken = { status: 'DEAD', last_error: 'NO_PUSH_TOKEN' };
    for (const p of pushes) {
      const fate = fates.get(p.id);
      const allowed =
        fate === undefined
          ? [noToken]
          : fate === 'DEAD_TOKEN'
            ? [{ status: 'DEAD', last_error: 'DEAD_TOKEN' }]
            : fate === 'PERMANENT'
              ? [{ status: 'DEAD', last_error: 'PUSH_FAILED', attempts: 3 }, ...(tokenDied.has(p.recipient) ? [noToken] : [])]
              : fate === 'RETRY_THEN_OK'
                ? [{ status: 'SENT', last_error: null }, ...(tokenDied.has(p.recipient) ? [noToken] : [])]
                : [{ status: 'SENT', last_error: null }];
      const got = { status: p.status, last_error: p.last_error, ...(p.last_error === 'PUSH_FAILED' ? { attempts: p.attempts } : {}) };
      expect(allowed, `seed ${seed}: push ${p.id} fate ${fate} ended ${JSON.stringify(got)}`).toContainEqual(got);
    }
    // Every PERMANENT push that used its 3 attempts wrote exactly one error_event; nothing else did.
    const failed = pushes.filter((p) => p.last_error === 'PUSH_FAILED').length;
    expect(failed, `seed ${seed}: permanent failures`).toBeGreaterThan(0);
    expect(await asAdmin(async (c) => (await c.query<{ source: string; code: string }>('SELECT source, code FROM error_event')).rows), `seed ${seed}: error events`).toEqual(
      Array.from({ length: failed }, () => ({ source: 'notifications.push', code: 'PUSH_FAILED' })),
    );
    // Every token answered DEAD_TOKEN was cleared (the phones may have registered new ones since).
    const deadTokens = [...live.push.outbox, ...drain.push.outbox].filter((o) => o.answer === 'DEAD_TOKEN').map((o) => o.token);
    expect(deadTokens.length, `seed ${seed}: dead tokens`).toBeGreaterThan(0);
    expect((await asAdmin((c) => c.query('SELECT id FROM device WHERE push_token = ANY($1)', [deadTokens]))).rows, `seed ${seed}`).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. logs
  it('2. no log line, notification data or error_event holds a name, note, push token or message text', async () => {
    const marker = { owner: 'ZEBRA-F6-OWNER', note: 'ZEBRA-F6-NOTE', token: 'tok-ZEBRA-F6-SECRET', product: 'ZEBRA-F6-PRODUCT' };
    const s = await shop('ZEBRA-F6-SHOP', { owner: true });
    await asAdmin((c) => c.query('UPDATE membership SET display_name = $2 WHERE id = $1', [s.w.owner.membershipId, marker.owner]));
    expect((await api.call('PUT', '/v1/devices/me/push-token', s.w.manager.token, { push_token: marker.token })).statusCode).toBe(204);
    await api.newProduct(s.w.owner, marker.product);
    const wk = await startTestWorker(t.clock, { schedules: false, listen: true });
    workers.push(wk);
    wk.push.script(marker.token, 'RETRY');
    const firstLine = t.logs.length;
    // An oversell, a conversion and a void with approvals, and a settlement with a note and a variance.
    const saleId = randomUUID();
    expect((await api.sendOne(s.w.attendant.token, api.command('sale.create', { sale_id: saleId, local_ref: 'L', location_id: s.w.loc, note: marker.note, lines: [{ pack_type_id: s.w.maize.piece, quantity: 900, unit_price: '180' }] }))).status).toBe('FLAGGED');
    const convertApproval = await approval(s, 'STOCK_CONVERT');
    expect((await api.sendOne(s.w.attendant.token, api.command('stock.convert', { location_id: s.w.loc, from_pack_type_id: s.w.maize.carton, to_pack_type_id: s.w.maize.piece, quantity: 1, note: marker.note, approval_id: convertApproval }))).status).toBe('ACCEPTED');
    const voidApproval = await approval(s, 'SALE_VOID');
    expect((await api.sendOne(s.w.attendant.token, api.command('sale.void', { sale_id: saleId, reason: 'OTHER', note: marker.note, approval_id: voidApproval }))).status).toBe('ACCEPTED');
    expect((await api.call('GET', '/v1/sync/snapshot?limit=1', s.field.token)).statusCode).toBe(200);
    expect((await api.sendOne(s.w.manager.token, api.command('settlement.close', { settlement_id: randomUUID(), field_location_id: s.van, cash_received: '12', note: marker.note, lines: [{ pack_type_id: s.w.maize.piece, counted_quantity: 39 }] }))).status).toBe('ACCEPTED');
    await waitFor(() => wk.lines().includes('"msg":"push delivered"'), 'a delivery');
    t.clock.advance(30_000);
    await wk.jobs.sweepAll();
    await waitFor(async () => (await asAdmin(async (c) => Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM notification WHERE status IN ('PENDING', 'SENDING')")).rows[0].n))) === 0, 'deliveries');
    for (const list of [s.w.owner, s.w.manager]) expect((await api.call('GET', '/v1/notifications', list.token)).statusCode).toBe(200);

    const apiLines = t.logs.slice(firstLine).map((l) => JSON.stringify(l)).join('\n');
    const raw = `${apiLines}\n${wk.lines()}`;
    for (const [what, value] of Object.entries({ ...marker, flagged: 'was flagged', approved: 'Your PIN approved', settlement: 'field settlement closed' })) {
      expect(raw.includes(value), `${what} in a log line`).toBe(false);
    }
    expect(wk.lines()).toContain('"msg":"push delivered"');
    const stored = JSON.stringify(
      await asAdmin(async (c) => ({ data: (await c.query('SELECT data, last_error FROM notification')).rows, errors: (await c.query('SELECT source, code, detail FROM error_event')).rows })),
    );
    for (const value of Object.values(marker)) expect(stored.includes(value), `${value} stored in data or error_event`).toBe(false);
  });
});
