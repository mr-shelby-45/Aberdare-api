import { randomUUID } from 'node:crypto';
import { StockCommandsService } from '../src/modules/stock/stock-commands.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, OWNER_PIN, type Result, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase C6: hardening (docs/phase-c-design.md section 13, C6 tests 1 to 4).
// The walkthrough (C6 test 5) is test/c6-walkthrough.spec.ts.

// Three fixed seeds on every run; C6_SEED=<n> replays one exactly.
const SEEDS = process.env.C6_SEED ? [Number(process.env.C6_SEED)] : [101, 202, 303];

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

describe('C6: hardening', { timeout: 600_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.110', 93_000_000);
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
    api.post('/v1/stock/approvals', { approver_membership_id: approver.membershipId, approver_pin: pin, purpose: 'STOCK_CONVERT' }, caller.token);

  // ---------------------------------------------------------------- 1. randomized workload
  it.each(SEEDS)('1. randomized workload, seed %i: ledgers balance, strict pools never negative, nothing crosses businesses', async (seed) => {
    const rnd = random(seed);
    const shops = [await shop('Duka A'), await shop('Duka B')];
    const reasons = { up: ['FOUND', 'CORRECTION', 'OTHER'], down: ['DAMAGED', 'EXPIRED', 'LOST', 'SUPPLIER_RETURN', 'CORRECTION', 'OTHER'] } as const;
    const sizes = [1, 24, 48] as const;
    const outcomes: { kind: string; result: Result | null }[] = [];
    let attendantConversions = 0;

    for (let wave = 0; wave < 10; wave++) {
      const work: Promise<{ kind: string; result: Result | null }>[] = [];
      for (let i = 0; i < 20; i++) {
        const s = rnd.pick(shops);
        const roll = rnd.next();
        if (roll < 0.2) {
          const count = rnd.int(1, 3);
          const packs = [...sizes].sort(() => rnd.next() - 0.5).slice(0, count);
          const lines = packs.map((u) => ({ pack_type_id: s.pack[u], quantity: rnd.int(1, 20) }));
          work.push(api.sendOne(s.manager.token, api.command('stock.receive', { location_id: s.loc, lines })).then((result) => ({ kind: 'receive', result })));
        } else if (roll < 0.4) {
          const down = rnd.next() < 0.6;
          const reason = rnd.pick(down ? reasons.down : reasons.up);
          const change = (down ? -1 : 1) * rnd.int(1, 5);
          const payload = { location_id: s.loc, pack_type_id: s.pack[rnd.pick(sizes)], quantity_change: change, reason };
          work.push(api.sendOne(s.manager.token, api.command('stock.adjust', payload)).then((result) => ({ kind: 'adjust', result })));
        } else if (roll < 0.55) {
          const lines = [...sizes].filter(() => rnd.next() < 0.6).map((u) => ({ pack_type_id: s.pack[u], expected_quantity: rnd.int(0, 50), counted_quantity: rnd.int(0, 50) }));
          if (lines.length === 0) lines.push({ pack_type_id: s.pack[1], expected_quantity: 10, counted_quantity: 9 });
          work.push(api.sendOne(s.manager.token, api.command('stock.count', { location_id: s.loc, lines })).then((result) => ({ kind: 'count', result })));
        } else if (roll < 0.8) {
          const [from, to] = rnd.next() < 0.5 ? [48, 24] : [24, 1];
          const payload = { location_id: s.loc, from_pack_type_id: s.pack[from as 48 | 24], to_pack_type_id: s.pack[to as 24 | 1], quantity: rnd.int(1, 2) };
          if (rnd.next() < 0.1) {
            // About a tenth by the attendant with a freshly minted approval (decided in C6).
            const res = await mint(s.attendant, s.manager);
            expect(res.statusCode, res.body).toBe(201);
            const approvalId = api.json<{ approval_id: string }>(res).approval_id;
            attendantConversions++;
            work.push(
              api.sendOne(s.attendant.token, api.command('stock.convert', { ...payload, approval_id: approvalId })).then((result) => ({ kind: 'convert-approved', result })),
            );
          } else {
            work.push(api.sendOne(s.manager.token, api.command('stock.convert', payload)).then((result) => ({ kind: 'convert', result })));
          }
        } else {
          const pack = s.pack[rnd.pick(sizes)];
          const qty = rnd.int(1, 5);
          work.push(api.sell(s, s.loc, pack, qty).then(() => ({ kind: 'sale', result: null })));
        }
      }
      outcomes.push(...(await Promise.all(work)));
    }
    expect(outcomes).toHaveLength(200);

    // Every command ended in an expected way: never FAILED (a deadlock, a pool timeout or a crash would be).
    const allowed: Record<string, string[]> = {
      receive: ['ACCEPTED'],
      adjust: ['ACCEPTED', 'REJECTED:STOCK_INSUFFICIENT'],
      count: ['ACCEPTED', 'FLAGGED:NEGATIVE_AFTER_COUNT'],
      convert: ['ACCEPTED', 'REJECTED:STOCK_INSUFFICIENT'],
      'convert-approved': ['ACCEPTED', 'REJECTED:STOCK_INSUFFICIENT'],
    };
    for (const o of outcomes.filter((x) => x.result)) {
      const r = o.result!;
      const key = r.status === 'ACCEPTED' ? 'ACCEPTED' : `${r.status}:${r.reason}`;
      expect(allowed[o.kind], `seed ${seed}: ${o.kind} ended ${key}`).toContain(key);
    }
    // Something of each kind happened (so the checks below are not vacuous).
    for (const kind of ['receive', 'adjust', 'count', 'convert', 'sale']) {
      expect(outcomes.some((o) => o.kind === kind && (o.result === null || o.result.status !== 'REJECTED')), `seed ${seed}: no successful ${kind}`).toBe(true);
    }

    for (const s of shops) {
      // Every balance equals its ledger, by the integrity check.
      expect(await api.integrity(s.owner.businessId), `seed ${seed}`).toEqual([]);
      // Strict operations never went below zero.
      const strictNegative = await asAdmin(
        async (c) =>
          (await c.query(
            `SELECT movement_type, quantity_change, quantity_after FROM stock_movement
              WHERE business_id = $1 AND quantity_after < 0
                AND (movement_type = 'CONVERT_OUT' OR (movement_type = 'ADJUST' AND quantity_change < 0))`,
            [s.owner.businessId],
          )).rows,
      );
      expect(strictNegative, `seed ${seed}`).toEqual([]);
    }
    // Nothing crossed between the two businesses.
    const crossed = await asAdmin(
      async (c) =>
        (await c.query<{ n: string }>(`
          SELECT (SELECT count(*) FROM stock_movement m JOIN location l ON l.id = m.location_id WHERE l.business_id <> m.business_id)
               + (SELECT count(*) FROM stock_movement m JOIN pack_type p ON p.id = m.pack_type_id WHERE p.business_id <> m.business_id)
               + (SELECT count(*) FROM stock_movement m JOIN membership x ON x.id = m.created_by_membership_id WHERE x.business_id <> m.business_id)
               + (SELECT count(*) FROM stock_balance b JOIN pack_type p ON p.id = b.pack_type_id WHERE p.business_id <> b.business_id)
               + (SELECT count(*) FROM stock_conversion v JOIN membership x ON x.id = v.approved_by_membership_id WHERE x.business_id <> v.business_id)
               + (SELECT count(*) FROM stock_conversion v JOIN approval a ON a.id = v.approval_id WHERE a.business_id <> v.business_id) AS n`)).rows[0].n,
    );
    expect(Number(crossed), `seed ${seed}`).toBe(0);
    // Each approval used by an accepted conversion is consumed; the others are not.
    const accepted = outcomes.filter((o) => o.kind === 'convert-approved' && o.result?.status === 'ACCEPTED').length;
    const consumed = await asAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM approval WHERE consumed_at IS NOT NULL')).rows[0].n));
    expect(consumed, `seed ${seed}`).toBe(accepted);
    expect(attendantConversions, `seed ${seed}: the approval path ran`).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- 2. logs
  it('2. no log line of a Phase C request contains a name, note, reference, cost, PIN, approval id or line details', async () => {
    const s = await shop('Duka A');
    const firstLine = t.logs.length;
    const marker = {
      name: 'ZEBRA-C6-PRODUCT',
      note: 'C6-NOTE-MARKER',
      reference: 'C6-REF-MARKER',
      cost: '765432.10',
      wrongPin: '958274',
    };
    const product = { product_id: randomUUID(), name: marker.name, pack_types: [{ pack_type_id: randomUUID(), name: 'piece', units_per_pack: 1, sell_price: '10' }] };
    expect((await api.sendOne(s.owner.token, api.command('product.create', product))).status).toBe('ACCEPTED');
    const piece = product.pack_types[0].pack_type_id;

    // Accepted commands, with every free-text field filled.
    const accepted = await api.send(s.owner.token, [
      api.command('stock.receive', { location_id: s.loc, reference: marker.reference, note: marker.note, lines: [{ pack_type_id: piece, quantity: 9, unit_cost: marker.cost }] }),
      api.command('stock.adjust', { location_id: s.loc, pack_type_id: piece, quantity_change: -1, reason: 'DAMAGED', note: marker.note }),
      api.command('stock.count', { location_id: s.loc, note: marker.note, lines: [{ pack_type_id: piece, expected_quantity: 8, counted_quantity: 7 }] }),
      api.command('stock.convert', { location_id: s.loc, from_pack_type_id: s.pack[24], to_pack_type_id: s.pack[1], quantity: 1, note: marker.note }),
    ]);
    expect(accepted.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    // A rejected command (bad lines), and a FAILED one whose error message quotes the data.
    vi.spyOn(t.app.get(StockCommandsService, { strict: false }), 'receive').mockRejectedValueOnce(
      new Error(`could not receive ${marker.name} at ${marker.cost}: ${marker.note} ${marker.reference}`),
    );
    // The mock catches the next receive, so the crashing command goes first.
    const other = await api.send(s.owner.token, [
      api.command('stock.receive', { location_id: s.loc, reference: marker.reference, lines: [{ pack_type_id: piece, quantity: 1 }] }),
      api.command('stock.receive', { location_id: s.loc, note: marker.note, lines: [{ pack_type_id: randomUUID(), quantity: 0 }] }),
    ]);
    expect(other.map((r) => r.status)).toEqual(['FAILED', 'REJECTED']);

    // Approvals: a wrong PIN and a right one, then the approved conversion.
    expect((await mint(s.attendant, s.manager, marker.wrongPin)).statusCode).toBe(403);
    const res = await mint(s.attendant, s.manager);
    expect(res.statusCode).toBe(201);
    const approvalId = api.json<{ approval_id: string }>(res).approval_id;
    expect(
      (await api.sendOne(s.attendant.token, api.command('stock.convert', { location_id: s.loc, from_pack_type_id: s.pack[48], to_pack_type_id: s.pack[24], quantity: 1, approval_id: approvalId }))).status,
    ).toBe('ACCEPTED');
    // Reads.
    for (const url of ['/v1/stock', '/v1/stock?include_zero=true', '/v1/stock/movements', '/v1/stock/approvers']) {
      expect((await api.call('GET', url, s.owner.token)).statusCode, url).toBe(200);
    }

    const raw = t.rawLogs();
    for (const [what, value] of Object.entries({ ...marker, approvalId, staffPin: `"${STAFF_PIN}"`, ownerPin: `"${OWNER_PIN}"` })) {
      expect(raw.includes(value), `${what} appears in the logs`).toBe(false);
    }
    const mine = t.logs.slice(firstLine);
    expect(mine.length).toBeGreaterThan(10);
    for (const line of mine) {
      const text = JSON.stringify(line);
      for (const key of ['"lines"', '"quantity', '"note"', '"reference"', '"unit_cost"', '"approver_pin"', '"approval_id"']) {
        expect(text.includes(key), `${key} in a log line`).toBe(false);
      }
    }
    // The failed command is logged by id and type only.
    expect(mine.filter((l) => l.msg === 'sync command failed')).toEqual([
      expect.objectContaining({ commandId: other[0].command_id, commandType: 'stock.receive', errorName: 'Error' }),
    ]);
  });

  // ---------------------------------------------------------------- 3. audit
  it('3. every Phase C audit action is written exactly once per change, by the acting member', async () => {
    const s = await shop('Duka A');
    const before = (await api.auditRows(s.owner.businessId)).length;
    const step = async (token: string, type: string, payload: object) => {
      t.clock.advanceMinutes(1); // audit rows are ordered by their (fake clock) time
      return api.sendOne(token, api.command(type, payload));
    };
    await step(s.manager.token, 'stock.receive', { location_id: s.loc, lines: [{ pack_type_id: s.pack[1], quantity: 5 }] });
    await step(s.manager.token, 'stock.adjust', { location_id: s.loc, pack_type_id: s.pack[1], quantity_change: -1, reason: 'LOST' });
    await step(s.owner.token, 'stock.count', { location_id: s.loc, lines: [{ pack_type_id: s.pack[1], expected_quantity: 4, counted_quantity: 4 }] });
    await step(s.manager.token, 'stock.convert', { location_id: s.loc, from_pack_type_id: s.pack[24], to_pack_type_id: s.pack[1], quantity: 1 });
    t.clock.advanceMinutes(1);
    const approvalId = api.json<{ approval_id: string }>(await mint(s.attendant, s.manager)).approval_id;
    await step(s.attendant.token, 'stock.convert', { location_id: s.loc, from_pack_type_id: s.pack[48], to_pack_type_id: s.pack[24], quantity: 1, approval_id: approvalId });
    t.clock.advanceMinutes(1);
    for (let i = 0; i < 5; i++) await mint(s.attendant, s.owner, '0000');
    // Refused commands write no audit row.
    await step(s.manager.token, 'stock.adjust', { location_id: s.loc, pack_type_id: s.pack[1], quantity_change: -9999, reason: 'LOST' });

    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string | null }>(
          `SELECT action, actor_membership_id FROM audit_log
            WHERE business_id = $1 AND (action LIKE 'stock.%' OR action LIKE 'approval.%') ORDER BY occurred_at, action`,
          [s.owner.businessId],
        )).rows,
    );
    // The opening delivery of shop() comes first.
    expect(rows.slice(before)).toEqual([
      { action: 'stock.received', actor_membership_id: s.manager.membershipId },
      { action: 'stock.adjusted', actor_membership_id: s.manager.membershipId },
      { action: 'stock.counted', actor_membership_id: s.owner.membershipId },
      { action: 'stock.converted', actor_membership_id: s.manager.membershipId },
      { action: 'approval.granted', actor_membership_id: s.attendant.membershipId },
      { action: 'stock.converted', actor_membership_id: s.attendant.membershipId },
      { action: 'approval.locked', actor_membership_id: s.attendant.membershipId },
    ]);
  });

  it('3. a crash right after the audit insert leaves no audit row and no change, for every stock command and the approval mint', async () => {
    const s = await shop('Duka A');
    const approvalId = api.json<{ approval_id: string }>(await mint(s.attendant, s.manager)).approval_id;
    const snapshot = () =>
      asAdmin(async (c) => ({
        audit: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0].n),
        balances: (await c.query('SELECT location_id, pack_type_id, quantity FROM stock_balance ORDER BY pack_type_id')).rows,
        movements: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stock_movement')).rows[0].n),
        conversions: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stock_conversion')).rows[0].n),
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
    const before = await snapshot();
    const commands: [Member, string, object][] = [
      [s.manager, 'stock.receive', { location_id: s.loc, lines: [{ pack_type_id: s.pack[1], quantity: 5 }] }],
      [s.manager, 'stock.adjust', { location_id: s.loc, pack_type_id: s.pack[1], quantity_change: -1, reason: 'LOST' }],
      [s.manager, 'stock.count', { location_id: s.loc, lines: [{ pack_type_id: s.pack[1], expected_quantity: 9, counted_quantity: 4 }] }],
      [s.manager, 'stock.convert', { location_id: s.loc, from_pack_type_id: s.pack[24], to_pack_type_id: s.pack[1], quantity: 1 }],
      [s.attendant, 'stock.convert', { location_id: s.loc, from_pack_type_id: s.pack[48], to_pack_type_id: s.pack[24], quantity: 1, approval_id: approvalId }],
    ];
    for (const [who, type, payload] of commands) {
      crashAfterNextAudit();
      expect(await api.sendOne(who.token, api.command(type, payload)), type).toMatchObject({ status: 'FAILED' });
    }
    crashAfterNextAudit();
    expect((await mint(s.attendant, s.manager)).statusCode).toBe(500);
    expect(await snapshot()).toEqual(before);
    // The approval was not used by the crashed conversion, so it still works.
    expect((await api.sendOne(s.attendant.token, api.command('stock.convert', commands[4][2]))).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 4. grants
  it('4. app_user cannot update or delete movements or conversions, and may update only the consumption columns of an approval', async () => {
    const grants = await asAdmin(
      async (c) =>
        (await c.query<{ table_name: string; privilege_type: string }>(
          `SELECT table_name, privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'app_user' AND table_name IN ('stock_movement', 'stock_conversion', 'approval')
            ORDER BY table_name, privilege_type`,
        )).rows,
    );
    expect(grants).toEqual([
      { table_name: 'approval', privilege_type: 'INSERT' },
      { table_name: 'approval', privilege_type: 'SELECT' },
      { table_name: 'stock_conversion', privilege_type: 'INSERT' },
      { table_name: 'stock_conversion', privilege_type: 'SELECT' },
      { table_name: 'stock_movement', privilege_type: 'INSERT' },
      { table_name: 'stock_movement', privilege_type: 'SELECT' },
    ]);
    const updatable = await asAdmin(
      async (c) =>
        (await c.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.column_privileges
            WHERE grantee = 'app_user' AND privilege_type IN ('UPDATE', 'DELETE')
              AND table_name IN ('stock_movement', 'stock_conversion', 'approval')
            ORDER BY table_name, column_name`,
        )).rows,
    );
    expect(updatable).toEqual([
      { table_name: 'approval', column_name: 'consumed_at' },
      { table_name: 'approval', column_name: 'consumed_by_sync_command_id' },
    ]);
  });
});
