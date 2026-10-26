import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PRESET_PERMISSIONS } from '../src/common/auth/permissions.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, OWNER_PIN, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase E5: sale.void and SALE_VOID approvals (docs/phase-e-design.md
// sections 5 and 6). Numbers in test names refer to the E5 list in section 13.

describe('E5: void and approvals', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.183', 98_300_000);
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

  // ---------------------------------------------------------------- helpers
  /** A sale by `by` of 2 maize pieces and 1 carton (every line at 100.00), with payments; returns its id. */
  async function sell(w: World, by: Member, opts: { loc?: string; payments?: object[]; packs?: { pack: string; qty: number }[] } = {}): Promise<string> {
    const saleId = randomUUID();
    const lines = (opts.packs ?? [{ pack: w.maize.piece, qty: 2 }, { pack: w.maize.carton, qty: 1 }]).map((l) => ({ pack_type_id: l.pack, quantity: l.qty, unit_price: '100' }));
    const r = await api.sendOne(by.token, api.command('sale.create', { sale_id: saleId, local_ref: 'V', location_id: opts.loc ?? w.loc, lines, payments: opts.payments ?? [] }));
    expect(['ACCEPTED', 'FLAGGED'], JSON.stringify(r)).toContain(r.status);
    return saleId;
  }
  const voidCmd = (saleId: string, extra: object = {}, occurredAt?: string) => api.command('sale.void', { sale_id: saleId, reason: 'MISTAKE', ...extra }, occurredAt);
  const mint = (caller: Member, approver: string, pin: string, purpose = 'SALE_VOID') =>
    api.post('/v1/stock/approvals', { approver_membership_id: approver, approver_pin: pin, purpose }, caller.token);
  async function approval(caller: Member, approver: Member, purpose = 'SALE_VOID'): Promise<string> {
    const res = await mint(caller, approver.membershipId, STAFF_PIN, purpose);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ approval_id: string }>(res).approval_id;
  }
  const stockUp = (w: World, loc = w.loc) =>
    api.sendOne(w.manager.token, api.command('stock.receive', { location_id: loc, lines: [{ pack_type_id: w.maize.piece, quantity: 50 }, { pack_type_id: w.maize.carton, quantity: 10 }] }));
  const saleRow = (id: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ status: string; voided_at: Date | null; voided_by_membership_id: string | null; void_reason: string | null; void_note: string | null; void_approval_id: string | null; void_approved_by_membership_id: string | null; paid_total: string; balance_due: string }>(
          'SELECT status, voided_at, voided_by_membership_id, void_reason, void_note, void_approval_id, void_approved_by_membership_id, paid_total::text, balance_due::text FROM sale WHERE id = $1',
          [id],
        )).rows[0],
    );
  const paymentStatuses = (saleId: string) =>
    asAdmin(async (c) => (await c.query<{ status: string }>('SELECT status FROM payment WHERE sale_id = $1 ORDER BY amount', [saleId])).rows.map((r) => r.status));
  const voidMovements = (saleId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ pack_type_id: string; location_id: string; quantity_change: number; quantity_after: number; created_by_membership_id: string; occurred_at: Date }>(
          "SELECT pack_type_id, location_id, quantity_change, quantity_after, created_by_membership_id, occurred_at FROM stock_movement WHERE sale_id = $1 AND movement_type = 'SALE_VOID'",
          [saleId],
        )).rows,
    );
  const consumed = (approvalId: string) =>
    asAdmin(async (c) => (await c.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM approval WHERE id = $1', [approvalId])).rows[0].consumed_at);
  const denial = (res: LightMyRequestResponse) => {
    const body = res.json() as { error: { code: string; message: string } };
    return { status: res.statusCode, code: body.error.code, message: body.error.message };
  };
  /** Waits until at least n backends of the test database wait for a lock (forces the overlap in race tests). */
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
  /** Holds a row lock in an open admin transaction while `race` runs; commits once `waiters` commands are blocked on it. */
  async function holdWhile<T>(lockSql: string, params: unknown[], waiters: number, race: () => Promise<T>[]): Promise<T[]> {
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let done = false;
    try {
      await held.query('BEGIN');
      await held.query(lockSql, params);
      const pending = race();
      await lockWaiters(waiters);
      await held.query('COMMIT');
      done = true;
      return await Promise.all(pending);
    } finally {
      if (!done) await held.query('ROLLBACK');
      await held.end();
    }
  }
  const pinLogin = (m: Member) => api.post('/v1/auth/pin', { device_id: m.deviceId, device_secret: m.deviceSecret, pin: STAFF_PIN });
  async function relogin(m: Member): Promise<void> {
    const res = await pinLogin(m);
    expect(res.statusCode, res.body).toBe(200);
    m.token = api.json<{ access_token: string }>(res).access_token;
  }

  // ---------------------------------------------------------------- 1. a manager voids
  it('1. a manager voids a sale: VOIDED with the void fields, payments REVERSED, one SALE_VOID movement per item, balances restored', async () => {
    const w = await api.world();
    await stockUp(w);
    const s = await sell(w, w.attendant, {
      packs: [{ pack: w.maize.piece, qty: 2 }, { pack: w.maize.carton, qty: 1 }, { pack: w.maize.piece, qty: 3 }],
      payments: [{ method: 'CASH', amount: '100' }, { method: 'MPESA', amount: '200', mpesa_code: 'VOIDCODE01' }],
    });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(45);
    const cmd = voidCmd(s, { reason: 'CUSTOMER_CANCELLED', note: 'changed mind' }, '2026-10-25T09:30:00.000Z');
    const r = await api.sendOne(w.manager.token, cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: { sale_id: s, voided_at: '2026-10-25T09:30:00.000Z', approved_by_membership_id: w.manager.membershipId },
    });
    expect(await saleRow(s)).toEqual({
      status: 'VOIDED',
      voided_at: new Date('2026-10-25T09:30:00.000Z'),
      voided_by_membership_id: w.manager.membershipId,
      void_reason: 'CUSTOMER_CANCELLED',
      void_note: 'changed mind',
      void_approval_id: null,
      void_approved_by_membership_id: w.manager.membershipId,
      paid_total: '300.00', // a record of what was paid (decided in E5)
      balance_due: '300.00', // 600.00 total (every line at 100.00), 300.00 paid
    });
    expect(await paymentStatuses(s)).toEqual(['REVERSED', 'REVERSED']);
    const moves = await voidMovements(s);
    const key = (pack: string, q: number) => `${pack}:${q}`;
    expect(moves.map((m) => key(m.pack_type_id, m.quantity_change)).sort((x, y) => x.localeCompare(y))).toEqual([key(w.maize.carton, 1), key(w.maize.piece, 2), key(w.maize.piece, 3)].sort((x, y) => x.localeCompare(y)));
    for (const m of moves) expect(m).toMatchObject({ location_id: w.loc, created_by_membership_id: w.manager.membershipId, occurred_at: new Date('2026-10-25T09:30:00.000Z') });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(50);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(10);
    // The carton (larger pack) was put back first: the lock order.
    expect((await api.balanceLog(w.owner.businessId)).slice(-3)[0].pack_type_id).toBe(w.maize.carton);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. twice
  it('2. a second void is SALE_ALREADY_VOIDED and stock is restored once', async () => {
    const w = await api.world();
    await stockUp(w);
    const s = await sell(w, w.manager);
    expect((await api.sendOne(w.manager.token, voidCmd(s))).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.owner.token, voidCmd(s))).toMatchObject({ status: 'REJECTED', reason: 'SALE_ALREADY_VOIDED' });
    expect(await voidMovements(s)).toHaveLength(2);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(50);
  });

  it('2. race: 20 concurrent voids of one sale give exactly one ACCEPTED and one stock return (forced overlap)', async () => {
    const w = await api.world();
    await stockUp(w);
    const s = await sell(w, w.manager);
    const results = await holdWhile('SELECT 1 FROM sale WHERE id = $1 FOR UPDATE', [s], 8, () =>
      Array.from({ length: 20 }, (_, i) => api.sendOne((i % 2 ? w.manager : w.owner).token, voidCmd(s))),
    );
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'REJECTED' && r.reason === 'SALE_ALREADY_VOIDED')).toHaveLength(19);
    expect(await voidMovements(s)).toHaveLength(2);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(50);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(10);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 3. attendants
  it('3. an attendant needs a SALE_VOID approval: denied without, voids with one, the approval is used once', async () => {
    const w = await api.world();
    await stockUp(w);
    const s1 = await sell(w, w.attendant);
    const s2 = await sell(w, w.attendant);
    expect(await api.sendOne(w.attendant.token, voidCmd(s1))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED', message: 'You are not allowed to do this' });
    const id = await approval(w.attendant, w.manager);
    const cmd = voidCmd(s1, { approval_id: id });
    expect(await api.sendOne(w.attendant.token, cmd)).toMatchObject({ status: 'ACCEPTED', result: { approved_by_membership_id: w.manager.membershipId } });
    expect(await saleRow(s1)).toMatchObject({ status: 'VOIDED', voided_by_membership_id: w.attendant.membershipId, void_approval_id: id, void_approved_by_membership_id: w.manager.membershipId });
    const row = await asAdmin(async (c) => (await c.query('SELECT consumed_at, consumed_by_sync_command_id FROM approval WHERE id = $1', [id])).rows[0]);
    expect(row.consumed_by_sync_command_id).toBe((await api.syncCommand(w.owner.businessId, cmd.command_id)).id);
    // Used once: a second sale with it is APPROVAL_INVALID.
    expect(await api.sendOne(w.attendant.token, voidCmd(s2, { approval_id: id }))).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });
    expect((await saleRow(s2)).status).toBe('COMPLETED');

    // A manager's approval_id is ignored and not used.
    const unused = await approval(w.attendant, w.manager);
    expect(await api.sendOne(w.manager.token, voidCmd(s2, { approval_id: unused }))).toMatchObject({ status: 'ACCEPTED', result: { approved_by_membership_id: w.manager.membershipId } });
    expect(await consumed(unused)).toBeNull();
    expect((await saleRow(s2)).void_approval_id).toBeNull();

    // Even with an approval, an attendant cannot void another member's sale: SALE_NOT_FOUND, approval unused.
    const mgrSale = await sell(w, w.manager);
    expect(await api.sendOne(w.attendant.token, voidCmd(mgrSale, { approval_id: unused }))).toMatchObject({ status: 'REJECTED', reason: 'SALE_NOT_FOUND' });
    expect(await consumed(unused)).toBeNull();
  });

  it('3. race: 20 concurrent voids of 20 sales with one approval give exactly one ACCEPTED (forced overlap)', async () => {
    const w = await api.world();
    await stockUp(w);
    const sales: string[] = [];
    for (let i = 0; i < 20; i++) sales.push(await sell(w, w.attendant, { packs: [{ pack: w.maize.piece, qty: 1 }] }));
    const id = await approval(w.attendant, w.manager);
    const results = await holdWhile('SELECT 1 FROM approval WHERE id = $1 FOR UPDATE', [id], 8, () => sales.map((s) => api.sendOne(w.attendant.token, voidCmd(s, { approval_id: id }))));
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'REJECTED' && r.reason === 'APPROVAL_INVALID')).toHaveLength(19);
    const statuses = await asAdmin(async (c) => (await c.query<{ status: string }>('SELECT status FROM sale WHERE id = ANY($1::uuid[])', [sales])).rows.map((r) => r.status));
    expect(statuses.filter((x) => x === 'VOIDED')).toHaveLength(1);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. approval rules
  it('4. approval rules: purpose, member, device, time limits, live approver; minting rules; shared counters', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    await stockUp(w);
    const attendant2 = await api.activeStaff(w.owner, 'ATTENDANT', 'Esther');
    const s = await sell(w, w.attendant, { packs: [{ pack: w.maize.piece, qty: 1 }] });
    const invalid = { status: 'REJECTED', reason: 'APPROVAL_INVALID' };

    // Purpose: a STOCK_CONVERT approval cannot void, and a SALE_VOID approval cannot convert.
    const convertApproval = await approval(w.attendant, w.manager, 'STOCK_CONVERT');
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: convertApproval }))).toMatchObject(invalid);
    const voidApproval = await approval(w.attendant, w.manager);
    const convert = api.command('stock.convert', { location_id: w.loc, from_pack_type_id: w.maize.carton, to_pack_type_id: w.maize.piece, quantity: 1, approval_id: voidApproval });
    expect(await api.sendOne(w.attendant.token, convert)).toMatchObject(invalid);
    expect(await consumed(convertApproval)).toBeNull();
    expect(await consumed(voidApproval)).toBeNull();

    // Another member's approval; another device; another business's approval; expired by occurred_at.
    const s2 = await sell(w, attendant2, { packs: [{ pack: w.maize.piece, qty: 1 }] });
    expect(await api.sendOne(attendant2.token, voidCmd(s2, { approval_id: voidApproval }))).toMatchObject(invalid);
    const sync = t.app.get(SyncService, { strict: false });
    const [otherDevice] = await sync.processCommands(
      { businessId: w.owner.businessId, membershipId: w.attendant.membershipId, deviceId: randomUUID(), permissions: PRESET_PERMISSIONS.ATTENDANT },
      [voidCmd(s, { approval_id: voidApproval })],
    );
    expect(otherDevice).toMatchObject({ status: 'REJECTED', code: 'APPROVAL_INVALID' });
    const foreign = await approval(b.attendant, b.manager);
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: foreign }))).toMatchObject(invalid);
    const late = new Date(t.clock.now().getTime() + 16 * 60_000).toISOString();
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: voidApproval }, late))).toMatchObject(invalid);
    expect(await consumed(voidApproval)).toBeNull();

    // The approver no longer holds sales.void (now an attendant).
    const manager2 = await api.activeStaff(w.owner, 'MANAGER', 'Faith');
    const demoted = await approval(w.attendant, manager2);
    expect((await api.call('PATCH', `/v1/staff/${manager2.membershipId}`, w.owner.token, { role_preset: 'ATTENDANT' })).statusCode).toBe(204);
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: demoted }))).toMatchObject(invalid);

    // Minting: an attendant as approver is the same 403; a caller with sales.void needs none.
    expect(denial(await mint(w.attendant, attendant2.membershipId, STAFF_PIN))).toEqual({ status: 403, code: 'APPROVAL_DENIED', message: 'The approval was not given.' });
    expect(denial(await mint(w.manager, w.owner.membershipId, STAFF_PIN))).toMatchObject({ status: 422, code: 'APPROVAL_NOT_NEEDED' });
    // Who could approve a void: members with sales.void other than the caller.
    const list = api.json<{ approvers: { membership_id: string }[] }>(await api.call('GET', '/v1/stock/approvers?purpose=SALE_VOID', w.attendant.token));
    expect(new Set(list.approvers.map((a) => a.membership_id))).toEqual(new Set([w.owner.membershipId, w.manager.membershipId]));
    expect((await api.call('GET', '/v1/stock/approvers?purpose=REFUND', w.attendant.token)).statusCode).toBe(422);
    expect((await api.call('GET', '/v1/stock/approvers', w.attendant.token)).statusCode).toBe(200);

    // The counters are shared: three wrong PINs for STOCK_CONVERT and two for SALE_VOID lock the approver.
    for (let i = 0; i < 3; i++) expect((await mint(w.attendant, w.manager.membershipId, '0000', 'STOCK_CONVERT')).statusCode).toBe(403);
    for (let i = 0; i < 2; i++) expect((await mint(w.attendant, w.manager.membershipId, '0000')).statusCode).toBe(403);
    expect((await mint(w.attendant, w.manager.membershipId, STAFF_PIN)).statusCode).toBe(403); // locked: the right PIN is refused too

    // Older than 24 hours at receipt (the owner approves: the manager is locked now).
    const res = await mint(w.attendant, w.owner.membershipId, OWNER_PIN);
    expect(res.statusCode, res.body).toBe(201);
    const ownerApproval = api.json<{ approval_id: string }>(res).approval_id;
    const minted = t.clock.now();
    t.clock.advanceMinutes(25 * 60);
    await relogin(w.attendant);
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: ownerApproval }, minted.toISOString()))).toMatchObject(invalid);
    expect((await saleRow(s)).status).toBe('COMPLETED');
  });

  // ---------------------------------------------------------------- 5. failed voids
  it('5. a void that fails leaves the approval unused, also when it fails after the approval was used', async () => {
    const w = await api.world();
    await stockUp(w);
    const voided = await sell(w, w.attendant);
    expect((await api.sendOne(w.manager.token, voidCmd(voided))).status).toBe('ACCEPTED');
    const id = await approval(w.attendant, w.manager);
    expect(await api.sendOne(w.attendant.token, voidCmd(voided, { approval_id: id }))).toMatchObject({ reason: 'SALE_ALREADY_VOIDED' });
    expect(await api.sendOne(w.attendant.token, voidCmd(randomUUID(), { approval_id: id }))).toMatchObject({ reason: 'SALE_NOT_FOUND' });
    expect(await consumed(id)).toBeNull();
    // A crash after the approval, the sale update and the payments: everything rolls back.
    const s = await sell(w, w.attendant, { payments: [{ method: 'CASH', amount: '10' }] });
    vi.spyOn(t.app.get(StockService, { strict: false }), 'returnForVoid').mockRejectedValueOnce(new Error('crash while returning stock'));
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: id }))).toMatchObject({ status: 'FAILED' });
    expect(await consumed(id)).toBeNull();
    expect((await saleRow(s)).status).toBe('COMPLETED');
    expect(await paymentStatuses(s)).toEqual(['RECORDED']);
    // The approval still works.
    expect(await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: id }))).toMatchObject({ status: 'ACCEPTED' });
  });

  // ---------------------------------------------------------------- 6. not found
  it('6. an unknown sale and another business\'s sale are the same SALE_NOT_FOUND', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    const foreign = await sell(b, b.manager);
    const unknown = await api.sendOne(w.manager.token, voidCmd(randomUUID()));
    const other = await api.sendOne(w.manager.token, voidCmd(foreign));
    expect(unknown).toMatchObject({ status: 'REJECTED', reason: 'SALE_NOT_FOUND' });
    expect(other).toEqual({ ...unknown, command_id: other.command_id });
    expect((await saleRow(foreign)).status).toBe('COMPLETED');
  });

  // ---------------------------------------------------------------- 7. voided sales and payments
  it('7. a voided sale blocks payment.attach; an attach racing a void never leaves a RECORDED payment on a voided sale', async () => {
    const w = await api.world();
    const s = await sell(w, w.manager);
    expect((await api.sendOne(w.manager.token, voidCmd(s))).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.manager.token, api.command('payment.attach', { sale_id: s, payments: [{ method: 'CASH', amount: '1' }] }))).toMatchObject({ status: 'REJECTED', reason: 'SALE_VOIDED' });
    for (let round = 0; round < 10; round++) {
      const r = await sell(w, w.manager, { packs: [{ pack: w.maize.piece, qty: 1 }] });
      const [attach, voidResult] = await Promise.all([
        api.sendOne(w.manager.token, api.command('payment.attach', { sale_id: r, payments: [{ method: 'CASH', amount: '5' }] })),
        api.sendOne(w.owner.token, voidCmd(r)),
      ]);
      expect(voidResult.status).toBe('ACCEPTED');
      expect(['ACCEPTED', 'REJECTED:SALE_VOIDED']).toContain(attach.status === 'REJECTED' ? `REJECTED:${attach.reason}` : attach.status);
      expect(await paymentStatuses(r)).toEqual(attach.status === 'ACCEPTED' ? ['REVERSED'] : []);
    }
  });

  it('7. race (found by E6): a void and a sale reusing the voided sale\'s M-Pesa code on the same pool never deadlock (forced interleaving)', async () => {
    const w = await api.world();
    await stockUp(w);
    const s = await sell(w, w.manager, { packs: [{ pack: w.maize.piece, qty: 1 }], payments: [{ method: 'MPESA', amount: '100', mpesa_code: 'RACECODE77' }] });
    const reuse = api.command('sale.create', {
      sale_id: randomUUID(),
      local_ref: 'R',
      location_id: w.loc,
      lines: [{ pack_type_id: w.maize.piece, quantity: 1, unit_price: '100' }],
      payments: [{ method: 'MPESA', amount: '100', mpesa_code: 'RACECODE77' }],
    });
    // Hold the sale counter: the new sale takes its stock pool, then waits at the counter.
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let done = false;
    let results: Awaited<ReturnType<typeof api.sendOne>>[] = [];
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM sale_counter WHERE business_id = $1 FOR UPDATE', [w.owner.businessId]);
      const sale = api.sendOne(w.attendant.token, reuse);
      await lockWaiters(1);
      // The void now waits for that same pool (and, in the old order, has already reversed the payment with the code).
      const voided = api.sendOne(w.manager.token, voidCmd(s));
      await lockWaiters(2);
      await held.query('COMMIT');
      done = true;
      results = await Promise.all([sale, voided]);
    } finally {
      if (!done) await held.query('ROLLBACK');
      await held.end();
    }
    const [sale, voided] = results;
    expect(voided).toMatchObject({ status: 'ACCEPTED' });
    expect(sale).toMatchObject({ status: 'FLAGGED', result: { flags: expect.arrayContaining(['DUPLICATE_MPESA_CODE']) } });
    expect(await paymentStatuses(s)).toEqual(['REVERSED']);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 8. archived and location
  it('8. stock returns for archived pack types, at the sale\'s own location', async () => {
    const w = await api.world();
    const store = await api.newLocation(w.owner, 'Back store');
    await stockUp(w, store);
    const s = await sell(w, w.manager, { loc: store });
    const archive = api.command('pack_type.upsert', { pack_type_id: w.maize.carton, product_id: w.maize.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4200', archived: true });
    expect((await api.sendOne(w.owner.token, archive)).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, voidCmd(s))).status).toBe('ACCEPTED');
    expect(await api.balanceOf(w.owner.businessId, store, w.maize.carton)).toBe(10);
    expect(await api.balanceOf(w.owner.businessId, store, w.maize.piece)).toBe(50);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(0);
    for (const m of await voidMovements(s)) expect(m.location_id).toBe(store);
  });

  // ---------------------------------------------------------------- 9. audit and change log
  it('9. audit sale.voided once with the approver, approval.granted for SALE_VOID; no note; change_log rows', async () => {
    const w = await api.world();
    await stockUp(w);
    const s = await sell(w, w.attendant, { payments: [{ method: 'CASH', amount: '10' }] });
    const id = await approval(w.attendant, w.manager);
    const before = await asAdmin(async (c) => (await c.query<{ m: string }>('SELECT max(id)::text AS m FROM change_log WHERE business_id = $1', [w.owner.businessId])).rows[0].m);
    expect((await api.sendOne(w.attendant.token, voidCmd(s, { approval_id: id, note: 'secret void note' }))).status).toBe('ACCEPTED');
    const audit = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string; metadata: Record<string, unknown> }>(
          "SELECT action, actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action IN ('sale.voided', 'approval.granted') ORDER BY action",
          [w.owner.businessId],
        )).rows,
    );
    expect(audit).toEqual([
      { action: 'approval.granted', actor_membership_id: w.attendant.membershipId, metadata: { requester_membership_id: w.attendant.membershipId, approver_membership_id: w.manager.membershipId, purpose: 'SALE_VOID' } },
      { action: 'sale.voided', actor_membership_id: w.attendant.membershipId, metadata: { sale_id: s, sale_number: 1, reason: 'MISTAKE', approver_membership_id: w.manager.membershipId, approval_id: id } },
    ]);
    expect(JSON.stringify(audit)).not.toContain('secret void note');
    const logged = await asAdmin(
      async (c) =>
        (await c.query<{ table_name: string }>('SELECT table_name FROM change_log WHERE business_id = $1 AND id > $2::bigint', [w.owner.businessId, before])).rows.map((r) => r.table_name),
    );
    expect(new Set(logged)).toEqual(new Set(['sale', 'payment', 'stock_balance']));
    expect(logged.filter((x) => x === 'stock_balance')).toHaveLength(2);
  });
});
