import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { SalesRepository } from '../src/modules/sales/sales.repository.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Pack, type Result, type World, stockApi } from './helpers/stock-api.js';

// Phase E2: sale.create (docs/phase-e-design.md sections 4 and 5). Numbers in
// test names refer to the E2 list in section 13.

describe('E2: sale.create', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.180', 98_000_000);
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

  let refSeq = 0;
  const sale = (w: World, lines: object[], extra: object = {}) =>
    api.command('sale.create', { sale_id: randomUUID(), local_ref: `R-${++refSeq}`, location_id: w.loc, lines, ...extra });
  const line = (pack: string, quantity: number, unit_price: string) => ({ pack_type_id: pack, quantity, unit_price });
  const stockUp = (w: World, lines: { pack: string; quantity: number }[], loc = w.loc) =>
    api.sendOne(w.manager.token, api.command('stock.receive', { location_id: loc, lines: lines.map((l) => ({ pack_type_id: l.pack, quantity: l.quantity })) }));

  const saleRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{
          id: string;
          sale_number: number;
          local_ref: string;
          location_id: string;
          device_id: string;
          created_by_membership_id: string;
          status: string;
          total: string;
          paid_total: string;
          balance_due: string;
          total_mismatch: boolean;
          note: string | null;
          occurred_at: Date;
        }>(
          `SELECT id, sale_number, local_ref, location_id, device_id, created_by_membership_id, status, total::text, paid_total::text,
                  balance_due::text, total_mismatch, note, occurred_at FROM sale WHERE business_id = $1 ORDER BY sale_number`,
          [businessId],
        )).rows,
    );
  const itemRows = (saleId: string) =>
    asAdmin(
      async (c) =>
        (await c.query(
          `SELECT line_no, pack_type_id, product_name, pack_type_name, quantity, unit_price::text, list_price::text, cost_price::text, line_total::text
             FROM sale_item WHERE sale_id = $1 ORDER BY line_no`,
          [saleId],
        )).rows,
    );
  const saleMovements = (saleId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ pack_type_id: string; quantity_change: number; quantity_after: number; movement_type: string; created_by_membership_id: string; sync_command_id: string }>(
          'SELECT pack_type_id, quantity_change, quantity_after, movement_type, created_by_membership_id, sync_command_id FROM stock_movement WHERE sale_id = $1',
          [saleId],
        )).rows,
    );
  const counter = (businessId: string) =>
    asAdmin(async (c) => (await c.query<{ n: number }>('SELECT last_number AS n FROM sale_counter WHERE business_id = $1', [businessId])).rows[0]?.n ?? 0);

  async function shop(name = 'Duka A'): Promise<World & { beans: Pack }> {
    const w = await api.world(name);
    const beans = await api.newProduct(w.owner, 'Beans 1kg');
    // A cost on the maize piece, set by the owner.
    const cost = api.command('pack_type.upsert', { pack_type_id: w.maize.piece, product_id: w.maize.productId, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' });
    expect((await api.sendOne(w.owner.token, cost)).status).toBe('ACCEPTED');
    return { ...w, beans };
  }

  // ---------------------------------------------------------------- 1. a sale
  it('1. a sale of three lines: sale, items with snapshots, SALE movements, balances, sale_number 1, and the result', async () => {
    const w = await shop();
    await stockUp(w, [{ pack: w.maize.carton, quantity: 5 }, { pack: w.maize.piece, quantity: 20 }, { pack: w.beans.piece, quantity: 10 }]);
    const cmd = api.command(
      'sale.create',
      {
        sale_id: randomUUID(),
        local_ref: ' R-0001 ',
        location_id: w.loc,
        note: 'regular customer',
        lines: [line(w.maize.piece, 3, '175.50'), line(w.maize.carton, 1, '4200'), line(w.beans.piece, 2, '100')],
      },
      '2026-10-25T08:30:00.000Z',
    );
    const saleId = (cmd.payload as { sale_id: string }).sale_id;
    const r = await api.sendOne(w.attendant.token, cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: { sale_id: saleId, sale_number: 1, total: '4926.50', paid_total: '0.00', balance_due: '4926.50', flags: [] },
    });
    const [s] = await saleRows(w.owner.businessId);
    expect(s).toMatchObject({
      id: saleId,
      sale_number: 1,
      local_ref: 'R-0001',
      location_id: w.loc,
      device_id: w.attendant.deviceId,
      created_by_membership_id: w.attendant.membershipId,
      status: 'COMPLETED',
      total: '4926.50',
      paid_total: '0.00',
      balance_due: '4926.50',
      total_mismatch: false,
      note: 'regular customer',
    });
    expect(s.occurred_at.toISOString()).toBe('2026-10-25T08:30:00.000Z');
    expect(await itemRows(saleId)).toEqual([
      { line_no: 1, pack_type_id: w.maize.piece, product_name: 'Maize flour 2kg', pack_type_name: 'piece', quantity: 3, unit_price: '175.50', list_price: '180.00', cost_price: '150.00', line_total: '526.50' },
      { line_no: 2, pack_type_id: w.maize.carton, product_name: 'Maize flour 2kg', pack_type_name: 'carton of 24', quantity: 1, unit_price: '4200.00', list_price: '4200.00', cost_price: null, line_total: '4200.00' },
      { line_no: 3, pack_type_id: w.beans.piece, product_name: 'Beans 1kg', pack_type_name: 'piece', quantity: 2, unit_price: '100.00', list_price: '180.00', cost_price: null, line_total: '200.00' },
    ]);
    const syncId = (await api.syncCommand(w.owner.businessId, cmd.command_id)).id;
    const moves = await saleMovements(saleId);
    expect(moves).toHaveLength(3);
    expect(moves).toEqual(
      expect.arrayContaining([
        { pack_type_id: w.maize.piece, quantity_change: -3, quantity_after: 17, movement_type: 'SALE', created_by_membership_id: w.attendant.membershipId, sync_command_id: syncId },
        { pack_type_id: w.maize.carton, quantity_change: -1, quantity_after: 4, movement_type: 'SALE', created_by_membership_id: w.attendant.membershipId, sync_command_id: syncId },
        { pack_type_id: w.beans.piece, quantity_change: -2, quantity_after: 8, movement_type: 'SALE', created_by_membership_id: w.attendant.membershipId, sync_command_id: syncId },
      ]),
    );
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(17);
    expect(await counter(w.owner.businessId)).toBe(1);
    // Stock was changed larger pack first (the lock order), although the carton line came second.
    const order = (await api.balanceLog(w.owner.businessId)).slice(-3).map((l) => l.pack_type_id);
    expect(order[0]).toBe(w.maize.carton);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. exact totals
  it('2. totals use exact decimals; a different phone total is saved with the server total and FLAGGED / TOTAL_MISMATCH', async () => {
    const w = await shop();
    const p = await api.newProduct(w.owner, 'Sugar');
    await stockUp(w, [{ pack: w.maize.piece, quantity: 100 }, { pack: w.beans.piece, quantity: 100 }, { pack: p.piece, quantity: 100 }]);
    const lines = [line(w.maize.piece, 3, '33.33'), line(w.beans.piece, 7, '0.10'), line(p.piece, 1, '19.99')];
    // 99.99 + 0.70 + 19.99 = 120.68 exactly.
    expect(await api.sendOne(w.attendant.token, sale(w, lines, { total: '120.68' }))).toMatchObject({ status: 'ACCEPTED', result: { total: '120.68', flags: [] } });
    expect(await api.sendOne(w.attendant.token, sale(w, lines))).toMatchObject({ status: 'ACCEPTED', result: { total: '120.68' } });
    expect(await api.sendOne(w.attendant.token, sale(w, lines, { total: '120.6' }))).toMatchObject({ status: 'FLAGGED', reason: 'TOTAL_MISMATCH' }); // 120.6 is 120.60, not 120.68
    const mismatch = await api.sendOne(w.attendant.token, sale(w, lines, { total: '120.69' }));
    expect(mismatch).toMatchObject({ status: 'FLAGGED', reason: 'TOTAL_MISMATCH', result: { total: '120.68', balance_due: '120.68', flags: ['TOTAL_MISMATCH'] } });
    const rows = await saleRows(w.owner.businessId);
    expect(rows.map((r) => [r.total, r.total_mismatch])).toEqual([
      ['120.68', false],
      ['120.68', false],
      ['120.68', true], // 120.6 differs from 120.68
      ['120.68', true],
    ]);
    expect((await itemRows(rows[0].id)).map((i) => i.line_total)).toEqual(['99.99', '0.70', '19.99']);
    // A malformed phone total is not a sale we can compare: VALIDATION_FAILED, nothing saved.
    expect(await api.sendOne(w.attendant.token, sale(w, lines, { total: '12.345' }))).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await saleRows(w.owner.businessId)).toHaveLength(4);
  });

  // ---------------------------------------------------------------- 3. sale mode (the concurrent part runs 5 times)
  it('3. balance 2 and a sale of 5: FLAGGED / STOCK_NEGATIVE, balance -3, the sale fully saved', async () => {
    const w = await shop();
    await stockUp(w, [{ pack: w.maize.piece, quantity: 2 }]);
    const r = await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 5, '180')]));
    expect(r).toMatchObject({ status: 'FLAGGED', reason: 'STOCK_NEGATIVE', result: { sale_number: 1, total: '900.00', flags: ['STOCK_NEGATIVE'] } });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-3);
    expect(await saleRows(w.owner.businessId)).toHaveLength(1);
    // Both flags at once: the reason is the first in the design's order.
    const both = await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '180')], { total: '1' }));
    expect(both).toMatchObject({ status: 'FLAGGED', reason: 'TOTAL_MISMATCH', result: { flags: ['TOTAL_MISMATCH', 'STOCK_NEGATIVE'] } });
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('3. 50 concurrent sales of 1 against a balance of 10: all saved, final -40, exactly 40 flagged, ledger equals balance', async () => {
    const w = await shop();
    await stockUp(w, [{ pack: w.maize.piece, quantity: 10 }]);
    const results = await Promise.all(Array.from({ length: 50 }, () => api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '180')]))));
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'FLAGGED' && r.reason === 'STOCK_NEGATIVE')).toHaveLength(40);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-40);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.piece)).toBe(-40);
    expect(await saleRows(w.owner.businessId)).toHaveLength(50);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. numbering (the concurrent part runs 5 times)
  it('4. 30 concurrent sales get 1 to 30 once each; a second business starts at 1; the same command 20 times makes one sale', async () => {
    const a = await shop('Duka A');
    const b = await shop('Duka B');
    // Ten different stock pools, so the sales do not queue behind one balance row lock and really overlap at the counter.
    const extra = [await api.newProduct(a.owner, 'Rice'), await api.newProduct(a.owner, 'Salt'), await api.newProduct(a.owner, 'Tea')];
    const pools = [a.maize, a.beans, ...extra].flatMap((p) => [p.piece, p.carton]);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => api.sendOne((i % 2 ? a.attendant : a.manager).token, sale(a, [line(pools[i % 10], 1, '180')]))));
    expect(results.every((r) => r.status !== 'REJECTED' && r.status !== 'FAILED')).toBe(true);
    const numbers = results.map((r) => (r.result as { sale_number: number }).sale_number).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect((await saleRows(a.owner.businessId)).map((s) => s.sale_number)).toEqual(numbers);
    expect(await api.sendOne(b.attendant.token, sale(b, [line(b.maize.piece, 1, '180')]))).toMatchObject({ result: { sale_number: 1 } });

    const same = sale(a, [line(a.maize.piece, 1, '180')]);
    const copies = await Promise.all(Array.from({ length: 20 }, () => api.sendOne(a.attendant.token, same)));
    for (const r of copies) expect(r).toEqual(copies[0]);
    expect(copies[0]).toMatchObject({ result: { sale_number: 31 } });
    expect(await saleRows(a.owner.businessId)).toHaveLength(31);
    expect(await counter(a.owner.businessId)).toBe(31);
  });

  it('4. a sale that fails after taking its number rolls back with no gap', async () => {
    const w = await shop();
    expect(await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '180')]))).toMatchObject({ result: { sale_number: 1 } });
    vi.spyOn(t.app.get(SalesRepository, { strict: false }), 'insertItems').mockRejectedValueOnce(new Error('crash after the counter'));
    expect(await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '180')]))).toMatchObject({ status: 'FAILED' });
    expect(await counter(w.owner.businessId)).toBe(1);
    expect(await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '180')]))).toMatchObject({ result: { sale_number: 2 } });
    expect((await saleRows(w.owner.businessId)).map((s) => s.sale_number)).toEqual([1, 2]);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.piece)).toBe(-2);
  });

  // ---------------------------------------------------------------- 5. bad lines
  it('5. bad lines are all reported and nothing is saved; malformed commands are VALIDATION_FAILED; a price of 0 is allowed', async () => {
    const w = await shop();
    const b = await shop('Duka B');
    const r = await api.sendOne(
      w.attendant.token,
      sale(w, [
        line(w.maize.piece, 1, '180'), // 1: fine
        line(w.maize.piece, 0, '180'), // 2: quantity 0
        line(w.maize.piece, -1, '180'), // 3: negative
        line(w.maize.piece, 1.5, '180'), // 4: fractional
        line(w.maize.piece, 100_001, '1'), // 5: too many
        line(w.maize.piece, 1, '-5'), // 6: negative price
        line(w.maize.piece, 1, 'abc'), // 7: not a price
        line(randomUUID(), 1, '180'), // 8: no such pack type
        line(b.maize.piece, 1, '180'), // 9: another business's pack type
        line(w.maize.piece, 1, '180'), // 10: fine (a second line of the same pack type)
      ]),
    );
    expect(r).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_LINES',
      result: {
        invalid_lines: [
          { line: 2, reason: 'QUANTITY_INVALID' },
          { line: 3, reason: 'QUANTITY_INVALID' },
          { line: 4, reason: 'QUANTITY_INVALID' },
          { line: 5, reason: 'QUANTITY_INVALID' },
          { line: 6, reason: 'PRICE_INVALID' },
          { line: 7, reason: 'PRICE_INVALID' },
          { line: 8, reason: 'PACK_TYPE_NOT_FOUND' },
          { line: 9, reason: 'PACK_TYPE_NOT_FOUND' },
        ],
      },
    });
    const many = Array.from({ length: 101 }, () => line(w.maize.piece, 1, '1'));
    for (const payload of [
      { lines: [] },
      { lines: many },
      { lines: [{ pack_type_id: w.maize.piece, quantity: '1', unit_price: '1' }] },
      { lines: [line(w.maize.piece, 1, '1')], local_ref: 'r'.repeat(31) },
      { lines: [line(w.maize.piece, 1, '1')], local_ref: '   ' },
      { lines: [line(w.maize.piece, 1, '1')], business_id: b.owner.businessId },
      { lines: [line(w.maize.piece, 1, '1')], payments: Array.from({ length: 11 }, () => ({ method: 'CASH', amount: '1' })) }, // more than 10 payments (until E3: any payment)
      { lines: [line(w.maize.piece, 100_000, '999999999999.99')] }, // a line above NUMERIC(14,2)
    ]) {
      expect(await api.sendOne(w.attendant.token, sale(w, [], payload)), JSON.stringify(payload).slice(0, 60)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    expect(await saleRows(w.owner.businessId)).toEqual([]);
    expect(await counter(w.owner.businessId)).toBe(0);
    expect((await api.movements(w.owner.businessId)).filter((m) => m.movement_type === 'SALE')).toEqual([]);
    // A price of 0 is allowed, and two lines of one pack type are both applied; an empty payments list is fine.
    const free = await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '0'), line(w.maize.piece, 2, '180')], { payments: [] }));
    expect(free).toMatchObject({ result: { sale_number: 1, total: '360.00' } });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-3);
  });

  // ---------------------------------------------------------------- 6. the same sale id
  it('6. a repeated sale_id with a new command id is SALE_ALREADY_EXISTS and changes nothing', async () => {
    const w = await shop();
    const first = sale(w, [line(w.maize.piece, 1, '180')]);
    expect((await api.sendOne(w.attendant.token, first)).status).toBe('FLAGGED'); // no stock: STOCK_NEGATIVE
    const again = { ...first, command_id: randomUUID() };
    expect(await api.sendOne(w.attendant.token, again)).toMatchObject({ status: 'REJECTED', reason: 'SALE_ALREADY_EXISTS' });
    expect(await saleRows(w.owner.businessId)).toHaveLength(1);
    expect(await counter(w.owner.businessId)).toBe(1);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-1);
    // Two new commands with one new sale id at the same moment: one sale, one SALE_ALREADY_EXISTS.
    const raced = sale(w, [line(w.maize.piece, 1, '180')]);
    const results = await Promise.all([api.sendOne(w.attendant.token, raced), api.sendOne(w.attendant.token, { ...raced, command_id: randomUUID() })]);
    expect(results.map((r) => (r.status === 'REJECTED' ? r.reason : 'saved')).sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['SALE_ALREADY_EXISTS', 'saved']);
    expect(await counter(w.owner.businessId)).toBe(2);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 7. archived, unknown location
  it('7. archived location, product and pack type are accepted; an unknown or another business\'s location is LOCATION_NOT_FOUND', async () => {
    const w = await shop();
    const b = await shop('Duka B');
    const store = await api.newLocation(w.owner, 'Back store');
    expect((await api.call('PATCH', `/v1/locations/${store}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    const archivePack = api.command('pack_type.upsert', { pack_type_id: w.maize.carton, product_id: w.maize.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4200', archived: true });
    expect((await api.sendOne(w.owner.token, archivePack)).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.owner.token, api.command('product.update', { product_id: w.beans.productId, archived: true }))).status).toBe('ACCEPTED');
    const r = await api.sendOne(w.attendant.token, sale(w, [line(w.maize.carton, 1, '4200'), line(w.beans.piece, 1, '50')], { location_id: store }));
    expect(r).toMatchObject({ status: 'FLAGGED', reason: 'STOCK_NEGATIVE', result: { sale_number: 1 } });
    expect(await api.balanceOf(w.owner.businessId, store, w.maize.carton)).toBe(-1);
    const missing = await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '1')], { location_id: randomUUID() }));
    const foreign = await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '1')], { location_id: b.loc }));
    expect(foreign).toEqual({ ...missing, command_id: foreign.command_id });
    expect(missing).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_NOT_FOUND' });
    expect(await saleRows(b.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 8. permissions
  it('8. without sales.create the command is PERMISSION_DENIED; a suspended member is refused', async () => {
    const w = await shop();
    // Every preset has sales.create, so this actor is built directly (as the dispatcher would see it).
    const sync = t.app.get(SyncService, { strict: false });
    const [r] = await sync.processCommands(
      { businessId: w.owner.businessId, membershipId: w.attendant.membershipId, deviceId: w.attendant.deviceId!, permissions: new Set(['stock.view']) },
      [sale(w, [line(w.maize.piece, 1, '180')])],
    );
    expect(r).toMatchObject({ status: 'REJECTED', code: 'PERMISSION_DENIED' });
    expect((await api.post(`/v1/staff/${w.attendant.membershipId}/suspend`, undefined, w.owner.token)).statusCode).toBe(204);
    const res = await api.post('/v1/sync/commands', { commands: [sale(w, [line(w.maize.piece, 1, '180')])] }, w.attendant.token);
    expect(res.statusCode).toBe(403);
    expect(await saleRows(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 9. sales with counts and conversions (runs 5 times)
  it('9. concurrent sales, a count and conversions on the same pools: ledger equals balance, no deadlock', async () => {
    const w = await shop();
    await stockUp(w, [{ pack: w.maize.carton, quantity: 10 }, { pack: w.maize.piece, quantity: 30 }]);
    const work: Promise<Result>[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        api.sendOne(w.attendant.token, sale(w, i % 2 ? [line(w.maize.piece, 2, '180'), line(w.maize.carton, 1, '4200')] : [line(w.maize.carton, 1, '4200'), line(w.maize.piece, 1, '180')])),
      ),
      ...Array.from({ length: 5 }, () =>
        api.sendOne(w.manager.token, api.command('stock.convert', { location_id: w.loc, from_pack_type_id: w.maize.carton, to_pack_type_id: w.maize.piece, quantity: 1 })),
      ),
      api.sendOne(w.manager.token, api.command('stock.count', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, expected_quantity: 30, counted_quantity: 29 }] })),
    ];
    const results = await Promise.all(work);
    for (const r of results) expect(['ACCEPTED', 'FLAGGED', 'REJECTED:STOCK_INSUFFICIENT']).toContain(r.status === 'REJECTED' ? `REJECTED:${r.reason}` : r.status);
    expect(await saleRows(w.owner.businessId)).toHaveLength(20);
    for (const pack of [w.maize.piece, w.maize.carton]) {
      expect(await api.ledgerSum(w.owner.businessId, w.loc, pack)).toBe(await api.balanceOf(w.owner.businessId, w.loc, pack));
    }
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 10. audit
  it('10. audit sale.created once without note, names or prices; a failure after the audit insert leaves nothing behind', async () => {
    const w = await shop();
    await stockUp(w, [{ pack: w.maize.piece, quantity: 5 }]);
    const cmd = sale(w, [line(w.maize.piece, 2, '177.77')], { note: 'private sale note', total: '355.54' });
    const saleId = (cmd.payload as { sale_id: string }).sale_id;
    expect((await api.sendOne(w.attendant.token, cmd)).status).toBe('ACCEPTED');
    const audit = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; target_id: string; actor_membership_id: string; metadata: Record<string, unknown> }>(
          "SELECT action, target_id, actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action = 'sale.created'",
          [w.owner.businessId],
        )).rows,
    );
    expect(audit).toEqual([
      {
        action: 'sale.created',
        target_id: saleId,
        actor_membership_id: w.attendant.membershipId,
        // payment_count and paid_total since E3 (design section 9).
        metadata: { sale_id: saleId, sale_number: 1, location_id: w.loc, total: '355.54', line_count: 1, payment_count: 0, paid_total: '0.00', flags: [] },
      },
    ]);
    const text = JSON.stringify(audit);
    for (const secret of ['private sale note', 'Maize', '177.77', '"note"']) expect(text, secret).not.toContain(secret);

    // A crash right after the audit insert.
    const auditService = t.app.get(AuditService, { strict: false });
    const original = auditService.record.bind(auditService);
    vi.spyOn(auditService, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('crash after the audit write');
    });
    const before = {
      sales: (await saleRows(w.owner.businessId)).length,
      counter: await counter(w.owner.businessId),
      balance: await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece),
      audit: (await asAdmin(async (c) => (await c.query('SELECT 1 FROM audit_log WHERE business_id = $1', [w.owner.businessId])).rowCount)) ?? 0,
    };
    expect(await api.sendOne(w.attendant.token, sale(w, [line(w.maize.piece, 1, '180')]))).toMatchObject({ status: 'FAILED' });
    expect({
      sales: (await saleRows(w.owner.businessId)).length,
      counter: await counter(w.owner.businessId),
      balance: await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece),
      audit: (await asAdmin(async (c) => (await c.query('SELECT 1 FROM audit_log WHERE business_id = $1', [w.owner.businessId])).rowCount)) ?? 0,
    }).toEqual(before);
  });
});
