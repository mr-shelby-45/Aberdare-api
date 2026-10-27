import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type Result, type World, stockApi } from './helpers/stock-api.js';

// Phase T3: stock.issue and stock.return (docs/phase-t-design.md section 5).
// Test numbers follow the T3 list in section 11.

describe('T3: issue and return', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.192', 99_200_000);
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
    store: string;
  }
  async function fieldWorld(name = 'Duka A'): Promise<FieldWorld> {
    const w = await api.world(name);
    const f1 = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const created = await api.post('/v1/locations', { name: 'Van 1', kind: 'FIELD', assigned_membership_id: f1.membershipId }, w.owner.token);
    expect(created.statusCode, created.body).toBe(201);
    const storeRes = await api.post('/v1/locations', { name: 'Store', kind: 'WAREHOUSE' }, w.owner.token);
    const store = api.json<{ id: string }>(storeRes).id;
    const stock = api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 20 }, { pack_type_id: w.maize.carton, quantity: 5 }] });
    expect((await api.sendOne(w.manager.token, stock)).status).toBe('ACCEPTED');
    return { ...w, f1, van: api.json<{ id: string }>(created).id, store };
  }
  const line = (pack: string, quantity: number) => ({ pack_type_id: pack, quantity });
  const issue = (from: string, to: string, lines: object[], extra: object = {}) => api.command('stock.issue', { from_location_id: from, to_location_id: to, lines, ...extra });
  const ret = (from: string, to: string, lines: object[], extra: object = {}) => api.command('stock.return', { from_location_id: from, to_location_id: to, lines, ...extra });
  const bal = (w: World, loc: string, pack: string) => api.balanceOf(w.owner.businessId, loc, pack);
  const transferRows = (businessId: string) =>
    asAdmin(async (c) => (await c.query('SELECT id, kind, from_location_id, to_location_id, created_by_membership_id, sync_command_id, reference, note FROM stock_transfer WHERE business_id = $1', [businessId])).rows);
  const transferMovements = (transferId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ location_id: string; pack_type_id: string; movement_type: string; quantity_change: number; quantity_after: number; note: string | null; reference: string | null }>(
          'SELECT location_id, pack_type_id, movement_type, quantity_change, quantity_after, note, reference FROM stock_movement WHERE transfer_id = $1',
          [transferId],
        )).rows,
    );
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

  // ---------------------------------------------------------------- 1. an issue and a return
  it('1. an issue moves stock: one transfer, a TRANSFER_OUT and a TRANSFER_IN per line; a return reverses it', async () => {
    const w = await fieldWorld();
    const cmd = issue(w.loc, w.van, [line(w.maize.piece, 10), line(w.maize.carton, 2)], { reference: 'MORNING-1', note: 'route A' });
    const r = await api.sendOne(w.manager.token, cmd);
    const transferId = (r.result as { transfer_id: string }).transfer_id;
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: {
        transfer_id: transferId,
        lines: [
          { pack_type_id: w.maize.piece, from_after: 10, to_after: 10 },
          { pack_type_id: w.maize.carton, from_after: 3, to_after: 2 },
        ],
      },
    });
    const syncId = (await api.syncCommand(w.owner.businessId, cmd.command_id)).id;
    expect(await transferRows(w.owner.businessId)).toEqual([
      { id: transferId, kind: 'ISSUE', from_location_id: w.loc, to_location_id: w.van, created_by_membership_id: w.manager.membershipId, sync_command_id: syncId, reference: 'MORNING-1', note: 'route A' },
    ]);
    const moves = await transferMovements(transferId);
    expect(moves).toHaveLength(4);
    expect(moves).toEqual(
      expect.arrayContaining([
        { location_id: w.loc, pack_type_id: w.maize.piece, movement_type: 'TRANSFER_OUT', quantity_change: -10, quantity_after: 10, note: null, reference: null },
        { location_id: w.van, pack_type_id: w.maize.piece, movement_type: 'TRANSFER_IN', quantity_change: 10, quantity_after: 10, note: null, reference: null },
        { location_id: w.loc, pack_type_id: w.maize.carton, movement_type: 'TRANSFER_OUT', quantity_change: -2, quantity_after: 3, note: null, reference: null },
        { location_id: w.van, pack_type_id: w.maize.carton, movement_type: 'TRANSFER_IN', quantity_change: 2, quantity_after: 2, note: null, reference: null },
      ]),
    );
    // The return, to the warehouse this time.
    const back = await api.sendOne(w.owner.token, ret(w.van, w.store, [line(w.maize.piece, 4)]));
    expect(back).toMatchObject({ status: 'ACCEPTED', result: { lines: [{ pack_type_id: w.maize.piece, from_after: 6, to_after: 4 }] } });
    expect(await bal(w, w.van, w.maize.piece)).toBe(6);
    expect(await bal(w, w.store, w.maize.piece)).toBe(4);
    expect((await transferRows(w.owner.businessId)).map((x) => String(x.kind)).sort((a, b) => a.localeCompare(b))).toEqual(['ISSUE', 'RETURN']);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. strict
  it('2. an issue or return of more than the source holds is STOCK_INSUFFICIENT and nothing changes', async () => {
    const w = await fieldWorld();
    const before = { shop: await bal(w, w.loc, w.maize.piece), cartons: await bal(w, w.loc, w.maize.carton) };
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 21)]))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    // The second line is short: the first one is undone too.
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 5), line(w.maize.carton, 6)]))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    expect({ shop: await bal(w, w.loc, w.maize.piece), cartons: await bal(w, w.loc, w.maize.carton) }).toEqual(before);
    expect(await bal(w, w.van, w.maize.piece)).toBe(0);
    expect(await transferRows(w.owner.businessId)).toEqual([]);
    // A return of more than the field balance.
    expect((await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 3)]))).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.manager.token, ret(w.van, w.loc, [line(w.maize.piece, 4)]))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    expect(await bal(w, w.van, w.maize.piece)).toBe(3);
    expect(await transferRows(w.owner.businessId)).toHaveLength(1);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 3. kinds and archived
  it('3. location kinds and archived states; archived pack types refused on an issue, allowed on a return', async () => {
    const w = await fieldWorld();
    const kindInvalid = { status: 'REJECTED', reason: 'LOCATION_KIND_INVALID' };
    const p = [line(w.maize.piece, 1)];
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.store, p))).toMatchObject(kindInvalid); // to a non-field location
    expect(await api.sendOne(w.manager.token, issue(w.van, w.loc, p))).toMatchObject(kindInvalid); // from a field location
    expect(await api.sendOne(w.manager.token, ret(w.loc, w.store, p))).toMatchObject(kindInvalid); // shop to warehouse
    expect(await api.sendOne(w.manager.token, ret(w.loc, w.van, p))).toMatchObject(kindInvalid); // a return into a field location
    expect((await api.sendOne(w.manager.token, issue(w.store, w.van, p))).status).toBe('REJECTED'); // warehouse has no stock: kind fine, STOCK_INSUFFICIENT
    expect((await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 5), line(w.maize.carton, 2)]))).status).toBe('ACCEPTED');

    // Archived pack type: an issue line is bad, a return takes it back.
    const archive = api.command('pack_type.upsert', { pack_type_id: w.maize.carton, product_id: w.maize.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4200', archived: true });
    expect((await api.sendOne(w.owner.token, archive)).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.carton, 1)]))).toMatchObject({ reason: 'INVALID_LINES', result: { invalid_lines: [{ line: 1, reason: 'PACK_TYPE_ARCHIVED' }] } });
    expect((await api.sendOne(w.manager.token, ret(w.van, w.loc, [line(w.maize.carton, 1)]))).status).toBe('ACCEPTED');

    // Archived locations: an issue needs both ends active; a return may come from an archived van, never into an archived store.
    expect((await api.call('PATCH', `/v1/locations/${w.van}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, p))).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_ARCHIVED' });
    expect((await api.sendOne(w.manager.token, ret(w.van, w.loc, [line(w.maize.piece, 2)]))).status).toBe('ACCEPTED');
    expect((await api.call('PATCH', `/v1/locations/${w.store}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect(await api.sendOne(w.manager.token, ret(w.van, w.store, [line(w.maize.piece, 1)]))).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_ARCHIVED' });
    const van2 = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van 2', kind: 'FIELD', assigned_membership_id: w.f1.membershipId }, w.owner.token)).id;
    expect(await api.sendOne(w.manager.token, issue(w.store, van2, p))).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_ARCHIVED' }); // archived source
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. lines
  it('4. every bad line is reported and nothing is moved; malformed commands are VALIDATION_FAILED', async () => {
    const w = await fieldWorld();
    const b = await api.world('Duka B');
    const r = await api.sendOne(
      w.manager.token,
      issue(w.loc, w.van, [
        line(w.maize.piece, 1), // 1: fine
        line(w.maize.piece, 1), // 2: duplicate
        line(randomUUID(), 1), // 3: no such pack type
        line(b.maize.piece, 1), // 4: another business's
        line(w.maize.carton, 0), // 5
      ]),
    );
    expect(r).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_LINES',
      result: {
        invalid_lines: [
          { line: 2, reason: 'DUPLICATE_LINE' },
          { line: 3, reason: 'PACK_TYPE_NOT_FOUND' },
          { line: 4, reason: 'PACK_TYPE_NOT_FOUND' },
          { line: 5, reason: 'QUANTITY_INVALID' },
        ],
      },
    });
    for (const q of [-1, 1.5, 1_000_001]) {
      expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, q)])), String(q)).toMatchObject({ reason: 'INVALID_LINES', result: { invalid_lines: [{ line: 1, reason: 'QUANTITY_INVALID' }] } });
    }
    const many = Array.from({ length: 51 }, () => line(w.maize.piece, 1));
    for (const payload of [
      { from_location_id: w.loc, to_location_id: w.van, lines: [] },
      { from_location_id: w.loc, to_location_id: w.van, lines: many },
      { from_location_id: w.loc, to_location_id: w.van, lines: [{ pack_type_id: w.maize.piece, quantity: '5' }] },
      { from_location_id: w.loc, to_location_id: w.van, lines: [line(w.maize.piece, 1)], business_id: b.owner.businessId },
      { from_location_id: w.loc, to_location_id: w.van, lines: [line(w.maize.piece, 1)], reference: 'x'.repeat(61) },
    ]) {
      expect(await api.sendOne(w.manager.token, api.command('stock.issue', payload)), JSON.stringify(payload).slice(0, 60)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    expect(await transferRows(w.owner.businessId)).toEqual([]);
    expect(await bal(w, w.loc, w.maize.piece)).toBe(20);
  });

  // ---------------------------------------------------------------- 5. permissions
  it('5. attendants and field attendants are denied; managers and owners may issue and return', async () => {
    const w = await fieldWorld();
    for (const who of [w.attendant, w.f1]) {
      expect(await api.sendOne(who.token, issue(w.loc, w.van, [line(w.maize.piece, 1)]))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
      expect(await api.sendOne(who.token, ret(w.van, w.loc, [line(w.maize.piece, 1)]))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    }
    expect((await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 2)]))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.owner.token, ret(w.van, w.loc, [line(w.maize.piece, 1)]))).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 6. concurrency (runs 5 times)
  it('6. race: 20 concurrent issues of 1 against 5 give exactly 5; the same command 20 times applies once', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.manager.token, api.command('stock.adjust', { location_id: w.loc, pack_type_id: w.maize.piece, quantity_change: -15, reason: 'CORRECTION' }))).status).toBe('ACCEPTED');
    const results = await Promise.all(Array.from({ length: 20 }, () => api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 1)]))));
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'REJECTED' && r.reason === 'STOCK_INSUFFICIENT')).toHaveLength(15);
    expect(await bal(w, w.loc, w.maize.piece)).toBe(0);
    expect(await bal(w, w.van, w.maize.piece)).toBe(5);
    const same = ret(w.van, w.loc, [line(w.maize.piece, 2)]);
    const copies = await Promise.all(Array.from({ length: 20 }, () => api.sendOne(w.manager.token, same)));
    for (const c of copies) expect(c).toEqual(copies[0]);
    expect(copies[0].status).toBe('ACCEPTED');
    expect(await bal(w, w.van, w.maize.piece)).toBe(3);
    expect(await transferRows(w.owner.businessId)).toHaveLength(6);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('6. race: issues and returns in opposite directions with sales at the van never deadlock; ledgers equal balances', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 10), line(w.maize.carton, 2)]))).status).toBe('ACCEPTED');
    const work: Promise<Result>[] = [];
    for (let i = 0; i < 10; i++) {
      work.push(api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.carton, 1), line(w.maize.piece, 1)])));
      work.push(api.sendOne(w.owner.token, ret(w.van, w.loc, [line(w.maize.piece, 1), line(w.maize.carton, 1)])));
      work.push(api.sendOne(w.f1.token, api.command('sale.create', { sale_id: randomUUID(), local_ref: `V${i}`, location_id: w.van, lines: [{ pack_type_id: w.maize.piece, quantity: 1, unit_price: '180' }, { pack_type_id: w.maize.carton, quantity: 1, unit_price: '4200' }] })));
    }
    const results = await Promise.all(work);
    for (const r of results) expect(['ACCEPTED', 'FLAGGED', 'REJECTED:STOCK_INSUFFICIENT']).toContain(r.status === 'REJECTED' ? `REJECTED:${r.reason}` : r.status);
    expect(results.filter((r) => r.status === 'FAILED')).toEqual([]);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('6. forced: an issue and a return waiting on the same pools in opposite directions do not deadlock', async () => {
    const w = await fieldWorld();
    expect((await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 5)]))).status).toBe('ACCEPTED');
    const held = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await held.connect();
    let done = false;
    let results: Result[] = [];
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM stock_balance WHERE location_id = $1 AND pack_type_id = $2 FOR UPDATE', [w.loc, w.maize.piece]);
      // The issue starts first and waits; then the return. With "source first" locking the
      // return would now hold the van pool while the issue, first in the queue, gets the shop pool.
      const issued = api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 1)]));
      await lockWaiters(1);
      const returned = api.sendOne(w.owner.token, ret(w.van, w.loc, [line(w.maize.piece, 1)]));
      await lockWaiters(2);
      await held.query('COMMIT');
      done = true;
      results = await Promise.all([issued, returned]);
    } finally {
      if (!done) await held.query('ROLLBACK');
      await held.end();
    }
    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await bal(w, w.van, w.maize.piece)).toBe(5);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 7. other business
  it('7. a location or pack type of another business is the same as a missing one', async () => {
    const w = await fieldWorld();
    const b = await fieldWorld('Duka B');
    const missing = await api.sendOne(w.manager.token, issue(w.loc, randomUUID(), [line(w.maize.piece, 1)]));
    expect(missing).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_NOT_FOUND' });
    for (const cmd of [issue(w.loc, b.van, [line(w.maize.piece, 1)]), issue(b.loc, w.van, [line(w.maize.piece, 1)]), ret(b.van, w.loc, [line(w.maize.piece, 1)])]) {
      const r = await api.sendOne(w.manager.token, cmd);
      expect({ ...r, command_id: null }).toEqual({ ...missing, command_id: null });
    }
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(b.maize.piece, 1)]))).toMatchObject({ reason: 'INVALID_LINES', result: { invalid_lines: [{ line: 1, reason: 'PACK_TYPE_NOT_FOUND' }] } });
    expect(await bal(b, b.loc, b.maize.piece)).toBe(20);
  });

  // ---------------------------------------------------------------- 8. audit
  it('8. audit stock.issued and stock.returned once each, without the note; a failure after the audit insert leaves nothing', async () => {
    const w = await fieldWorld();
    const i = await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 3)], { note: 'secret transfer note', reference: 'REF-SECRET' }));
    const r = await api.sendOne(w.owner.token, ret(w.van, w.loc, [line(w.maize.piece, 1)]));
    const audit = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string; metadata: Record<string, unknown> }>(
          "SELECT action, actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action IN ('stock.issued', 'stock.returned') ORDER BY occurred_at",
          [w.owner.businessId],
        )).rows,
    );
    expect(audit).toEqual([
      {
        action: 'stock.issued',
        actor_membership_id: w.manager.membershipId,
        metadata: { transfer_id: (i.result as { transfer_id: string }).transfer_id, kind: 'ISSUE', from_location_id: w.loc, to_location_id: w.van, lines: [{ pack_type_id: w.maize.piece, quantity: 3 }] },
      },
      {
        action: 'stock.returned',
        actor_membership_id: w.owner.membershipId,
        metadata: { transfer_id: (r.result as { transfer_id: string }).transfer_id, kind: 'RETURN', from_location_id: w.van, to_location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 1 }] },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('secret');
    expect(JSON.stringify(audit)).not.toContain('REF-SECRET');

    const state = () =>
      asAdmin(async (c) => ({
        audit: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0].n),
        transfers: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stock_transfer')).rows[0].n),
        movements: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stock_movement')).rows[0].n),
        balances: (await c.query('SELECT location_id, pack_type_id, quantity FROM stock_balance ORDER BY location_id, pack_type_id')).rows,
      }));
    const before = await state();
    const auditService = t.app.get(AuditService, { strict: false });
    const original = auditService.record.bind(auditService);
    vi.spyOn(auditService, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('crash after the audit write');
    });
    expect(await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 2)]))).toMatchObject({ status: 'FAILED' });
    expect(await state()).toEqual(before);
  });

  // ---------------------------------------------------------------- 9. change_log
  it('9. change_log rows for the changed balances', async () => {
    const w = await fieldWorld();
    const before = await asAdmin(async (c) => (await c.query<{ m: string }>('SELECT coalesce(max(id), 0)::text AS m FROM change_log WHERE business_id = $1', [w.owner.businessId])).rows[0].m);
    expect((await api.sendOne(w.manager.token, issue(w.loc, w.van, [line(w.maize.piece, 2), line(w.maize.carton, 1)]))).status).toBe('ACCEPTED');
    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ table_name: string; operation: string; location_id: string }>(
          `SELECT l.table_name, l.operation, b.location_id FROM change_log l JOIN stock_balance b ON b.id = l.row_id
            WHERE l.business_id = $1 AND l.id > $2::bigint AND l.table_name = 'stock_balance'`,
          [w.owner.businessId, before],
        )).rows,
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.location_id === w.van).map((r) => r.operation).sort()).toEqual(['INSERT', 'INSERT']);
    expect(rows.filter((r) => r.location_id === w.loc).map((r) => r.operation)).toEqual(['UPDATE', 'UPDATE']);
  });
});
