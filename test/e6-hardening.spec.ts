import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { SalesRepository } from '../src/modules/sales/sales.repository.js';
import { SYNC_TABLE_NAMES } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';
import { type Member, OWNER_PIN, type Result, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase E6: hardening (docs/phase-e-design.md section 13, E6 tests 1 to 4).
// The walkthrough (E6 test 5) is test/e6-walkthrough.spec.ts.

// Three fixed seeds on every run; E6_SEED=<n> replays one exactly.
const SEEDS = process.env.E6_SEED ? [Number(process.env.E6_SEED)] : [404, 505, 606];

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

interface Shop extends World {
  // pack type id by units: 1 piece, 24 carton, 48 case
  pack: Record<1 | 24 | 48, string>;
}
interface SaleRef {
  id: string;
  by: Member;
}
type Row = { id: string } & Record<string, unknown>;
interface SnapshotPage {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}

describe('E6: hardening', { timeout: 600_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.184', 98_400_000);
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

  /** A business whose maize also comes in a case of 48, with opening stock. */
  async function shop(name: string): Promise<Shop> {
    const w = await api.world(name);
    const caseId = randomUUID();
    const upsert = api.command('pack_type.upsert', { pack_type_id: caseId, product_id: w.maize.productId, name: 'case of 48', units_per_pack: 48, sell_price: '8000' });
    expect((await api.sendOne(w.owner.token, upsert)).status).toBe('ACCEPTED');
    const s: Shop = { ...w, pack: { 1: w.maize.piece, 24: w.maize.carton, 48: caseId } };
    const opening = api.command('stock.receive', {
      location_id: s.loc,
      lines: [
        { pack_type_id: s.pack[48], quantity: 20 },
        { pack_type_id: s.pack[24], quantity: 40 },
        { pack_type_id: s.pack[1], quantity: 200 },
      ],
    });
    expect((await api.sendOne(s.manager.token, opening)).status).toBe('ACCEPTED');
    return s;
  }
  const mint = (caller: Member, approver: Member, pin = STAFF_PIN) =>
    api.post('/v1/stock/approvals', { approver_membership_id: approver.membershipId, approver_pin: pin, purpose: 'SALE_VOID' }, caller.token);
  async function approval(caller: Member, approver: Member): Promise<string> {
    const res = await mint(caller, approver);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ approval_id: string }>(res).approval_id;
  }
  const count = (sql: string, params: unknown[] = []) => asAdmin(async (c) => Number((await c.query<{ n: string }>(sql, params)).rows[0].n));
  async function snapshotSaleIds(token: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let res = await api.call('GET', '/v1/sync/snapshot?limit=500', token);
    for (;;) {
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json() as SnapshotPage;
      if (p.table === 'sale') for (const r of p.rows) ids.add(r.id);
      if (p.next_cursor) res = await api.call('GET', `/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=500`, token);
      else if (p.next_table) res = await api.call('GET', `/v1/sync/snapshot?table=${p.next_table}&limit=500`, token);
      else return ids;
    }
  }

  // ---------------------------------------------------------------- 1. randomized workload
  it.each(SEEDS)('1. randomized sales workload, seed %i: ledgers, numbering, totals, payments, voids and approvals all add up', async (seed) => {
    const rnd = random(seed);
    const shops = [await shop('Duka A'), await shop('Duka B')];
    const sales = new Map<Shop, SaleRef[]>(shops.map((s) => [s, []]));
    const codes = new Map<Shop, string[]>(shops.map((s) => [s, []]));
    const sizes = [1, 24, 48] as const;
    const prices = ['100', '33.33', '0.10', '250.50', '4200'] as const;
    const outcomes: { kind: string; result: Result | null }[] = [];
    let approvedVoids = 0;

    const payment = (s: Shop) => {
      const amount = `${rnd.int(1, 300)}.${String(rnd.int(0, 99)).padStart(2, '0')}`;
      if (rnd.next() < 0.5) return { method: 'CASH', amount };
      const used = codes.get(s)!;
      // About a fifth reuse a code this business has used (a duplicate, still saved).
      const code = used.length > 0 && rnd.next() < 0.2 ? rnd.pick(used) : `E6${seed}${String(rnd.int(0, 999_999)).padStart(6, '0')}`;
      used.push(code);
      return { method: 'MPESA', amount, mpesa_code: code };
    };

    for (let wave = 0; wave < 10; wave++) {
      const work: Promise<{ kind: string; result: Result | null; sale?: SaleRef }>[] = [];
      for (let i = 0; i < 20; i++) {
        const s = rnd.pick(shops);
        const known = sales.get(s)!;
        let roll = rnd.next();
        if (known.length === 0 && roll >= 0.4 && roll < 0.7) roll = 0; // nothing to pay or void yet: sell instead
        if (roll < 0.4) {
          const by = rnd.next() < 0.6 ? s.attendant : s.manager;
          const lines = Array.from({ length: rnd.int(1, 3) }, () => ({ pack_type_id: s.pack[rnd.pick(sizes)], quantity: rnd.int(1, 5), unit_price: rnd.pick(prices) }));
          const payments = Array.from({ length: rnd.int(0, 2) }, () => payment(s));
          const ref = { id: randomUUID(), by };
          const cmd = api.command('sale.create', { sale_id: ref.id, local_ref: `W${wave}-${i}`, location_id: s.loc, lines, payments });
          work.push(api.sendOne(by.token, cmd).then((result) => ({ kind: 'sale', result, sale: ref })));
        } else if (roll < 0.55) {
          const target = rnd.pick(known);
          const by = target.by === s.attendant && rnd.next() < 0.5 ? s.attendant : s.manager;
          const cmd = api.command('payment.attach', { sale_id: target.id, payments: [payment(s)] });
          work.push(api.sendOne(by.token, cmd).then((result) => ({ kind: 'attach', result })));
        } else if (roll < 0.63) {
          const target = rnd.pick(known);
          work.push(api.sendOne(s.manager.token, api.command('sale.void', { sale_id: target.id, reason: 'MISTAKE' })).then((result) => ({ kind: 'void', result })));
        } else if (roll < 0.7) {
          const own = known.filter((x) => x.by === s.attendant);
          if (own.length === 0) continue;
          const target = rnd.pick(own);
          // A fresh approval for each attendant void (decided in E6, as in C6).
          const approvalId = await approval(s.attendant, s.manager);
          work.push(
            api.sendOne(s.attendant.token, api.command('sale.void', { sale_id: target.id, reason: 'CUSTOMER_CANCELLED', approval_id: approvalId })).then((result) => ({ kind: 'void-approved', result })),
          );
        } else if (roll < 0.8) {
          const lines = [...sizes].filter(() => rnd.next() < 0.6).map((u) => ({ pack_type_id: s.pack[u], quantity: rnd.int(1, 20) }));
          if (lines.length === 0) lines.push({ pack_type_id: s.pack[1], quantity: 5 });
          work.push(api.sendOne(s.manager.token, api.command('stock.receive', { location_id: s.loc, lines })).then((result) => ({ kind: 'receive', result })));
        } else if (roll < 0.85) {
          const lines = [...sizes].filter(() => rnd.next() < 0.6).map((u) => ({ pack_type_id: s.pack[u], expected_quantity: rnd.int(0, 50), counted_quantity: rnd.int(0, 50) }));
          if (lines.length === 0) lines.push({ pack_type_id: s.pack[1], expected_quantity: 10, counted_quantity: 9 });
          work.push(api.sendOne(s.manager.token, api.command('stock.count', { location_id: s.loc, lines })).then((result) => ({ kind: 'count', result })));
        } else if (roll < 0.95) {
          const [from, to] = rnd.next() < 0.5 ? [48, 24] : [24, 1];
          const payload = { location_id: s.loc, from_pack_type_id: s.pack[from as 48 | 24], to_pack_type_id: s.pack[to as 24 | 1], quantity: rnd.int(1, 2) };
          work.push(api.sendOne(s.manager.token, api.command('stock.convert', payload)).then((result) => ({ kind: 'convert', result })));
        } else {
          const who = rnd.pick([s.attendant, s.manager]);
          const url = rnd.next() < 0.5 ? '/v1/sales?limit=5' : '/v1/sync/snapshot?limit=50';
          work.push(api.call('GET', url, who.token).then((res) => ({ kind: 'read', result: { command_id: null, status: res.statusCode === 200 ? 'ACCEPTED' : `HTTP ${res.statusCode}` } })));
        }
      }
      for (const o of await Promise.all(work)) {
        outcomes.push({ kind: o.kind, result: o.result });
        if (o.kind === 'void-approved' && o.result?.status === 'ACCEPTED') approvedVoids++;
        if (o.sale && o.result && o.result.status !== 'REJECTED' && o.result.status !== 'FAILED') {
          sales.get(shops.find((x) => x.attendant === o.sale!.by || x.manager === o.sale!.by)!)!.push(o.sale);
        }
      }
    }
    expect(outcomes.length, `seed ${seed}`).toBeGreaterThan(180);

    // Every command ended in an expected way: never FAILED (a deadlock, a pool timeout or a crash would be).
    const allowed: Record<string, string[]> = {
      sale: ['ACCEPTED', 'FLAGGED:STOCK_NEGATIVE', 'FLAGGED:DUPLICATE_MPESA_CODE', 'FLAGGED:OVERPAYMENT'],
      attach: ['ACCEPTED', 'FLAGGED:DUPLICATE_MPESA_CODE', 'FLAGGED:OVERPAYMENT', 'REJECTED:SALE_VOIDED'],
      void: ['ACCEPTED', 'REJECTED:SALE_ALREADY_VOIDED'],
      'void-approved': ['ACCEPTED', 'REJECTED:SALE_ALREADY_VOIDED'],
      receive: ['ACCEPTED'],
      count: ['ACCEPTED', 'FLAGGED:NEGATIVE_AFTER_COUNT'],
      convert: ['ACCEPTED', 'REJECTED:STOCK_INSUFFICIENT'],
      read: ['ACCEPTED'],
    };
    // A FAILED command's log line (ids, type, error name and code only) is the evidence when this fails.
    const failures = JSON.stringify(t.logs.filter((l) => l.msg === 'sync command failed'));
    for (const o of outcomes) {
      const r = o.result!;
      expect(r.status, `seed ${seed}: ${o.kind} FAILED; ${failures}`).not.toBe('FAILED');
      const key = r.status === 'ACCEPTED' ? 'ACCEPTED' : `${r.status}:${r.reason}`;
      expect(allowed[o.kind], `seed ${seed}: ${o.kind} ended ${key}`).toContain(r.status === 'FLAGGED' || r.status === 'REJECTED' ? key : r.status);
    }
    for (const kind of ['sale', 'attach', 'void', 'void-approved', 'receive', 'convert']) {
      expect(outcomes.some((o) => o.kind === kind && o.result?.status !== 'REJECTED'), `seed ${seed}: no successful ${kind}`).toBe(true);
    }

    for (const s of shops) {
      const biz = s.owner.businessId;
      // Every balance equals its ledger, by the integrity check.
      expect(await api.integrity(biz), `seed ${seed}`).toEqual([]);
      // Sale numbers are exactly 1..N.
      const numbers = await asAdmin(async (c) => (await c.query<{ n: number }>('SELECT sale_number AS n FROM sale WHERE business_id = $1 ORDER BY 1', [biz])).rows.map((r) => r.n));
      expect(numbers, `seed ${seed}`).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
      expect(numbers.length).toBe(sales.get(s)!.length);
      // Each total equals its items.
      expect(
        await count(
          `SELECT count(*) AS n FROM sale s WHERE s.business_id = $1
              AND s.total <> (SELECT coalesce(sum(i.line_total), 0) FROM sale_item i WHERE i.sale_id = s.id)`,
          [biz],
        ),
        `seed ${seed}: totals`,
      ).toBe(0);
      // paid_total is the sum of all the sale's payments (kept on a void, decided in E5 and E6);
      // a completed sale has no reversed payment, a voided one only reversed payments.
      expect(
        await count(
          `SELECT count(*) AS n FROM sale s WHERE s.business_id = $1 AND (
              s.paid_total <> (SELECT coalesce(sum(p.amount), 0) FROM payment p WHERE p.sale_id = s.id)
              OR EXISTS (SELECT 1 FROM payment p WHERE p.sale_id = s.id AND p.status <> CASE s.status WHEN 'VOIDED' THEN 'REVERSED' ELSE 'RECORDED' END))`,
          [biz],
        ),
        `seed ${seed}: payments`,
      ).toBe(0);
      // Every voided sale put back exactly what it sold, per pack type; no other sale has SALE_VOID movements.
      expect(
        await count(
          `SELECT count(*) AS n FROM (
             SELECT m.sale_id, m.pack_type_id,
                    sum(m.quantity_change) FILTER (WHERE m.movement_type = 'SALE') AS sold,
                    sum(m.quantity_change) FILTER (WHERE m.movement_type = 'SALE_VOID') AS returned
               FROM stock_movement m JOIN sale s ON s.id = m.sale_id
              WHERE m.business_id = $1
              GROUP BY m.sale_id, m.pack_type_id, s.status
             HAVING (s.status = 'VOIDED' AND coalesce(sum(m.quantity_change) FILTER (WHERE m.movement_type = 'SALE_VOID'), 0) <> -sum(m.quantity_change) FILTER (WHERE m.movement_type = 'SALE'))
                 OR (s.status = 'COMPLETED' AND count(*) FILTER (WHERE m.movement_type = 'SALE_VOID') > 0)
           ) bad`,
          [biz],
        ),
        `seed ${seed}: voids`,
      ).toBe(0);
      // At most one original payment per code.
      expect(
        await count(
          `SELECT count(*) AS n FROM (SELECT mpesa_code FROM payment WHERE business_id = $1 AND mpesa_code IS NOT NULL
             GROUP BY mpesa_code HAVING count(*) FILTER (WHERE duplicate_of_payment_id IS NULL) <> 1) bad`,
          [biz],
        ),
        `seed ${seed}: codes`,
      ).toBe(0);
      // Phones: the attendant's snapshot holds exactly their sales, the manager's all of them (all are recent).
      const mine = new Set(sales.get(s)!.filter((x) => x.by === s.attendant).map((x) => x.id));
      expect(await snapshotSaleIds(s.attendant.token), `seed ${seed}: attendant snapshot`).toEqual(mine);
      expect(await snapshotSaleIds(s.manager.token), `seed ${seed}: manager snapshot`).toEqual(new Set(sales.get(s)!.map((x) => x.id)));
    }
    // Nothing crossed between the two businesses.
    const crossed = await count(`
      SELECT (SELECT count(*) FROM sale s JOIN location l ON l.id = s.location_id WHERE l.business_id <> s.business_id)
           + (SELECT count(*) FROM sale s JOIN membership x ON x.id = s.created_by_membership_id WHERE x.business_id <> s.business_id)
           + (SELECT count(*) FROM sale_item i JOIN sale s ON s.id = i.sale_id WHERE s.business_id <> i.business_id)
           + (SELECT count(*) FROM sale_item i JOIN pack_type p ON p.id = i.pack_type_id WHERE p.business_id <> i.business_id)
           + (SELECT count(*) FROM payment p JOIN sale s ON s.id = p.sale_id WHERE s.business_id <> p.business_id)
           + (SELECT count(*) FROM payment p JOIN payment o ON o.id = p.duplicate_of_payment_id WHERE o.business_id <> p.business_id)
           + (SELECT count(*) FROM stock_movement m JOIN sale s ON s.id = m.sale_id WHERE s.business_id <> m.business_id) AS n`);
    expect(crossed, `seed ${seed}`).toBe(0);
    // Each approval used by an accepted void is consumed; the others are not.
    expect(await count("SELECT count(*) AS n FROM approval WHERE purpose = 'SALE_VOID' AND consumed_at IS NOT NULL"), `seed ${seed}`).toBe(approvedVoids);
    expect(approvedVoids, `seed ${seed}: the approval path ran`).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- 2. logs
  it('2. no log line of a Phase E request contains a name, reference, note, M-Pesa code, amount, price or approval id', async () => {
    const s = await shop('Duka A');
    const firstLine = t.logs.length;
    const marker = {
      name: 'ZEBRA-E6-PRODUCT',
      ref: 'E6REFMARK',
      note: 'E6-NOTE-MARKER',
      voidNote: 'E6-VOID-NOTE',
      code: 'E6LOGCODE9',
      price: '7654.32',
      amount: '4321.09',
      wrongPin: '958274',
    };
    const product = { product_id: randomUUID(), name: marker.name, pack_types: [{ pack_type_id: randomUUID(), name: 'piece', units_per_pack: 1, sell_price: '10' }] };
    expect((await api.sendOne(s.owner.token, api.command('product.create', product))).status).toBe('ACCEPTED');
    const piece = product.pack_types[0].pack_type_id;
    const saleId = randomUUID();
    const sale = api.command('sale.create', {
      sale_id: saleId,
      local_ref: marker.ref,
      location_id: s.loc,
      note: marker.note,
      lines: [{ pack_type_id: piece, quantity: 1, unit_price: marker.price }],
      payments: [{ method: 'MPESA', amount: marker.amount, mpesa_code: marker.code }],
    });
    expect((await api.sendOne(s.attendant.token, sale)).status).not.toBe('REJECTED');
    expect((await api.sendOne(s.attendant.token, api.command('payment.attach', { sale_id: saleId, payments: [{ method: 'MPESA', amount: marker.amount, mpesa_code: marker.code }] }))).status).toBe('FLAGGED');
    // A rejected command (bad payment), and a FAILED one whose error message quotes the data.
    expect(
      await api.sendOne(s.attendant.token, api.command('sale.create', { sale_id: randomUUID(), local_ref: marker.ref, location_id: s.loc, lines: [{ pack_type_id: piece, quantity: 1, unit_price: marker.price }], payments: [{ method: 'CASH', amount: marker.amount, mpesa_code: marker.code }] })),
    ).toMatchObject({ status: 'REJECTED', reason: 'INVALID_PAYMENTS' });
    vi.spyOn(t.app.get(SalesRepository, { strict: false }), 'insertItems').mockRejectedValueOnce(
      new Error(`could not save ${marker.name} at ${marker.price}: ${marker.note} ${marker.ref} ${marker.code}`),
    );
    const failed = api.command('sale.create', { sale_id: randomUUID(), local_ref: marker.ref, location_id: s.loc, note: marker.note, lines: [{ pack_type_id: piece, quantity: 1, unit_price: marker.price }] });
    expect((await api.sendOne(s.attendant.token, failed)).status).toBe('FAILED');

    // Approvals: a wrong PIN and a right one, then the attendant's void with a note.
    expect((await mint(s.attendant, s.manager, marker.wrongPin)).statusCode).toBe(403);
    const approvalId = await approval(s.attendant, s.manager);
    expect((await api.sendOne(s.attendant.token, api.command('sale.void', { sale_id: saleId, reason: 'OTHER', note: marker.voidNote, approval_id: approvalId }))).status).toBe('ACCEPTED');
    // Reads and sync.
    const start = api.json<{ start_cursor: string }>(await api.call('GET', '/v1/sync/snapshot?limit=500', s.manager.token)).start_cursor;
    for (const url of ['/v1/sales', `/v1/sales/${saleId}`, '/v1/sync/snapshot?table=sale&limit=500', '/v1/sync/snapshot?table=payment&limit=500', `/v1/sync/changes?cursor=${encodeURIComponent(start)}`, '/v1/stock/approvers?purpose=SALE_VOID']) {
      expect((await api.call('GET', url, s.manager.token)).statusCode, url).toBe(200);
    }

    const raw = t.rawLogs();
    for (const [what, value] of Object.entries({ ...marker, approvalId, staffPin: `"${STAFF_PIN}"`, ownerPin: `"${OWNER_PIN}"` })) {
      expect(raw.includes(value), `${what} appears in the logs`).toBe(false);
    }
    const mine = t.logs.slice(firstLine);
    expect(mine.length).toBeGreaterThan(10);
    for (const line of mine) {
      const text = JSON.stringify(line);
      for (const key of ['"lines"', '"payments"', '"mpesa_code"', '"unit_price"', '"amount"', '"note"', '"local_ref"', '"approval_id"', '"approver_pin"']) {
        expect(text.includes(key), `${key} in a log line`).toBe(false);
      }
    }
    // The failed command is logged by id and type only.
    expect(mine.filter((l) => l.msg === 'sync command failed')).toEqual([expect.objectContaining({ commandId: failed.command_id, commandType: 'sale.create', errorName: 'Error' })]);
  });

  // ---------------------------------------------------------------- 3. audit
  it('3. every Phase E audit action is written exactly once per event, by the acting member', async () => {
    const s = await shop('Duka A');
    const step = async (who: Member, type: string, payload: object) => {
      t.clock.advanceMinutes(1); // audit rows are ordered by their (fake clock) time
      return api.sendOne(who.token, api.command(type, payload));
    };
    const s1 = randomUUID();
    const s2 = randomUUID();
    const line = [{ pack_type_id: s.pack[1], quantity: 1, unit_price: '100' }];
    await step(s.attendant, 'sale.create', { sale_id: s1, local_ref: 'A1', location_id: s.loc, lines: line, payments: [{ method: 'CASH', amount: '40' }] });
    await step(s.manager, 'sale.create', { sale_id: s2, local_ref: 'A2', location_id: s.loc, lines: line });
    await step(s.manager, 'payment.attach', { sale_id: s1, payments: [{ method: 'CASH', amount: '60' }] });
    t.clock.advanceMinutes(1);
    const approvalId = await approval(s.attendant, s.manager);
    await step(s.attendant, 'sale.void', { sale_id: s1, reason: 'MISTAKE', approval_id: approvalId });
    await step(s.manager, 'sale.void', { sale_id: s2, reason: 'WRONG_PRICE' });
    t.clock.advanceMinutes(1);
    for (let i = 0; i < 5; i++) await mint(s.attendant, s.owner, '0000');
    // Refused commands write no audit row.
    await step(s.manager, 'payment.attach', { sale_id: s2, payments: [{ method: 'CASH', amount: '1' }] });
    await step(s.manager, 'sale.void', { sale_id: s2, reason: 'MISTAKE' });

    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string | null }>(
          `SELECT action, actor_membership_id FROM audit_log
            WHERE business_id = $1 AND (action LIKE 'sale.%' OR action LIKE 'payment.%' OR action LIKE 'approval.%') ORDER BY occurred_at, action`,
          [s.owner.businessId],
        )).rows,
    );
    expect(rows.slice(Math.max(0, rows.length - 7))).toEqual([
      { action: 'sale.created', actor_membership_id: s.attendant.membershipId }, // its payments are part of this row, no payment.attached
      { action: 'sale.created', actor_membership_id: s.manager.membershipId },
      { action: 'payment.attached', actor_membership_id: s.manager.membershipId },
      { action: 'approval.granted', actor_membership_id: s.attendant.membershipId },
      { action: 'sale.voided', actor_membership_id: s.attendant.membershipId },
      { action: 'sale.voided', actor_membership_id: s.manager.membershipId },
      { action: 'approval.locked', actor_membership_id: s.attendant.membershipId },
    ]);
    expect(rows).toHaveLength(7);
  });

  it('3. a crash right after the audit insert leaves no audit row and no change, for sale.create, payment.attach and sale.void', async () => {
    const s = await shop('Duka A');
    const saleId = randomUUID();
    expect((await api.sendOne(s.attendant.token, api.command('sale.create', { sale_id: saleId, local_ref: 'C', location_id: s.loc, lines: [{ pack_type_id: s.pack[1], quantity: 2, unit_price: '50' }], payments: [{ method: 'CASH', amount: '10' }] }))).status).toBe('ACCEPTED');
    const approvalId = await approval(s.attendant, s.manager);
    const state = () =>
      asAdmin(async (c) => ({
        audit: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0].n),
        sales: (await c.query('SELECT id, status, paid_total::text, balance_due::text FROM sale ORDER BY id')).rows,
        counter: (await c.query('SELECT business_id, last_number FROM sale_counter ORDER BY 1')).rows,
        items: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM sale_item')).rows[0].n),
        payments: (await c.query('SELECT id, status FROM payment ORDER BY id')).rows,
        balances: (await c.query('SELECT location_id, pack_type_id, quantity FROM stock_balance ORDER BY pack_type_id')).rows,
        movements: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stock_movement')).rows[0].n),
        approvals: (await c.query('SELECT id, consumed_at FROM approval ORDER BY id')).rows,
        commands: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM sync_command')).rows[0].n),
      }));
    const crashAfterNextAudit = () => {
      const audit = t.app.get(AuditService, { strict: false });
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
        await original(entry);
        throw new Error('crash after the audit write');
      });
    };
    const before = await state();
    const commands: [Member, string, object][] = [
      [s.attendant, 'sale.create', { sale_id: randomUUID(), local_ref: 'D', location_id: s.loc, lines: [{ pack_type_id: s.pack[1], quantity: 1, unit_price: '5' }], payments: [{ method: 'CASH', amount: '5' }] }],
      [s.attendant, 'payment.attach', { sale_id: saleId, payments: [{ method: 'MPESA', amount: '90', mpesa_code: 'CRASHCODE1' }] }],
      [s.attendant, 'sale.void', { sale_id: saleId, reason: 'MISTAKE', approval_id: approvalId }],
    ];
    for (const [who, type, payload] of commands) {
      crashAfterNextAudit();
      expect(await api.sendOne(who.token, api.command(type, payload)), type).toMatchObject({ status: 'FAILED' });
    }
    expect(await state()).toEqual(before);
    // The approval was not used by the crashed void, so it still works.
    expect((await api.sendOne(s.attendant.token, api.command('sale.void', commands[2][2]))).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 4. grants
  it('4. app_user cannot delete sales data, cannot change totals, items or amounts, may reverse a payment, and cannot touch a voided sale', async () => {
    const s = await shop('Duka A');
    const open = randomUUID();
    const voided = randomUUID();
    for (const id of [open, voided]) {
      const cmd = api.command('sale.create', { sale_id: id, local_ref: 'G', location_id: s.loc, lines: [{ pack_type_id: s.pack[1], quantity: 1, unit_price: '10' }], payments: [{ method: 'CASH', amount: '10' }] });
      expect((await api.sendOne(s.manager.token, cmd)).status).toBe('ACCEPTED');
    }
    expect((await api.sendOne(s.manager.token, api.command('sale.void', { sale_id: voided, reason: 'MISTAKE' }))).status).toBe('ACCEPTED');

    const outcomes = await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [s.owner.businessId]);
      const attempt = async (sql: string, params: unknown[] = []) => {
        await c.query('SAVEPOINT x');
        try {
          const r = await c.query(sql, params);
          await c.query('RELEASE SAVEPOINT x');
          return `rows ${r.rowCount}`;
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT x');
          return (err as { code?: string }).code === '42501' ? 'denied' : `error ${(err as { code?: string }).code}`;
        }
      };
      const result = {
        deleteSale: await attempt('DELETE FROM sale WHERE id = $1', [open]),
        deleteItem: await attempt('DELETE FROM sale_item WHERE sale_id = $1', [open]),
        deletePayment: await attempt('DELETE FROM payment WHERE sale_id = $1', [open]),
        deleteCounter: await attempt('DELETE FROM sale_counter'),
        updateTotal: await attempt('UPDATE sale SET total = 1 WHERE id = $1', [open]),
        updateNote: await attempt("UPDATE sale SET note = 'x' WHERE id = $1", [open]),
        updateItem: await attempt('UPDATE sale_item SET quantity = 2 WHERE sale_id = $1', [open]),
        updateAmount: await attempt('UPDATE payment SET amount = 1 WHERE sale_id = $1', [open]),
        reversePayment: await attempt("UPDATE payment SET status = 'REVERSED', reversed_txid = pg_current_xact_id() WHERE sale_id = $1", [open]), // reversed_txid since T6
        touchVoided: await attempt('UPDATE sale SET paid_total = paid_total WHERE id = $1', [voided]),
        unVoid: await attempt("UPDATE sale SET status = 'COMPLETED' WHERE id = $1", [voided]),
      };
      await c.query('ROLLBACK');
      return result;
    });
    expect(outcomes).toEqual({
      deleteSale: 'denied',
      deleteItem: 'denied',
      deletePayment: 'denied',
      deleteCounter: 'denied',
      updateTotal: 'denied',
      updateNote: 'denied',
      updateItem: 'denied',
      updateAmount: 'denied',
      reversePayment: 'rows 1',
      touchVoided: 'rows 0',
      unVoid: 'rows 0',
    });
    expect(SYNC_TABLE_NAMES).toContain('payment'); // the sale tables are synced (E4)
  });
});
