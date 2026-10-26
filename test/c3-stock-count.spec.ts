import { randomUUID } from 'node:crypto';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { stockApi } from './helpers/stock-api.js';

// Phase C3: stock.count (docs/phase-c-design.md sections 4 and 5). Numbers in
// test names refer to the C3 list in section 13. Commands go through
// POST /v1/sync/commands; sales use the spike's sale-mode code until Phase E.

describe('C3: stock count', { timeout: 180_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.80', 80_000_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  const count = (location: string, lines: object[], extra: object = {}, occurredAt?: string) =>
    api.command('stock.count', { location_id: location, lines, ...extra }, occurredAt);
  const receive = (location: string, lines: object[]) => api.command('stock.receive', { location_id: location, lines });
  const line = (pack: string, expected: number, counted: number) => ({ pack_type_id: pack, expected_quantity: expected, counted_quantity: counted });

  // ---------------------------------------------------------------- 1. the count rule
  it('1. counted minus expected is applied; a zero-delta line writes no movement; movements store both numbers', async () => {
    const w = await api.world();
    const beans = await api.newProduct(w.owner, 'Beans 1kg');
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 10 }, { pack_type_id: w.maize.carton, quantity: 5 }]));

    const occurred = '2026-10-25T07:15:00.000Z';
    const cmd = count(w.loc, [line(w.maize.piece, 10, 8), line(w.maize.carton, 5, 5), line(beans.piece, 0, 3)], { note: ' Weekly count ' }, occurred);
    const r = await api.sendOne(w.manager.token, cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: {
        lines: [
          { pack_type_id: w.maize.piece, delta: -2, quantity_after: 8 },
          { pack_type_id: w.maize.carton, delta: 0, quantity_after: 5 },
          { pack_type_id: beans.piece, delta: 3, quantity_after: 3 },
        ],
      },
    });

    const syncId = (await api.syncCommand(w.owner.businessId, cmd.command_id)).id;
    const counts = (await api.movements(w.owner.businessId)).filter((m) => m.movement_type === 'COUNT');
    // Two movements: the zero-delta carton line wrote none.
    expect(counts).toHaveLength(2);
    expect(counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pack_type_id: w.maize.piece, quantity_change: -2, quantity_after: 8, expected_quantity: 10, counted_quantity: 8 }),
        expect.objectContaining({ pack_type_id: beans.piece, quantity_change: 3, quantity_after: 3, expected_quantity: 0, counted_quantity: 3 }),
      ]),
    );
    for (const m of counts) {
      expect(m).toMatchObject({ created_by_membership_id: w.manager.membershipId, sync_command_id: syncId, note: 'Weekly count', reason: null });
      expect(m.occurred_at.toISOString()).toBe(occurred);
    }
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(5);

    // Every line zero: accepted, no movement at all.
    const before = (await api.movements(w.owner.businessId)).length;
    const still = await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, 8, 8)]));
    expect(still).toMatchObject({ status: 'ACCEPTED', result: { lines: [{ pack_type_id: w.maize.piece, delta: 0, quantity_after: 8 }] } });
    expect(await api.movements(w.owner.businessId)).toHaveLength(before);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. sales between count and arrival
  it('2. balance 10, counted 8 against expected 10, three sales processed before the count arrives: the final balance is 5, not 8', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 10 }]));
    // The phone counts at 08:00 (it then saw 10) but is offline; three sales from other phones arrive first.
    const countedAt = new Date(t.clock.now().getTime() - 60 * 60_000).toISOString();
    for (let i = 0; i < 3; i++) await api.sell(w, w.loc, w.maize.piece, 1);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(7);

    const r = await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, 10, 8)], {}, countedAt));
    expect(r).toMatchObject({ status: 'ACCEPTED', result: { lines: [{ pack_type_id: w.maize.piece, delta: -2, quantity_after: 5 }] } });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(5);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.piece)).toBe(5);
  });

  // ---------------------------------------------------------------- 3. concurrency (run 5 times)
  it('3. concurrent counts and sales: final = initial + all sale deltas + all count deltas, and the ledger equals the balance', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 100 }, { pack_type_id: w.maize.carton, quantity: 50 }]));
    // 10 counts over both pools (each with its own delta) and 20 sales, all at once.
    const countDeltas: { piece: number; carton: number }[] = Array.from({ length: 10 }, (_, i) => ({ piece: (i % 3) - 1, carton: i % 2 === 0 ? 2 : -1 }));
    const work = [
      ...countDeltas.map((d) =>
        api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, 40, 40 + d.piece), line(w.maize.carton, 20, 20 + d.carton)])),
      ),
      ...Array.from({ length: 20 }, (_, i) => api.sell(w, w.loc, i % 2 === 0 ? w.maize.piece : w.maize.carton, 1)),
    ];
    const results = await Promise.all(work);
    const commandResults = results.slice(0, 10) as { status: string }[];
    expect(commandResults.map((r) => r.status)).toEqual(Array(10).fill('ACCEPTED'));

    const piece = 100 - 10 + countDeltas.reduce((s, d) => s + d.piece, 0);
    const carton = 50 - 10 + countDeltas.reduce((s, d) => s + d.carton, 0);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(piece);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(carton);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.piece)).toBe(piece);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.carton)).toBe(carton);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. FLAGGED
  it('4. a count that ends with a negative balance is FLAGGED / NEGATIVE_AFTER_COUNT, still saved, and the same on a retry', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 2 }]));
    // The phone thought there were 5 and counted 0: delta -5 on a balance of 2.
    const cmd = count(w.loc, [line(w.maize.piece, 5, 0)]);
    const r = await api.sendOne(w.manager.token, cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'FLAGGED',
      reason: 'NEGATIVE_AFTER_COUNT',
      message: expect.any(String),
      result: { lines: [{ pack_type_id: w.maize.piece, delta: -5, quantity_after: -3 }] },
    });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-3);
    expect((await api.syncCommand(w.owner.businessId, cmd.command_id)).status).toBe('FLAGGED');
    expect(await api.sendOne(w.manager.token, cmd)).toEqual(r);
    expect(await api.movements(w.owner.businessId)).toHaveLength(2);

    // A zero-delta line on a pool that was already negative also flags (decided in C3).
    await api.sell(w, w.loc, w.maize.carton, 1);
    const zero = await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.carton, 3, 3)]));
    expect(zero).toMatchObject({ status: 'FLAGGED', reason: 'NEGATIVE_AFTER_COUNT', result: { lines: [{ pack_type_id: w.maize.carton, delta: 0, quantity_after: -1 }] } });
    // A count that ends at zero or above is not flagged.
    expect((await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, -3, 0)]))).status).toBe('ACCEPTED');
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 5. all or nothing
  it('5. a count with bad lines saves nothing and lists every bad line; malformed counts are VALIDATION_FAILED', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    const beans = await api.newProduct(w.owner, 'Beans 1kg');
    const max = 2_000_000_000;
    const r = await api.sendOne(
      w.manager.token,
      count(w.loc, [
        line(w.maize.piece, 10, 9), // 1: fine
        line(w.maize.piece, 9, 8), // 2: repeated pack type
        line(randomUUID(), 0, 1), // 3: no such pack type
        line(b.maize.piece, 0, 1), // 4: another business's pack type
        line(w.maize.carton, 0, -1), // 5: counted below zero
        line(beans.piece, 0, 1.5), // 6: fractional count
        line(beans.carton, 2.5, 1), // 7: fractional expected
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
          { line: 6, reason: 'QUANTITY_INVALID' },
          { line: 7, reason: 'QUANTITY_INVALID' },
        ],
      },
    });
    // The limits of each number (decided in C3).
    for (const [expected, counted] of [[0, max + 1], [-max - 1, 0], [max + 1, 0], [-max, 1]]) {
      const bad = await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, expected, counted)]));
      expect(bad, `${expected} ${counted}`).toMatchObject({ status: 'REJECTED', reason: 'INVALID_LINES', result: { invalid_lines: [{ line: 1, reason: 'QUANTITY_INVALID' }] } });
    }
    // Malformed: no lines, 51 lines, a number as a string, an unknown field, business_id.
    const fiftyOne = Array.from({ length: 51 }, () => line(randomUUID(), 0, 1));
    for (const payload of [
      { location_id: w.loc, lines: [] },
      { location_id: w.loc, lines: fiftyOne },
      { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, expected_quantity: '1', counted_quantity: 1 }] },
      { location_id: w.loc, lines: [{ ...line(w.maize.piece, 1, 1), extra: true }] },
      { location_id: w.loc, lines: [line(w.maize.piece, 1, 1)], business_id: b.owner.businessId },
    ]) {
      expect(await api.sendOne(w.manager.token, api.command('stock.count', payload))).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    // A missing location and another business's location: the same answer.
    const missing = await api.sendOne(w.manager.token, count(randomUUID(), [line(w.maize.piece, 0, 1)]));
    const foreign = await api.sendOne(w.manager.token, count(b.loc, [line(w.maize.piece, 0, 1)]));
    expect(foreign).toEqual({ ...missing, command_id: foreign.command_id });
    expect(foreign.reason).toBe('LOCATION_NOT_FOUND');

    expect(await api.movements(w.owner.businessId)).toEqual([]);
    expect(await api.balances(w.owner.businessId)).toEqual([]);
    expect(await api.balances(b.owner.businessId)).toEqual([]);
    expect(await api.auditRows(w.owner.businessId)).toEqual([]);
  });

  it('the balance floor: a count that would take a pool below -2,000,000,000 is VALIDATION_FAILED and changes nothing', async () => {
    const w = await api.world();
    await api.sell(w, w.loc, w.maize.piece, 1); // -1
    const r = await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.carton, 0, 7), line(w.maize.piece, 2_000_000_000, 0)]));
    expect(r).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-1);
    // The carton line (applied first, larger pack) was rolled back with it.
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(0);
    // Exactly at the floor is allowed.
    expect(await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, 1_999_999_999, 0)]))).toMatchObject({
      status: 'FLAGGED',
      result: { lines: [{ pack_type_id: w.maize.piece, delta: -1_999_999_999, quantity_after: -2_000_000_000 }] },
    });
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 6. permissions, archived
  it('6. an attendant is denied, a manager and the owner succeed; archived locations and pack types may be counted', async () => {
    const w = await api.world();
    expect(await api.sendOne(w.attendant.token, count(w.loc, [line(w.maize.piece, 0, 1)]))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    expect((await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, 0, 1)]))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.owner.token, count(w.loc, [line(w.maize.piece, 1, 2)]))).status).toBe('ACCEPTED');

    const store = await api.newLocation(w.owner, 'Back store');
    await api.sendOne(w.manager.token, receive(store, [{ pack_type_id: w.maize.carton, quantity: 4 }]));
    expect((await api.call('PATCH', `/v1/locations/${store}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect((await api.sendOne(w.owner.token, api.command('product.update', { product_id: w.maize.productId, archived: true }))).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.manager.token, count(store, [line(w.maize.carton, 4, 0)]))).toMatchObject({
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: w.maize.carton, delta: -4, quantity_after: 0 }] },
    });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(2);
  });

  // ---------------------------------------------------------------- 7. audit, change_log, isolation
  it('7. audit stock.counted without the note, change_log rows, and nothing crosses between businesses', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    await api.sendOne(b.manager.token, receive(b.loc, [{ pack_type_id: b.maize.piece, quantity: 9 }]));
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 10 }]));
    t.clock.advanceMinutes(1); // audit rows are ordered by their (fake clock) time
    await api.sendOne(w.manager.token, count(w.loc, [line(w.maize.piece, 10, 7), line(w.maize.carton, 0, 0)], { note: 'private count note' }));
    // A rejected count writes no audit row.
    await api.sendOne(w.manager.token, count(w.loc, [line(randomUUID(), 0, 1)]));

    const counted = (await api.auditRows(w.owner.businessId)).filter((a) => a.action === 'stock.counted');
    expect(counted).toEqual([
      {
        action: 'stock.counted',
        target_type: 'location',
        target_id: w.loc,
        actor_membership_id: w.manager.membershipId,
        metadata: {
          location_id: w.loc,
          lines: [
            { pack_type_id: w.maize.piece, expected: 10, counted: 7, delta: -3 },
            { pack_type_id: w.maize.carton, expected: 0, counted: 0, delta: 0 },
          ],
        },
      },
    ]);
    expect(JSON.stringify(counted)).not.toContain('private count note');
    expect(JSON.stringify(counted)).not.toContain('"note"');

    // change_log: the receive's INSERT and the count's UPDATE of the one balance;
    // the zero-delta carton line created no balance row and no log row.
    expect(await api.balanceLog(w.owner.businessId)).toEqual([
      { pack_type_id: w.maize.piece, operation: 'INSERT' },
      { pack_type_id: w.maize.piece, operation: 'UPDATE' },
    ]);
    expect(await api.balances(w.owner.businessId)).toEqual([{ location_id: w.loc, pack_type_id: w.maize.piece, quantity: 7 }]);
    // Business B is untouched.
    expect(await api.balances(b.owner.businessId)).toEqual([{ location_id: b.loc, pack_type_id: b.maize.piece, quantity: 9 }]);
    expect(await api.balanceLog(b.owner.businessId)).toEqual([{ pack_type_id: b.maize.piece, operation: 'INSERT' }]);
    // The count shows in the history, with both numbers.
    const history = await api.call('GET', '/v1/stock/movements?type=COUNT', w.attendant.token);
    expect(history.json()).toMatchObject({ movements: [{ movement_type: 'COUNT', quantity_change: -3, expected_quantity: 10, counted_quantity: 7, note: 'private count note' }] });
    expect(await asAdmin(async (c) => (await c.query('SELECT 1 FROM stock_movement WHERE business_id = $1 AND movement_type = $2', [b.owner.businessId, 'COUNT'])).rowCount)).toBe(0);
  });
});
