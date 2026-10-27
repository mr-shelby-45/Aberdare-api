import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';
import { type Member, type Result, type World, stockApi } from './helpers/stock-api.js';

// Phase T4: the field settlement (docs/phase-t-design.md section 6, window
// rule B). Test numbers follow the T4 list in section 11.

interface Line {
  pack_type_id: string;
  issued: number;
  returned: number;
  sold: number;
  voided_back: number;
  expected_quantity: number;
  counted_quantity: number;
  variance: number;
}

describe('T4: settlement', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.193', 99_300_000);
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

  interface FieldWorld extends World {
    f1: Member;
    van: string;
  }
  const sync = async (m: Member) => expect((await api.call('GET', '/v1/sync/snapshot?limit=1', m.token)).statusCode).toBe(200);
  /** A shop with stock, a field attendant whose van holds 10 pieces and 2 cartons, and a synced phone. */
  async function fieldWorld(name = 'Duka A'): Promise<FieldWorld> {
    const w = await api.world(name);
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const created = await api.post('/v1/locations', { name: 'Van 1', kind: 'FIELD', assigned_membership_id: f1.membershipId }, w.owner.token);
    expect(created.statusCode, created.body).toBe(201);
    const van = api.json<{ id: string }>(created).id;
    const receive = api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 50 }, { pack_type_id: w.maize.carton, quantity: 10 }] });
    expect((await api.sendOne(w.manager.token, receive)).status).toBe('ACCEPTED');
    const issue = api.command('stock.issue', { from_location_id: w.loc, to_location_id: van, lines: [{ pack_type_id: w.maize.piece, quantity: 10 }, { pack_type_id: w.maize.carton, quantity: 2 }] });
    expect((await api.sendOne(w.manager.token, issue)).status).toBe('ACCEPTED');
    await sync(f1);
    return { ...w, f1, van };
  }
  const fsale = (w: FieldWorld, lines: { pack: string; qty: number; price: string }[], payments: object[] = [], occurredAt?: string) => {
    const cmd = api.command(
      'sale.create',
      { sale_id: randomUUID(), local_ref: 'F', location_id: w.van, lines: lines.map((l) => ({ pack_type_id: l.pack, quantity: l.qty, unit_price: l.price })), payments },
      occurredAt,
    );
    return { cmd, saleId: (cmd.payload as { sale_id: string }).sale_id };
  };
  const closeCmd = (w: FieldWorld, counts: Record<string, number>, cash: string, extra: object = {}) =>
    api.command('settlement.close', {
      settlement_id: randomUUID(),
      field_location_id: w.van,
      cash_received: cash,
      lines: Object.entries(counts).map(([pack, counted]) => ({ pack_type_id: pack, counted_quantity: counted })),
      ...extra,
    });
  const settlementOf = (id: string) =>
    asAdmin(async (c) => (await c.query('SELECT expected_cash::text, cash_received::text, cash_variance::text, mpesa_verified_total::text, mpesa_unverified_total::text, sale_count, voided_count, unpaid_total::text, attendant_membership_id, closed_by_membership_id FROM field_settlement WHERE id = $1', [id])).rows[0]);
  const linesOf = (id: string) =>
    asAdmin(
      async (c) =>
        (await c.query<Line>('SELECT pack_type_id, issued, returned, sold, voided_back, expected_quantity, counted_quantity, variance::int AS variance FROM field_settlement_line WHERE settlement_id = $1 ORDER BY pack_type_id', [id])).rows,
    );
  const adjustmentsOf = (id: string) =>
    asAdmin(async (c) => (await c.query<{ pack_type_id: string; quantity_change: number; reason: string; note: string }>("SELECT pack_type_id, quantity_change, reason, note FROM stock_movement WHERE settlement_id = $1 AND movement_type = 'ADJUST' ORDER BY pack_type_id", [id])).rows);
  const settlementIdOf = (cmd: { payload: object }) => (cmd.payload as { settlement_id: string }).settlement_id;
  async function lockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const waiting = await asAdmin(
        async (c) => Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n),
      );
      if (waiting >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`fewer than ${n} backends waited for a lock`);
  }
  /** A day at the van: sales (cash, M-Pesa, split, unpaid), a void, a return and a damaged piece. */
  async function day(w: FieldWorld) {
    const piece = (qty: number) => ({ pack: w.maize.piece, qty, price: '180' });
    const s1 = fsale(w, [piece(3)], [{ method: 'CASH', amount: '540' }]);
    const s2 = fsale(w, [piece(2)], [{ method: 'CASH', amount: '360' }]);
    const s3 = fsale(w, [piece(1)], [{ method: 'CASH', amount: '100' }, { method: 'MPESA', amount: '80', mpesa_code: 'DAYCODE001' }]);
    const s4 = fsale(w, [{ pack: w.maize.carton, qty: 1, price: '4200' }]);
    for (const s of [s1, s2, s3, s4]) expect((await api.sendOne(w.f1.token, s.cmd)).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('sale.void', { sale_id: s2.saleId, reason: 'MISTAKE' }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('stock.return', { from_location_id: w.van, to_location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 2 }] }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('stock.adjust', { location_id: w.van, pack_type_id: w.maize.piece, quantity_change: -1, reason: 'DAMAGED' }))).status).toBe('ACCEPTED');
  }

  // ---------------------------------------------------------------- 1. the preview
  it('1. the preview equals a hand calculation; voided sales\' payments are excluded; the ledger identity holds', async () => {
    const w = await fieldWorld();
    await day(w);
    const res = await api.call('GET', `/v1/field/settlements/preview?location_id=${w.van}`, w.manager.token);
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json() as Record<string, unknown> & { lines: Record<string, number | string>[] };
    // Pieces: 10 issued, 6 sold (3 + 2 + 1), 2 back from the void, 2 returned, 1 damaged: 10 - 2 - 6 + 2 - 1 = 3.
    expect(p.lines).toEqual(
      [
        { pack_type_id: w.maize.piece, issued: 10, returned: 2, sold: 6, voided_back: 2, other: -1, expected_quantity: 3 },
        { pack_type_id: w.maize.carton, issued: 2, returned: 0, sold: 1, voided_back: 0, other: 0, expected_quantity: 1 },
      ].sort((a, b) => a.pack_type_id.localeCompare(b.pack_type_id)),
    );
    expect(p).toMatchObject({
      location_id: w.van,
      attendant_membership_id: w.f1.membershipId,
      expected_cash: '640.00', // 540 + 100; the voided sale's 360 is reversed and left out
      mpesa_verified_total: '0.00',
      mpesa_unverified_total: '80.00',
      sale_count: 4,
      voided_count: 1,
      unpaid_total: '4200.00',
      last_synced_at: expect.any(String),
    });
    for (const l of p.lines) {
      expect(Number(l.issued) - Number(l.returned) - Number(l.sold) + Number(l.voided_back) + Number(l.other)).toBe(l.expected_quantity);
    }
    // Only managers and owners; a non-field location is not found.
    expect((await api.call('GET', `/v1/field/settlements/preview?location_id=${w.van}`, w.f1.token)).statusCode).toBe(403);
    expect((await api.call('GET', `/v1/field/settlements/preview?location_id=${w.loc}`, w.manager.token)).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- 2. the close
  it('2. a close stores the settlement; a shortage is ADJUST/LOST, a surplus FOUND, no movement at zero; balances equal the counts; the phone never sends the expected quantity', async () => {
    const w = await fieldWorld();
    const beans = await api.newProduct(w.owner, 'Beans');
    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: beans.piece, quantity: 5 }] }));
    await api.sendOne(w.manager.token, api.command('stock.issue', { from_location_id: w.loc, to_location_id: w.van, lines: [{ pack_type_id: beans.piece, quantity: 3 }] }));
    await day(w);
    // A phone-sent expected quantity is refused: the server's locked balance is the only expected.
    const withExpected = api.command('settlement.close', {
      settlement_id: randomUUID(),
      field_location_id: w.van,
      cash_received: '600',
      lines: [{ pack_type_id: w.maize.piece, counted_quantity: 1, expected_quantity: 1 }, { pack_type_id: w.maize.carton, counted_quantity: 2 }, { pack_type_id: beans.piece, counted_quantity: 3 }],
    });
    expect(await api.sendOne(w.manager.token, withExpected)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });

    const cmd = closeCmd(w, { [w.maize.piece]: 1, [w.maize.carton]: 2, [beans.piece]: 3 }, '600', { note: 'short two pieces' });
    const r = await api.sendOne(w.manager.token, cmd);
    const id = settlementIdOf(cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: {
        settlement_id: id,
        cash_variance: '-40.00',
        lines: [
          { pack_type_id: w.maize.piece, variance: -2 },
          { pack_type_id: w.maize.carton, variance: 1 },
          { pack_type_id: beans.piece, variance: 0 },
        ],
      },
    });
    expect(await settlementOf(id)).toEqual({
      expected_cash: '640.00',
      cash_received: '600.00',
      cash_variance: '-40.00',
      mpesa_verified_total: '0.00',
      mpesa_unverified_total: '80.00',
      sale_count: 4,
      voided_count: 1,
      unpaid_total: '4200.00',
      attendant_membership_id: w.f1.membershipId,
      closed_by_membership_id: w.manager.membershipId,
    });
    const byPack = new Map((await linesOf(id)).map((l) => [l.pack_type_id, l]));
    expect(byPack.get(w.maize.piece)).toMatchObject({ issued: 10, returned: 2, sold: 6, voided_back: 2, expected_quantity: 3, counted_quantity: 1, variance: -2 });
    expect(byPack.get(w.maize.carton)).toMatchObject({ issued: 2, sold: 1, expected_quantity: 1, counted_quantity: 2, variance: 1 });
    expect(byPack.get(beans.piece)).toMatchObject({ issued: 3, expected_quantity: 3, counted_quantity: 3, variance: 0 });
    const adjustments = await adjustmentsOf(id);
    const key = (pack: string, change: number, reason: string) => `${pack}:${change}:${reason}`;
    expect(adjustments.map((a) => key(a.pack_type_id, a.quantity_change, a.reason)).sort((x, y) => x.localeCompare(y))).toEqual(
      [key(w.maize.piece, -2, 'LOST'), key(w.maize.carton, 1, 'FOUND')].sort((x, y) => x.localeCompare(y)),
    );
    for (const a of adjustments) expect(a.note).toBe('Field settlement: Otieno');
    expect(await api.balanceOf(w.owner.businessId, w.van, w.maize.piece)).toBe(1);
    expect(await api.balanceOf(w.owner.businessId, w.van, w.maize.carton)).toBe(2);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 3. the window
  it('3. each settlement covers only what came after the previous one; a sale received after a close goes to the next; each sale counted once', async () => {
    const w = await fieldWorld();
    const piece = (qty: number) => ({ pack: w.maize.piece, qty, price: '100' });
    const counts = async () => ({
      [w.maize.piece]: await api.balanceOf(w.owner.businessId, w.van, w.maize.piece),
      [w.maize.carton]: await api.balanceOf(w.owner.businessId, w.van, w.maize.carton),
    });
    const settle = async () => {
      const cmd = closeCmd(w, await counts(), '0');
      const r = await api.sendOne(w.manager.token, cmd);
      expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
      return settlementIdOf(cmd);
    };
    for (let i = 0; i < 2; i++) expect((await api.sendOne(w.f1.token, fsale(w, [piece(1)], [{ method: 'CASH', amount: '100' }]).cmd)).status).toBe('ACCEPTED');
    const a = await settle();
    t.clock.advanceMinutes(1);
    // A sale made before the close (occurred_at) but received after it belongs to the next settlement.
    const early = new Date(t.clock.now().getTime() - 60 * 60_000).toISOString();
    expect(['ACCEPTED', 'FLAGGED']).toContain((await api.sendOne(w.f1.token, fsale(w, [piece(1)], [{ method: 'CASH', amount: '100' }], early).cmd)).status);
    for (let i = 0; i < 3; i++) expect((await api.sendOne(w.f1.token, fsale(w, [piece(1)], [{ method: 'CASH', amount: '100' }]).cmd)).status).toBe('ACCEPTED');
    const b = await settle();
    t.clock.advanceMinutes(1);
    const c = await settle(); // nothing new
    const all = [await settlementOf(a), await settlementOf(b), await settlementOf(c)];
    expect(all.map((s) => s.sale_count)).toEqual([2, 4, 0]);
    expect(all.map((s) => s.expected_cash)).toEqual(['200.00', '400.00', '0.00']);
    expect((await linesOf(b)).find((l) => l.pack_type_id === w.maize.piece)).toMatchObject({ sold: 4, issued: 0 });
    // The preview after the last close shows an empty window.
    const preview = (await api.call('GET', `/v1/field/settlements/preview?location_id=${w.van}`, w.manager.token)).json() as { sale_count: number };
    expect(preview.sale_count).toBe(0);
  });

  // ---------------------------------------------------------------- 4. lines
  it('4. a missing line is LINE_MISSING; duplicates, unknown pack types and bad counts are listed; nothing is saved', async () => {
    const w = await fieldWorld();
    const b = await api.world('Duka B');
    const r = await api.sendOne(
      w.manager.token,
      api.command('settlement.close', {
        settlement_id: randomUUID(),
        field_location_id: w.van,
        cash_received: '0',
        lines: [
          { pack_type_id: w.maize.piece, counted_quantity: 10 }, // 1: fine
          { pack_type_id: w.maize.piece, counted_quantity: 10 }, // 2: duplicate
          { pack_type_id: b.maize.piece, counted_quantity: 1 }, // 3: no stock here (another business's)
          { pack_type_id: randomUUID(), counted_quantity: 1 }, // 4: unknown
        ],
      }),
    );
    expect(r).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_LINES',
      result: {
        invalid_lines: [
          { line: 2, reason: 'DUPLICATE_LINE' },
          { line: 3, reason: 'PACK_TYPE_NOT_FOUND' },
          { line: 4, reason: 'PACK_TYPE_NOT_FOUND' },
          { pack_type_id: w.maize.carton, reason: 'LINE_MISSING' },
        ],
      },
    });
    for (const counted of [-1, 1.5, 2_000_000_001]) {
      expect(await api.sendOne(w.manager.token, closeCmd(w, { [w.maize.piece]: counted, [w.maize.carton]: 2 }, '0')), String(counted)).toMatchObject({
        reason: 'INVALID_LINES',
        result: { invalid_lines: [{ line: 1, reason: 'QUANTITY_INVALID' }] },
      });
    }
    for (const cash of ['-1', '1.234', 'x']) {
      expect(await api.sendOne(w.manager.token, closeCmd(w, { [w.maize.piece]: 10, [w.maize.carton]: 2 }, cash)), cash).toMatchObject({ reason: 'VALIDATION_FAILED' });
    }
    expect(await asAdmin(async (c) => (await c.query('SELECT 1 FROM field_settlement')).rowCount)).toBe(0);
    expect(await api.balanceOf(w.owner.businessId, w.van, w.maize.piece)).toBe(10);
    // Another business's location, a shop and a missing id: LOCATION_NOT_FOUND.
    for (const loc of [b.loc, w.loc, randomUUID()]) {
      expect(await api.sendOne(w.manager.token, closeCmd({ ...w, van: loc }, { [w.maize.piece]: 10 }, '0')), loc).toMatchObject({ reason: 'LOCATION_NOT_FOUND' });
    }
  });

  // ---------------------------------------------------------------- 5. the sync check
  it('5. ATTENDANT_NOT_SYNCED when the attendant\'s devices last synced more than 10 minutes before; fine just under', async () => {
    const w = await fieldWorld();
    const counts = { [w.maize.piece]: 10, [w.maize.carton]: 2 };
    t.clock.advance(10 * 60_000 - 1000); // 9:59 after the sync
    await api.call('GET', '/v1/me', w.manager.token);
    expect((await api.sendOne(w.manager.token, closeCmd(w, counts, '0'))).status).toBe('ACCEPTED');
    t.clock.advance(2000); // 10:01 after the sync
    const res = await api.post('/v1/auth/pin', { device_id: w.manager.deviceId, device_secret: w.manager.deviceSecret, pin: '6071' });
    const manager = { ...w.manager, token: api.json<{ access_token: string }>(res).access_token };
    expect(await api.sendOne(manager.token, closeCmd(w, counts, '0'))).toMatchObject({ status: 'REJECTED', reason: 'ATTENDANT_NOT_SYNCED' });
    // A field attendant who never synced cannot be settled at all.
    const f2 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Wafula');
    const van2 = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van 2', kind: 'FIELD', assigned_membership_id: f2.membershipId }, w.owner.token)).id;
    expect(await api.sendOne(manager.token, closeCmd({ ...w, van: van2 }, {}, '0'))).toMatchObject({ reason: 'ATTENDANT_NOT_SYNCED' });
  });

  // ---------------------------------------------------------------- 6. AFTER_SETTLEMENT
  it('6. a sale reaching the server after a close with an earlier occurred_at is FLAGGED / AFTER_SETTLEMENT and saved; a later one is not', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.manager.token, closeCmd(w, { [w.maize.piece]: 10, [w.maize.carton]: 2 }, '0'))).status).toBe('ACCEPTED');
    const before = new Date(t.clock.now().getTime() - 30 * 60_000).toISOString();
    const late = fsale(w, [{ pack: w.maize.piece, qty: 1, price: '180' }], [{ method: 'CASH', amount: '180' }], before);
    expect(await api.sendOne(w.f1.token, late.cmd)).toMatchObject({ status: 'FLAGGED', reason: 'AFTER_SETTLEMENT', result: { flags: ['AFTER_SETTLEMENT'] } });
    expect(await asAdmin(async (c) => (await c.query('SELECT 1 FROM sale WHERE id = $1', [late.saleId])).rowCount)).toBe(1);
    t.clock.advanceMinutes(1);
    expect((await api.sendOne(w.f1.token, fsale(w, [{ pack: w.maize.piece, qty: 1, price: '180' }]).cmd)).status).toBe('ACCEPTED');
    // Shop sales are never flagged.
    expect((await api.sendOne(w.attendant.token, api.command('sale.create', { sale_id: randomUUID(), local_ref: 'S', location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 1, unit_price: '180' }] }, before))).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 7. concurrency (runs 5 times)
  it('7. race: two closes of one location at once serialise; the second sees an empty window', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.f1.token, fsale(w, [{ pack: w.maize.piece, qty: 2, price: '100' }], [{ method: 'CASH', amount: '200' }]).cmd)).status).toBe('ACCEPTED');
    const counts = { [w.maize.piece]: 8, [w.maize.carton]: 2 };
    const one = closeCmd(w, counts, '200');
    const two = closeCmd(w, counts, '0');
    const results = await Promise.all([api.sendOne(w.manager.token, one), api.sendOne(w.owner.token, two)]);
    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    const counted = [await settlementOf(settlementIdOf(one)), await settlementOf(settlementIdOf(two))].map((s) => s.sale_count).sort((x, y) => x - y);
    expect(counted).toEqual([0, 1]);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('7. race: a close racing 20 sales neither deadlocks nor loses a sale; each settlement\'s identity holds', async () => {
    const w = await fieldWorld();
    const sales = Array.from({ length: 20 }, () => fsale(w, [{ pack: w.maize.piece, qty: 1, price: '100' }], [{ method: 'CASH', amount: '100' }]));
    const first = closeCmd(w, { [w.maize.piece]: 5, [w.maize.carton]: 2 }, '0');
    const results = await Promise.all([...sales.slice(0, 10).map((s) => api.sendOne(w.f1.token, s.cmd)), api.sendOne(w.manager.token, first), ...sales.slice(10).map((s) => api.sendOne(w.f1.token, s.cmd))]);
    for (const r of results) expect(['ACCEPTED', 'FLAGGED'], JSON.stringify(r)).toContain(r.status);
    // The van may be below zero after the race; a count is never negative.
    const second = closeCmd(w, { [w.maize.piece]: Math.max(0, await api.balanceOf(w.owner.businessId, w.van, w.maize.piece)), [w.maize.carton]: 2 }, '0');
    const r2 = await api.sendOne(w.manager.token, second);
    expect(r2.status, JSON.stringify(r2)).toBe('ACCEPTED');
    const s1 = await settlementOf(settlementIdOf(first));
    const s2 = await settlementOf(settlementIdOf(second));
    expect(s1.sale_count + s2.sale_count).toBe(20);
    const l1 = (await linesOf(settlementIdOf(first))).find((l) => l.pack_type_id === w.maize.piece)!;
    const l2 = (await linesOf(settlementIdOf(second))).find((l) => l.pack_type_id === w.maize.piece)!;
    expect(l1.sold + l2.sold).toBe(20);
    // Identity: opening + issued - returned - sold + voided back = expected (no other movements here).
    expect(0 + l1.issued - l1.returned - l1.sold + l1.voided_back).toBe(l1.expected_quantity);
    expect(l1.counted_quantity + l2.issued - l2.returned - l2.sold + l2.voided_back).toBe(l2.expected_quantity);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('7. forced: a sale still saving during a close is counted in the next settlement, exactly once', async () => {
    const w = await fieldWorld();
    const beans = await api.newProduct(w.owner, 'Beans');
    expect((await api.sendOne(w.f1.token, fsale(w, [{ pack: w.maize.piece, qty: 1, price: '100' }]).cmd)).status).toBe('ACCEPTED'); // the counter row exists
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let done = false;
    let late: Promise<Result> | null = null;
    const first = closeCmd(w, { [w.maize.piece]: 9, [w.maize.carton]: 2 }, '0');
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM sale_counter WHERE business_id = $1 FOR UPDATE', [w.owner.businessId]);
      // A sale of beans (a new pool at the van, which the close does not lock) stops at the counter.
      late = api.sendOne(w.f1.token, fsale(w, [{ pack: beans.piece, qty: 1, price: '100' }]).cmd);
      await lockWaiters(1);
      expect((await api.sendOne(w.manager.token, first)).status).toBe('ACCEPTED');
      await held.query('COMMIT');
      done = true;
    } finally {
      if (!done) await held.query('ROLLBACK');
      await held.end();
    }
    expect((await late!).status).toBe('FLAGGED'); // beans have no stock at the van
    const second = closeCmd(w, { [w.maize.piece]: 9, [w.maize.carton]: 2, [beans.piece]: 0 }, '0');
    expect((await api.sendOne(w.manager.token, second)).status).toBe('ACCEPTED');
    expect((await settlementOf(settlementIdOf(first))).sale_count).toBe(1);
    expect((await settlementOf(settlementIdOf(second))).sale_count).toBe(1);
    expect((await linesOf(settlementIdOf(second))).find((l) => l.pack_type_id === beans.piece)).toMatchObject({ sold: 1, expected_quantity: -1, counted_quantity: 0, variance: 1 });
  });

  it('7. forced: FOR NO KEY UPDATE on the location does not deadlock with a sale that holds a pool and then saves its row', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.f1.token, fsale(w, [{ pack: w.maize.piece, qty: 1, price: '100' }]).cmd)).status).toBe('ACCEPTED');
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let done = false;
    let results: Result[] = [];
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM sale_counter WHERE business_id = $1 FOR UPDATE', [w.owner.businessId]);
      // The sale takes the van's piece pool, then waits at the counter.
      const sale = api.sendOne(w.f1.token, fsale(w, [{ pack: w.maize.piece, qty: 1, price: '100' }]).cmd);
      await lockWaiters(1);
      // The close locks the location row, then waits for that pool.
      const close = api.sendOne(w.manager.token, closeCmd(w, { [w.maize.piece]: 8, [w.maize.carton]: 2 }, '0'));
      await lockWaiters(2);
      // Released, the sale saves its row (its foreign key locks the location row FOR KEY SHARE).
      await held.query('COMMIT');
      done = true;
      results = await Promise.all([sale, close]);
    } finally {
      if (!done) await held.query('ROLLBACK');
      await held.end();
    }
    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('7. forced (found in T5): a close that arrives first but commits second is ordered by its commit; each sale counted once', async () => {
    const w = await fieldWorld();
    const sell = async () => expect((await api.sendOne(w.f1.token, fsale(w, [{ pack: w.maize.piece, qty: 1, price: '100' }]).cmd)).status).toBe('ACCEPTED');
    await sell();
    const counts = { [w.maize.piece]: 9, [w.maize.carton]: 2 };
    const early = closeCmd(w, counts, '0');
    const later = closeCmd(w, counts, '0');
    // An uncommitted command row with the early close's command id holds it at its claim, after its arrival time is taken.
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let earlyResult: Promise<Result> | null = null;
    let done = false;
    try {
      await held.query('BEGIN');
      await held.query(
        "INSERT INTO sync_command (business_id, command_id, type, occurred_at, received_at, status) VALUES ($1, $2, 'settlement.close', now(), now(), 'PROCESSING')",
        [w.owner.businessId, early.command_id],
      );
      earlyResult = api.sendOne(w.manager.token, early);
      await lockWaiters(1);
      t.clock.advanceMinutes(1);
      expect((await api.sendOne(w.owner.token, later)).status).toBe('ACCEPTED'); // arrives later, commits first
      t.clock.advanceMinutes(1);
      await held.query('ROLLBACK');
      done = true;
    } finally {
      if (!done) await held.query('ROLLBACK');
      await held.end();
    }
    expect((await earlyResult!).status).toBe('ACCEPTED');
    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ id: string; sequence: number; received_at: Date; period_start: Date; period_end: Date; sale_count: number }>(
          'SELECT id, sequence, received_at, period_start, period_end, sale_count FROM field_settlement WHERE field_location_id = $1 ORDER BY sequence',
          [w.van],
        )).rows,
    );
    expect(rows.map((r) => [r.id, r.sequence])).toEqual([
      [settlementIdOf(later), 1],
      [settlementIdOf(early), 2],
    ]);
    // The early close's period starts where the later one's ended, and does not run backwards.
    expect(rows[1].period_start).toEqual(rows[0].period_end);
    expect(rows[1].period_end.getTime()).toBeGreaterThanOrEqual(rows[1].period_start.getTime());
    expect(rows[1].received_at.getTime()).toBeLessThan(rows[0].period_end.getTime());
    // A sale after both (made after them, so not AFTER_SETTLEMENT) goes to the next settlement only.
    t.clock.advanceMinutes(1);
    await sell();
    await sync(w.f1);
    const third = closeCmd(w, { [w.maize.piece]: 8, [w.maize.carton]: 2 }, '0');
    expect((await api.sendOne(w.manager.token, third)).status).toBe('ACCEPTED');
    const counted = await asAdmin(async (c) => (await c.query<{ sale_count: number }>('SELECT sale_count FROM field_settlement WHERE field_location_id = $1 ORDER BY sequence', [w.van])).rows.map((r) => r.sale_count));
    expect(counted).toEqual([1, 0, 1]);
  });

  // ---------------------------------------------------------------- 8. final
  it('8. a settlement is final: app_user cannot change it, a second command with its id is SETTLEMENT_ALREADY_EXISTS, the same command twice closes once', async () => {
    const w = await fieldWorld();
    const cmd = closeCmd(w, { [w.maize.piece]: 10, [w.maize.carton]: 2 }, '0');
    const first = await api.sendOne(w.manager.token, cmd);
    expect(first.status).toBe('ACCEPTED');
    expect(await api.sendOne(w.manager.token, cmd)).toEqual(first);
    expect(await api.sendOne(w.manager.token, { ...cmd, command_id: randomUUID() })).toMatchObject({ status: 'REJECTED', reason: 'SETTLEMENT_ALREADY_EXISTS' });
    expect(await asAdmin(async (c) => (await c.query('SELECT 1 FROM field_settlement')).rowCount)).toBe(1);
    const outcomes = await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [w.owner.businessId]);
      const out: string[] = [];
      for (const sql of ["UPDATE field_settlement SET note = 'x'", 'DELETE FROM field_settlement', 'UPDATE field_settlement_line SET counted_quantity = 0', 'DELETE FROM field_settlement_line']) {
        await c.query('SAVEPOINT a');
        try {
          await c.query(sql);
          out.push('ok');
        } catch (err) {
          out.push((err as { code: string }).code);
        }
        await c.query('ROLLBACK TO SAVEPOINT a');
      }
      await c.query('ROLLBACK');
      return out;
    });
    expect(outcomes).toEqual(['42501', '42501', '42501', '42501']);
  });

  // ---------------------------------------------------------------- 9. permissions and reads
  it('9. only field.settle closes and reads; the list is newest first with a signed cursor; another business\'s settlement is 404', async () => {
    const w = await fieldWorld();
    const b = await fieldWorld('Duka B');
    const counts = { [w.maize.piece]: 10, [w.maize.carton]: 2 };
    for (const who of [w.f1, w.attendant]) expect(await api.sendOne(who.token, closeCmd(w, counts, '0'))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    const ids: string[] = [];
    for (const who of [w.manager, w.owner, w.manager]) {
      const cmd = closeCmd(w, counts, '0');
      expect((await api.sendOne(who.token, cmd)).status).toBe('ACCEPTED');
      ids.push(settlementIdOf(cmd));
      t.clock.advanceMinutes(1);
      await sync(w.f1);
    }
    const bCmd = closeCmd(b, { [b.maize.piece]: 10, [b.maize.carton]: 2 }, '0');
    expect((await api.sendOne(b.manager.token, bCmd)).status).toBe('ACCEPTED');
    type List = { settlements: { id: string }[]; next_cursor: string | null };
    const page1 = api.json<List>(await api.call('GET', '/v1/field/settlements?limit=2', w.manager.token));
    expect(page1.settlements.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    const page2 = api.json<List>(await api.call('GET', `/v1/field/settlements?limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`, w.manager.token));
    expect(page2).toEqual({ settlements: [expect.objectContaining({ id: ids[0] })], next_cursor: null });
    expect((await api.call('GET', `/v1/field/settlements?limit=2&location_id=${w.loc}&cursor=${encodeURIComponent(page1.next_cursor!)}`, w.manager.token)).statusCode).toBe(422);
    const detail = api.json<{ id: string; lines: unknown[]; cash_received: string }>(await api.call('GET', `/v1/field/settlements/${ids[0]}`, w.owner.token));
    expect(detail).toMatchObject({ id: ids[0], cash_received: '0.00' });
    expect(detail.lines).toHaveLength(2);
    for (const who of [w.f1, w.attendant]) expect((await api.call('GET', '/v1/field/settlements', who.token)).statusCode).toBe(403);
    for (const id of [settlementIdOf(bCmd), randomUUID(), 'not-a-uuid']) expect((await api.call('GET', `/v1/field/settlements/${id}`, w.manager.token)).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- 10. audit
  it('10. audit settlement.closed once without the note; a crash after the audit insert leaves no settlement, no adjustment, the balance unchanged', async () => {
    const w = await fieldWorld();
    const cmd = closeCmd(w, { [w.maize.piece]: 9, [w.maize.carton]: 2 }, '5', { note: 'secret settlement note' });
    expect((await api.sendOne(w.manager.token, cmd)).status).toBe('ACCEPTED');
    const audit = await asAdmin(
      async (c) =>
        (await c.query<{ actor_membership_id: string; metadata: Record<string, unknown> }>("SELECT actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action = 'settlement.closed'", [w.owner.businessId])).rows,
    );
    expect(audit).toEqual([
      {
        actor_membership_id: w.manager.membershipId,
        metadata: {
          settlement_id: settlementIdOf(cmd),
          attendant_membership_id: w.f1.membershipId,
          location_id: w.van,
          sale_count: 0,
          expected_cash: '0.00',
          cash_received: '5.00',
          cash_variance: '5.00',
          variance_lines: 1,
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('secret');
    expect(JSON.stringify(audit)).not.toContain('Otieno');

    const state = () =>
      asAdmin(async (c) => ({
        settlements: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM field_settlement')).rows[0].n),
        lines: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM field_settlement_line')).rows[0].n),
        adjustments: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stock_movement WHERE settlement_id IS NOT NULL')).rows[0].n),
        audit: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0].n),
        balances: (await c.query('SELECT location_id, pack_type_id, quantity FROM stock_balance ORDER BY location_id, pack_type_id')).rows,
      }));
    const before = await state();
    const auditService = t.app.get(AuditService, { strict: false });
    const original = auditService.record.bind(auditService);
    vi.spyOn(auditService, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('crash after the audit write');
    });
    expect(await api.sendOne(w.manager.token, closeCmd(w, { [w.maize.piece]: 4, [w.maize.carton]: 1 }, '0'))).toMatchObject({ status: 'FAILED' });
    expect(await state()).toEqual(before);
  });
});
