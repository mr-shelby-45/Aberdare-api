import { randomUUID } from 'node:crypto';
import { SYNC_TABLE_NAMES } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type Result, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase T5: hardening (docs/phase-t-design.md section 11, T5 tests 1 to 3).
// T5 test 4 (grants) is the B5 inventory and T1 test 1; the crash-after-audit
// checks are T3 test 8 and T4 test 10 (decided in T5). The walkthrough
// (T5 test 5) is test/t5-walkthrough.spec.ts.

// Three fixed seeds on every run; T5_SEED=<n> replays one exactly.
const SEEDS = process.env.T5_SEED ? [Number(process.env.T5_SEED)] : [707, 808, 909];

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

interface Attendant {
  member: Member;
  vans: string[]; // every van ever assigned, the active one last
  seen: Set<string>; // every location id this attendant ever received
  cursor: string;
}
interface Shop {
  w: World;
  store: string;
  attendants: Attendant[];
  sales: string[];
}
type Row = { id: string } & Record<string, unknown>;
interface SnapshotPage {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}

describe('T5: field hardening', { timeout: 900_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  let testNo = 0;
  beforeAll(async () => {
    t = await startTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    // Its own IP per test: the auth routes' rate limit counts per IP, and the workloads log many staff in.
    testNo++;
    api = stockApi(t, `198.51.102.${testNo}`, 99_400_000 + testNo * 1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ok = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, token: string, body?: unknown): Promise<T> => {
    const res = await api.call(method, url, token, body);
    expect(res.statusCode, `${url} ${res.body}`).toBeLessThan(300);
    return res.json() as T;
  };
  async function van(w: World, a: Member, name: string): Promise<string> {
    return (await ok<{ id: string }>('POST', '/v1/locations', w.owner.token, { name, kind: 'FIELD', assigned_membership_id: a.membershipId })).id;
  }
  /** A whole snapshot (stamps the phone's sync); returns the start cursor and every location id received. */
  async function snapshot(a: Attendant): Promise<void> {
    let p = await ok<SnapshotPage>('GET', '/v1/sync/snapshot?limit=500', a.member.token);
    a.cursor = p.start_cursor!;
    for (;;) {
      noteLocations(a, p.table, p.rows);
      if (p.next_cursor) p = await ok<SnapshotPage>('GET', `/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=500`, a.member.token);
      else if (p.next_table) p = await ok<SnapshotPage>('GET', `/v1/sync/snapshot?table=${p.next_table}&limit=500`, a.member.token);
      else return;
    }
  }
  function noteLocations(a: Attendant, table: string, rows: Row[]): void {
    for (const r of rows) {
      if (table === 'location') a.seen.add(r.id);
      if (table === 'stock_balance' && typeof r.location_id === 'string') a.seen.add(r.location_id);
    }
  }
  /** The phone catches up: changes from its cursor (a fresh snapshot after a 410), and a stock read. */
  async function syncPhone(a: Attendant): Promise<void> {
    for (;;) {
      const res = await api.call('GET', `/v1/sync/changes?cursor=${encodeURIComponent(a.cursor)}&limit=500`, a.member.token);
      if (res.statusCode === 410) return snapshot(a);
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json() as { changes: { table: string; row?: Row }[]; next_cursor: string; has_more: boolean };
      for (const c of p.changes) if (c.row) noteLocations(a, c.table, [c.row]);
      a.cursor = p.next_cursor;
      if (!p.has_more) break;
    }
    const stock = await ok<{ balances: { location_id: string }[] }>('GET', '/v1/stock?include_zero=true', a.member.token);
    for (const b of stock.balances) a.seen.add(b.location_id);
  }
  async function shop(name: string, attendants: number): Promise<Shop> {
    const w = await api.world(name);
    const store = (await ok<{ id: string }>('POST', '/v1/locations', w.owner.token, { name: 'Store', kind: 'WAREHOUSE' })).id;
    for (const loc of [w.loc, store]) {
      const r = await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: loc, lines: [{ pack_type_id: w.maize.piece, quantity: 400 }, { pack_type_id: w.maize.carton, quantity: 40 }] }));
      expect(r.status).toBe('ACCEPTED');
    }
    const list: Attendant[] = [];
    for (let i = 0; i < attendants; i++) {
      const member = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', `Field ${i + 1}`);
      const v = await van(w, member, `Van ${i + 1}`);
      const issue = api.command('stock.issue', { from_location_id: w.loc, to_location_id: v, lines: [{ pack_type_id: w.maize.piece, quantity: 30 }, { pack_type_id: w.maize.carton, quantity: 4 }] });
      expect((await api.sendOne(w.manager.token, issue)).status).toBe('ACCEPTED');
      const a: Attendant = { member, vans: [v], seen: new Set(), cursor: '' };
      await snapshot(a);
      list.push(a);
    }
    return { w, store, attendants: list, sales: [] };
  }
  const count = (sql: string, params: unknown[] = []) => asAdmin(async (c) => Number((await c.query<{ n: string }>(sql, params)).rows[0].n));

  // ---------------------------------------------------------------- 1. randomized workload
  it.each(SEEDS)('1. randomized field workload, seed %i: ledgers, settlement windows and identities, scopes and businesses all hold', async (seed) => {
    const rnd = random(seed);
    const a = await shop('Duka A', 2);
    const b = await shop('Duka B', 1);
    const outcomes: { kind: string; result: Result }[] = [];
    let codeSeq = 0;
    const payments = () => {
      const roll = rnd.next();
      if (roll < 0.25) return [];
      if (roll < 0.6) return [{ method: 'CASH', amount: `${rnd.int(50, 500)}` }];
      if (roll < 0.85) return [{ method: 'MPESA', amount: `${rnd.int(50, 500)}`, mpesa_code: `T5${seed}${String(++codeSeq).padStart(5, '0')}` }];
      return [{ method: 'CASH', amount: '100' }, { method: 'MPESA', amount: `${rnd.int(10, 300)}`, mpesa_code: `T5${seed}${String(++codeSeq).padStart(5, '0')}` }];
    };

    for (let wave = 0; wave < 10; wave++) {
      if (wave === 5) {
        // The reassignment: F1's van is archived and F1 gets a new one; F1's offline sales into the old one still count.
        const f1 = a.attendants[0];
        await ok('PATCH', `/v1/locations/${f1.vans[0]}`, a.w.owner.token, { archived: true });
        const nv = await van(a.w, f1.member, 'Van 1b');
        expect((await api.sendOne(a.w.manager.token, api.command('stock.issue', { from_location_id: a.w.loc, to_location_id: nv, lines: [{ pack_type_id: a.w.maize.piece, quantity: 20 }, { pack_type_id: a.w.maize.carton, quantity: 3 }] }))).status).toBe('ACCEPTED');
        f1.vans.push(nv);
      }
      const work: Promise<{ kind: string; result: Result; sale?: { shop: Shop; id: string } }>[] = [];
      for (let i = 0; i < 20; i++) {
        const s = rnd.next() < 0.85 ? a : b;
        const at = rnd.pick(s.attendants);
        const active = at.vans[at.vans.length - 1];
        const someVan = rnd.next() < 0.8 ? active : rnd.pick(at.vans);
        const roll = rnd.next();
        if (roll < 0.35) {
          const id = randomUUID();
          const lines = [{ pack_type_id: rnd.pick([s.w.maize.piece, s.w.maize.carton]), quantity: rnd.int(1, 3), unit_price: rnd.pick(['180', '4200', '99.50']) }];
          const cmd = api.command('sale.create', { sale_id: id, local_ref: `T5-${wave}-${i}`, location_id: someVan, lines, payments: payments() });
          work.push(api.sendOne(at.member.token, cmd).then((result) => ({ kind: 'sale', result, sale: { shop: s, id } })));
        } else if (roll < 0.47) {
          const cmd = api.command('stock.issue', { from_location_id: rnd.pick([s.w.loc, s.store]), to_location_id: active, lines: [{ pack_type_id: rnd.pick([s.w.maize.piece, s.w.maize.carton]), quantity: rnd.int(1, 5) }] });
          work.push(api.sendOne(s.w.manager.token, cmd).then((result) => ({ kind: 'issue', result })));
        } else if (roll < 0.55) {
          const cmd = api.command('stock.return', { from_location_id: someVan, to_location_id: rnd.pick([s.w.loc, s.store]), lines: [{ pack_type_id: rnd.pick([s.w.maize.piece, s.w.maize.carton]), quantity: rnd.int(1, 3) }] });
          work.push(api.sendOne(rnd.pick([s.w.manager, s.w.owner]).token, cmd).then((result) => ({ kind: 'return', result })));
        } else if (roll < 0.63) {
          if (s.sales.length === 0) continue;
          const cmd = api.command('sale.void', { sale_id: rnd.pick(s.sales), reason: 'MISTAKE' });
          work.push(api.sendOne(s.w.manager.token, cmd).then((result) => ({ kind: 'void', result })));
        } else if (roll < 0.71) {
          // A settlement: the attendant's phone syncs first; the manager counts what is there, never below zero.
          await syncPhone(at);
          const pools = await asAdmin(async (c) => (await c.query<{ pack_type_id: string; quantity: number }>('SELECT pack_type_id, quantity FROM stock_balance WHERE location_id = $1', [someVan])).rows);
          const cmd = api.command('settlement.close', {
            settlement_id: randomUUID(),
            field_location_id: someVan,
            cash_received: `${rnd.int(0, 2000)}`,
            lines: pools.map((p) => ({ pack_type_id: p.pack_type_id, counted_quantity: Math.max(0, p.quantity + rnd.int(-1, 1)) })),
          });
          work.push(api.sendOne(s.w.manager.token, cmd).then((result) => ({ kind: 'settle', result })));
        } else if (roll < 0.83) {
          const loc = rnd.pick([s.w.loc, s.store]);
          const cmd =
            rnd.next() < 0.6
              ? api.command('stock.receive', { location_id: loc, lines: [{ pack_type_id: s.w.maize.piece, quantity: rnd.int(1, 20) }] })
              : api.command('stock.count', { location_id: loc, lines: [{ pack_type_id: s.w.maize.carton, expected_quantity: rnd.int(0, 40), counted_quantity: rnd.int(0, 40) }] });
          work.push(api.sendOne(s.w.manager.token, cmd).then((result) => ({ kind: 'stock', result })));
        } else {
          work.push(syncPhone(at).then(() => ({ kind: 'sync', result: { command_id: null, status: 'ACCEPTED' } })));
        }
      }
      for (const o of await Promise.all(work)) {
        outcomes.push({ kind: o.kind, result: o.result });
        if (o.sale && (o.result.status === 'ACCEPTED' || o.result.status === 'FLAGGED')) o.sale.shop.sales.push(o.sale.id);
      }
    }
    expect(outcomes.length, `seed ${seed}`).toBeGreaterThan(150);

    // Every command ended in an expected way: never FAILED (a deadlock, a pool timeout or a crash would be).
    const failures = JSON.stringify(t.logs.filter((l) => l.msg === 'sync command failed'));
    const allowed: Record<string, string[]> = {
      sale: ['ACCEPTED', 'FLAGGED'],
      issue: ['ACCEPTED', 'REJECTED:STOCK_INSUFFICIENT'],
      return: ['ACCEPTED', 'REJECTED:STOCK_INSUFFICIENT'],
      void: ['ACCEPTED', 'REJECTED:SALE_ALREADY_VOIDED'],
      settle: ['ACCEPTED'],
      stock: ['ACCEPTED', 'FLAGGED'],
      sync: ['ACCEPTED'],
    };
    for (const o of outcomes) {
      expect(o.result.status, `seed ${seed}: ${o.kind} FAILED; ${failures}`).not.toBe('FAILED');
      const key = o.result.status === 'REJECTED' ? `REJECTED:${o.result.reason}` : o.result.status;
      expect(allowed[o.kind], `seed ${seed}: ${o.kind} ended ${key} ${JSON.stringify(o.result).slice(0, 200)}`).toContain(key);
    }
    for (const kind of ['sale', 'issue', 'return', 'void', 'settle']) {
      expect(outcomes.some((o) => o.kind === kind && o.result.status !== 'REJECTED'), `seed ${seed}: no successful ${kind}`).toBe(true);
    }

    for (const s of [a, b]) {
      const biz = s.w.owner.businessId;
      // Every balance equals its ledger.
      expect(await api.integrity(biz), `seed ${seed}`).toEqual([]);
      // Every sale at a field location is in exactly one settlement, or in none yet (not visible to the location's latest).
      const misplaced = await count(
        `WITH st AS (
           SELECT fs.id, fs.field_location_id, fs.snapshot::pg_snapshot AS snap,
                  lag(fs.snapshot) OVER (PARTITION BY fs.field_location_id ORDER BY fs.sequence)::pg_snapshot AS prev,
                  row_number() OVER (PARTITION BY fs.field_location_id ORDER BY fs.sequence DESC) AS newest
             FROM field_settlement fs WHERE fs.business_id = $1)
         SELECT count(*) AS n FROM sale s JOIN location l ON l.id = s.location_id AND l.kind = 'FIELD'
          WHERE s.business_id = $1
            AND (SELECT count(*) FROM st WHERE st.field_location_id = s.location_id
                   AND pg_visible_in_snapshot(s.txid, st.snap) AND (st.prev IS NULL OR NOT pg_visible_in_snapshot(s.txid, st.prev)))
                <> CASE WHEN EXISTS (SELECT 1 FROM st WHERE st.field_location_id = s.location_id AND st.newest = 1 AND pg_visible_in_snapshot(s.txid, st.snap)) THEN 1 ELSE 0 END`,
        [biz],
      );
      expect(misplaced, `seed ${seed}: sales in the wrong number of settlements`).toBe(0);
      // Each settlement line: opening (the previous count) plus every window movement equals the expected
      // quantity, and the stored flows equal the ledger's.
      const broken = await asAdmin(
        async (c) =>
          (
            await c.query(
              `WITH st AS (
                 SELECT fs.id, fs.field_location_id, fs.snapshot::pg_snapshot AS snap,
                        lag(fs.snapshot) OVER (PARTITION BY fs.field_location_id ORDER BY fs.sequence)::pg_snapshot AS prev
                   FROM field_settlement fs WHERE fs.business_id = $1),
               ln AS (
                 SELECT l.*, st.field_location_id, st.snap, st.prev, fs.sequence,
                        coalesce(lag(l.counted_quantity) OVER (PARTITION BY st.field_location_id, l.pack_type_id ORDER BY fs.sequence), 0) AS opening
                   FROM field_settlement_line l JOIN st ON st.id = l.settlement_id JOIN field_settlement fs ON fs.id = l.settlement_id),
               flows AS (
                 SELECT ln.settlement_id, ln.pack_type_id,
                        coalesce(sum(m.quantity_change), 0) AS total,
                        coalesce(sum(m.quantity_change) FILTER (WHERE m.movement_type = 'TRANSFER_IN'), 0) AS issued,
                        coalesce(-sum(m.quantity_change) FILTER (WHERE m.movement_type = 'TRANSFER_OUT'), 0) AS returned,
                        coalesce(-sum(m.quantity_change) FILTER (WHERE m.movement_type = 'SALE'), 0) AS sold,
                        coalesce(sum(m.quantity_change) FILTER (WHERE m.movement_type = 'SALE_VOID'), 0) AS voided_back
                   FROM ln LEFT JOIN stock_movement m
                     ON m.location_id = ln.field_location_id AND m.pack_type_id = ln.pack_type_id AND m.settlement_id IS NULL
                    AND pg_visible_in_snapshot(m.txid, ln.snap) AND (ln.prev IS NULL OR NOT pg_visible_in_snapshot(m.txid, ln.prev))
                  GROUP BY ln.settlement_id, ln.pack_type_id)
               SELECT ln.settlement_id, ln.pack_type_id, ln.opening, f.total, ln.expected_quantity
                 FROM ln JOIN flows f ON f.settlement_id = ln.settlement_id AND f.pack_type_id = ln.pack_type_id
                WHERE ln.opening + f.total <> ln.expected_quantity
                   OR f.issued <> ln.issued OR f.returned <> ln.returned OR f.sold <> ln.sold OR f.voided_back <> ln.voided_back`,
              [biz],
            )
          ).rows,
      );
      expect(broken, `seed ${seed}: settlement identities`).toEqual([]);
      // Field attendants never received another location.
      for (const at of s.attendants) {
        await syncPhone(at);
        const assigned = await asAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM location WHERE assigned_membership_id = $1', [at.member.membershipId])).rows.map((r) => r.id));
        for (const id of at.seen) expect(assigned, `seed ${seed}: ${at.member.membershipId} saw ${id}`).toContain(id);
      }
    }
    expect(await count("SELECT count(*) AS n FROM field_settlement WHERE business_id = $1", [a.w.owner.businessId]), `seed ${seed}: settlements ran`).toBeGreaterThan(0);
    // Nothing crossed businesses.
    const crossed = await count(`
      SELECT (SELECT count(*) FROM stock_transfer x JOIN location l ON l.id IN (x.from_location_id, x.to_location_id) WHERE l.business_id <> x.business_id)
           + (SELECT count(*) FROM field_settlement f JOIN location l ON l.id = f.field_location_id WHERE l.business_id <> f.business_id)
           + (SELECT count(*) FROM field_settlement f JOIN membership m ON m.id IN (f.attendant_membership_id, f.closed_by_membership_id) WHERE m.business_id <> f.business_id)
           + (SELECT count(*) FROM field_settlement_line x JOIN pack_type p ON p.id = x.pack_type_id WHERE p.business_id <> x.business_id)
           + (SELECT count(*) FROM stock_movement m JOIN stock_transfer x ON x.id = m.transfer_id WHERE x.business_id <> m.business_id)
           + (SELECT count(*) FROM stock_movement m JOIN field_settlement f ON f.id = m.settlement_id WHERE f.business_id <> m.business_id)
           + (SELECT count(*) FROM location l JOIN membership m ON m.id = l.assigned_membership_id WHERE m.business_id <> l.business_id) AS n`);
    expect(crossed, `seed ${seed}`).toBe(0);
  });

  // ---------------------------------------------------------------- 2. logs
  it('2. no log line of a Phase T request contains a name, note, reference, amount, M-Pesa code or cursor', async () => {
    const s = await shop('Duka A', 1);
    const at = s.attendants[0];
    const firstLine = t.logs.length;
    const marker = { van: 'ZEBRA-T5-VAN', note: 'T5-NOTE-MARKER', reference: 'T5-REF-MARKER', code: 'T5LOGCODE9', amount: '4321.09', cash: '8765.43', product: 'ZEBRA-T5-PRODUCT' };
    const product = { product_id: randomUUID(), name: marker.product, pack_types: [{ pack_type_id: randomUUID(), name: 'piece', units_per_pack: 1, sell_price: '10' }] };
    expect((await api.sendOne(s.w.owner.token, api.command('product.create', product))).status).toBe('ACCEPTED');
    const v2 = await van(s.w, await api.activeStaff(s.w.owner, 'FIELD_ATTENDANT', 'Wafula'), marker.van);
    const vanId = at.vans[0];
    const sent = await api.send(s.w.manager.token, [
      api.command('stock.issue', { from_location_id: s.w.loc, to_location_id: vanId, reference: marker.reference, note: marker.note, lines: [{ pack_type_id: s.w.maize.piece, quantity: 2 }] }),
      api.command('stock.return', { from_location_id: vanId, to_location_id: s.w.loc, reference: marker.reference, note: marker.note, lines: [{ pack_type_id: s.w.maize.piece, quantity: 1 }] }),
    ]);
    expect(sent.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    const saleCmd = api.command('sale.create', { sale_id: randomUUID(), local_ref: 'L', location_id: vanId, lines: [{ pack_type_id: s.w.maize.piece, quantity: 1, unit_price: marker.amount }], payments: [{ method: 'MPESA', amount: marker.amount, mpesa_code: marker.code }] });
    expect((await api.sendOne(at.member.token, saleCmd)).status).toBe('ACCEPTED');
    await syncPhone(at);
    const pools = await asAdmin(async (c) => (await c.query<{ pack_type_id: string; quantity: number }>('SELECT pack_type_id, quantity FROM stock_balance WHERE location_id = $1', [vanId])).rows);
    const close = api.command('settlement.close', { settlement_id: randomUUID(), field_location_id: vanId, cash_received: marker.cash, note: marker.note, lines: pools.map((p) => ({ pack_type_id: p.pack_type_id, counted_quantity: Math.max(0, p.quantity) })) });
    expect((await api.sendOne(s.w.manager.token, close)).status).toBe('ACCEPTED');
    // A rejected close (missing lines) with the same markers.
    expect((await api.sendOne(s.w.manager.token, api.command('settlement.close', { settlement_id: randomUUID(), field_location_id: vanId, cash_received: marker.cash, note: marker.note, lines: [] }))).status).toBe('REJECTED');
    const settlementId = (close.payload as { settlement_id: string }).settlement_id;
    const cursors: string[] = [at.cursor];
    for (const url of [`/v1/field/settlements/preview?location_id=${vanId}`, '/v1/field/settlements', `/v1/field/settlements/${settlementId}`, `/v1/stock/movements?location_id=${vanId}`, '/v1/locations']) {
      await ok('GET', url, s.w.manager.token);
    }
    const changes = await ok<{ next_cursor: string }>('GET', `/v1/sync/changes?cursor=${encodeURIComponent(at.cursor)}`, at.member.token);
    cursors.push(changes.next_cursor);
    expect(v2).toBeTruthy();

    const raw = t.rawLogs();
    for (const [what, value] of Object.entries(marker)) expect(raw.includes(value), `${what} appears in the logs`).toBe(false);
    for (const c of cursors) expect(raw.includes(c.slice(0, 40)), 'a cursor appears in the logs').toBe(false);
    expect(raw.includes(`"${STAFF_PIN}"`)).toBe(false);
    const mine = t.logs.slice(firstLine);
    expect(mine.length).toBeGreaterThan(10);
    for (const line of mine) {
      const text = JSON.stringify(line);
      for (const key of ['"lines"', '"note"', '"reference"', '"cash_received"', '"counted_quantity"', '"mpesa_code"']) expect(text.includes(key), `${key} in a log line`).toBe(false);
    }
  });

  // ---------------------------------------------------------------- 3. audit
  it('3. every Phase T audit action is written exactly once per event, by the acting member; refused commands write none', async () => {
    const s = await shop('Duka A', 1);
    const at = s.attendants[0];
    const vanId = at.vans[0];
    const before = await count("SELECT count(*) AS n FROM audit_log WHERE business_id = $1 AND (action LIKE 'stock.issued' OR action LIKE 'stock.returned' OR action LIKE 'settlement.%' OR action LIKE 'location.%')", [s.w.owner.businessId]);
    const step = async (who: Member, type: string, payload: object) => {
      t.clock.advanceMinutes(1);
      return api.sendOne(who.token, api.command(type, payload));
    };
    await step(s.w.manager, 'stock.issue', { from_location_id: s.w.loc, to_location_id: vanId, lines: [{ pack_type_id: s.w.maize.piece, quantity: 2 }] });
    await step(s.w.owner, 'stock.return', { from_location_id: vanId, to_location_id: s.store, lines: [{ pack_type_id: s.w.maize.piece, quantity: 1 }] });
    await syncPhone(at);
    const pools = await asAdmin(async (c) => (await c.query<{ pack_type_id: string; quantity: number }>('SELECT pack_type_id, quantity FROM stock_balance WHERE location_id = $1', [vanId])).rows);
    await step(s.w.manager, 'settlement.close', { settlement_id: randomUUID(), field_location_id: vanId, cash_received: '0', lines: pools.map((p) => ({ pack_type_id: p.pack_type_id, counted_quantity: Math.max(0, p.quantity) })) });
    t.clock.advanceMinutes(1);
    await ok('PATCH', `/v1/locations/${vanId}`, s.w.owner.token, { archived: true });
    // Refused: a short issue, a return to a field location, a close of a shop.
    await step(s.w.manager, 'stock.issue', { from_location_id: s.w.loc, to_location_id: vanId, lines: [{ pack_type_id: s.w.maize.piece, quantity: 1 }] });
    await step(s.w.manager, 'stock.return', { from_location_id: vanId, to_location_id: vanId, lines: [{ pack_type_id: s.w.maize.piece, quantity: 1 }] });
    await step(s.w.manager, 'settlement.close', { settlement_id: randomUUID(), field_location_id: s.w.loc, cash_received: '0', lines: [] });

    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string; metadata: Record<string, unknown> }>(
          `SELECT action, actor_membership_id, metadata FROM audit_log
            WHERE business_id = $1 AND action IN ('stock.issued', 'stock.returned', 'settlement.closed', 'location.archived')
            ORDER BY occurred_at, action`,
          [s.w.owner.businessId],
        )).rows,
    );
    // shop() issued once per attendant before the counted part.
    expect(rows.map((r) => [r.action, r.actor_membership_id])).toEqual([
      ['stock.issued', s.w.manager.membershipId],
      ['stock.issued', s.w.manager.membershipId],
      ['stock.returned', s.w.owner.membershipId],
      ['settlement.closed', s.w.manager.membershipId],
      ['location.archived', s.w.owner.membershipId],
    ]);
    expect(rows[4].metadata).toEqual({ kind: 'FIELD', assigned_membership_id: at.member.membershipId });
    expect((await count("SELECT count(*) AS n FROM audit_log WHERE business_id = $1 AND (action LIKE 'stock.issued' OR action LIKE 'stock.returned' OR action LIKE 'settlement.%' OR action LIKE 'location.%')", [s.w.owner.businessId])) - before).toBe(4);
    expect(SYNC_TABLE_NAMES).not.toContain('field_settlement'); // settlements are not synced
  });
});
