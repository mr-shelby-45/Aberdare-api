import { randomUUID } from 'node:crypto';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type World, stockApi } from './helpers/stock-api.js';

// Phase C4: stock.convert for managers and owners (docs/phase-c-design.md
// sections 4 and 5). Numbers in test names refer to the C4 list in section 13.
// The approval path for attendants comes in C5.

describe('C4: stock convert', { timeout: 180_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.90', 90_000_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  const convert = (location: string, from: string, to: string, quantity: number, extra: object = {}) =>
    api.command('stock.convert', { location_id: location, from_pack_type_id: from, to_pack_type_id: to, quantity, ...extra });
  const receive = (location: string, lines: object[]) => api.command('stock.receive', { location_id: location, lines });

  /** A product with the given pack sizes; returns pack type ids by units. */
  async function productWith(owner: Member, name: string, sizes: number[]): Promise<{ productId: string; pack: Record<number, string> }> {
    const productId = randomUUID();
    const pack: Record<number, string> = {};
    for (const units of sizes) pack[units] = randomUUID();
    const r = await api.sendOne(
      owner.token,
      api.command('product.create', {
        product_id: productId,
        name,
        pack_types: sizes.map((units) => ({ pack_type_id: pack[units], name: units === 1 ? 'piece' : `pack of ${units}`, units_per_pack: units, sell_price: String(units * 10) })),
      }),
    );
    expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    return { productId, pack };
  }

  const conversions = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{
          id: string;
          created_by_membership_id: string;
          approved_by_membership_id: string;
          approval_id: string | null;
          out_type: string;
          out_pack: string;
          out_change: number;
          in_type: string;
          in_pack: string;
          in_change: number;
        }>(
          `SELECT sc.id, sc.created_by_membership_id, sc.approved_by_membership_id, sc.approval_id,
                  o.movement_type AS out_type, o.pack_type_id AS out_pack, o.quantity_change AS out_change,
                  i.movement_type AS in_type, i.pack_type_id AS in_pack, i.quantity_change AS in_change
             FROM stock_conversion sc
             JOIN stock_movement o ON o.id = sc.out_movement_id
             JOIN stock_movement i ON i.id = sc.in_movement_id
            WHERE sc.business_id = $1 ORDER BY sc.created_at, sc.id`,
          [businessId],
        )).rows,
    );

  // ---------------------------------------------------------------- 1. one conversion
  it('1. one carton of 24 becomes 24 pieces: a CONVERT_OUT, a CONVERT_IN and one linking row, approved by the manager', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 5 }, { pack_type_id: w.maize.piece, quantity: 3 }]));
    const cmd = convert(w.loc, w.maize.carton, w.maize.piece, 1, { note: 'shelf empty' });
    const r = await api.sendOne(w.manager.token, cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: { from_after: 4, to_after: 27, units_added: 24, approved_by_membership_id: w.manager.membershipId },
    });
    expect(await conversions(w.owner.businessId)).toEqual([
      expect.objectContaining({
        created_by_membership_id: w.manager.membershipId,
        approved_by_membership_id: w.manager.membershipId,
        approval_id: null,
        out_type: 'CONVERT_OUT',
        out_pack: w.maize.carton,
        out_change: -1,
        in_type: 'CONVERT_IN',
        in_pack: w.maize.piece,
        in_change: 24,
      }),
    ]);
    const moves = (await api.movements(w.owner.businessId)).filter((m) => m.movement_type.startsWith('CONVERT'));
    const syncId = (await api.syncCommand(w.owner.businessId, cmd.command_id)).id;
    expect(moves).toHaveLength(2);
    for (const m of moves) expect(m).toMatchObject({ created_by_membership_id: w.manager.membershipId, sync_command_id: syncId, note: 'shelf empty' });
    expect(moves.find((m) => m.movement_type === 'CONVERT_OUT')).toMatchObject({ quantity_after: 4 });
    expect(moves.find((m) => m.movement_type === 'CONVERT_IN')).toMatchObject({ quantity_after: 27 });

    // Several at once: 3 cartons give 72 pieces.
    expect(await api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 3))).toMatchObject({
      status: 'ACCEPTED',
      result: { from_after: 1, to_after: 99, units_added: 72 },
    });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(1);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(99);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. ratios
  it('2. ratios: 24 to 1 and 24 to 12 work; 10 to 4 is CONVERSION_RATIO_INVALID; other products, the same pack and smaller to larger are not convertible', async () => {
    const w = await api.world();
    const p = await productWith(w.owner, 'Sugar', [1, 4, 10, 12, 24]);
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: p.pack[24], quantity: 10 }, { pack_type_id: p.pack[10], quantity: 10 }, { pack_type_id: p.pack[4], quantity: 10 }]));

    expect(await api.sendOne(w.manager.token, convert(w.loc, p.pack[24], p.pack[1], 1))).toMatchObject({ status: 'ACCEPTED', result: { units_added: 24 } });
    expect(await api.sendOne(w.manager.token, convert(w.loc, p.pack[24], p.pack[12], 2))).toMatchObject({ status: 'ACCEPTED', result: { from_after: 7, to_after: 4, units_added: 4 } });
    expect(await api.sendOne(w.manager.token, convert(w.loc, p.pack[10], p.pack[4], 1))).toMatchObject({ status: 'REJECTED', reason: 'CONVERSION_RATIO_INVALID' });
    for (const [from, to] of [
      [p.pack[24], w.maize.piece], // another product
      [p.pack[24], p.pack[24]], // the same pack type
      [p.pack[4], p.pack[24]], // smaller to larger
      [p.pack[1], p.pack[4]],
    ]) {
      expect(await api.sendOne(w.manager.token, convert(w.loc, from, to, 1))).toMatchObject({ status: 'REJECTED', reason: 'PACK_TYPES_NOT_CONVERTIBLE' });
    }
    // Malformed quantities.
    for (const quantity of [0, -1, 1.5, 100_001]) {
      expect(await api.sendOne(w.manager.token, convert(w.loc, p.pack[24], p.pack[1], quantity)), String(quantity)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    expect((await api.sendOne(w.manager.token, api.command('stock.convert', { location_id: w.loc, from_pack_type_id: p.pack[24], to_pack_type_id: p.pack[1], quantity: 1, business_id: w.owner.businessId }))).reason).toBe('VALIDATION_FAILED');

    // A result over 2,000,000,000 is VALIDATION_FAILED, and the source is untouched.
    // The first conversion left 24 pieces; raise the pool to 1,999,999,990 with a matching movement.
    await asAdmin(async (c) => {
      await c.query('UPDATE stock_balance SET quantity = quantity + 1999999966 WHERE business_id = $1 AND location_id = $2 AND pack_type_id = $3', [
        w.owner.businessId,
        w.loc,
        p.pack[1],
      ]);
      await c.query(
        `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at)
         VALUES ($1, $2, $3, 1999999966, 'RECEIVE', 1999999990, now())`,
        [w.owner.businessId, w.loc, p.pack[1]],
      );
    });
    expect(await api.balanceOf(w.owner.businessId, w.loc, p.pack[1])).toBe(1_999_999_990);
    // One carton more would be 2,000,000,014.
    expect(await api.sendOne(w.manager.token, convert(w.loc, p.pack[24], p.pack[1], 1))).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await api.balanceOf(w.owner.businessId, w.loc, p.pack[24])).toBe(7);
    expect(await conversions(w.owner.businessId)).toHaveLength(2);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 3. strict source
  it('3. with too few cartons the command is STOCK_INSUFFICIENT and nothing changes', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 1 }, { pack_type_id: w.maize.piece, quantity: 5 }]));
    const before = await api.movements(w.owner.businessId);
    expect(await api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 2))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    // A negative source is refused too (strict), even for one pack.
    await api.sell(w, w.loc, w.maize.carton, 2); // carton -1
    expect(await api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 1))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(-1);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(5);
    expect((await api.movements(w.owner.businessId)).filter((m) => m.movement_type.startsWith('CONVERT'))).toEqual([]);
    expect(await api.movements(w.owner.businessId)).toHaveLength(before.length + 1); // only the sale
    expect(await conversions(w.owner.businessId)).toEqual([]);
    expect((await api.auditRows(w.owner.businessId)).filter((a) => a.action === 'stock.converted')).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. concurrency (run 5 times)
  it('4. 20 concurrent conversions against 5 cartons, alongside piece sales: exactly 5 succeed, cartons 0, pieces +120', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 5 }, { pack_type_id: w.maize.piece, quantity: 30 }]));
    const work = [
      ...Array.from({ length: 20 }, () => api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 1))),
      ...Array.from({ length: 20 }, () => api.sell(w, w.loc, w.maize.piece, 1)),
    ];
    const results = (await Promise.all(work)).slice(0, 20) as { status: string; reason?: string }[];
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'REJECTED' && r.reason === 'STOCK_INSUFFICIENT')).toHaveLength(15);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(0);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(30 + 120 - 20);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.carton)).toBe(0);
    expect(await api.ledgerSum(w.owner.businessId, w.loc, w.maize.piece)).toBe(130);
    expect(await conversions(w.owner.businessId)).toHaveLength(5);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  it('4. case-to-carton and carton-to-piece conversions at the same time: no deadlock, no timeout, units conserved', async () => {
    const w = await api.world();
    const p = await productWith(w.owner, 'Soap', [1, 24, 48]);
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: p.pack[48], quantity: 10 }, { pack_type_id: p.pack[24], quantity: 5 }]));
    const units = async () =>
      (await api.balanceOf(w.owner.businessId, w.loc, p.pack[48])) * 48 +
      (await api.balanceOf(w.owner.businessId, w.loc, p.pack[24])) * 24 +
      (await api.balanceOf(w.owner.businessId, w.loc, p.pack[1]));
    const before = await units();
    const results = await Promise.all([
      ...Array.from({ length: 12 }, () => api.sendOne(w.manager.token, convert(w.loc, p.pack[48], p.pack[24], 1))),
      ...Array.from({ length: 12 }, () => api.sendOne(w.manager.token, convert(w.loc, p.pack[24], p.pack[1], 1))),
      ...Array.from({ length: 10 }, () => api.sell(w, w.loc, p.pack[1], 1)),
    ]);
    const commands = results.slice(0, 24) as { status: string; reason?: string }[];
    // Every command either converted or found too few packs: none FAILED (a deadlock or a pool timeout would).
    for (const r of commands) expect(['ACCEPTED', 'STOCK_INSUFFICIENT']).toContain(r.status === 'ACCEPTED' ? 'ACCEPTED' : r.reason);
    // Cases: 10 available for 12 requests.
    expect(commands.slice(0, 12).filter((r) => r.status === 'ACCEPTED')).toHaveLength(10);
    expect(await api.balanceOf(w.owner.businessId, w.loc, p.pack[48])).toBe(0);
    expect(await units()).toBe(before - 10);
    for (const size of [1, 24, 48]) {
      expect(await api.ledgerSum(w.owner.businessId, w.loc, p.pack[size])).toBe(await api.balanceOf(w.owner.businessId, w.loc, p.pack[size]));
    }
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 5. permissions
  it('5. an attendant is denied, even with an approval_id or stock.convert stored as an extra; a manager and the owner succeed', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 5 }]));
    expect(await api.sendOne(w.attendant.token, convert(w.loc, w.maize.carton, w.maize.piece, 1))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    // A made-up approval_id: refused (PERMISSION_DENIED in C4; since C5 it is checked as an approval).
    expect(await api.sendOne(w.attendant.token, convert(w.loc, w.maize.carton, w.maize.piece, 1, { approval_id: randomUUID() }))).toMatchObject({
      status: 'REJECTED',
      reason: 'APPROVAL_INVALID',
    });
    // stock.convert written straight into the attendant's extras (test setup, as the superuser;
    // the API refuses it): the live permission check still ignores it.
    await asAdmin((c) => c.query("UPDATE membership SET extra_permissions = ARRAY['stock.convert'] WHERE id = $1", [w.attendant.membershipId]));
    expect(await api.sendOne(w.attendant.token, convert(w.loc, w.maize.carton, w.maize.piece, 1))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(5);

    // A manager with an approval_id: it is ignored (not consumed), and the manager is the approver.
    expect(await api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 1, { approval_id: randomUUID() }))).toMatchObject({
      status: 'ACCEPTED',
      result: { approved_by_membership_id: w.manager.membershipId },
    });
    expect(await api.sendOne(w.owner.token, convert(w.loc, w.maize.carton, w.maize.piece, 1))).toMatchObject({
      status: 'ACCEPTED',
      result: { approved_by_membership_id: w.owner.membershipId },
    });
    expect((await conversions(w.owner.businessId)).map((c) => [c.created_by_membership_id, c.approved_by_membership_id, c.approval_id])).toEqual(
      expect.arrayContaining([
        [w.manager.membershipId, w.manager.membershipId, null],
        [w.owner.membershipId, w.owner.membershipId, null],
      ]),
    );
  });

  // ---------------------------------------------------------------- 6. idempotency
  it('6. the same command id converts once, sent twice in a row or 10 times at once', async () => {
    const w = await api.world();
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 5 }]));
    const cmd = convert(w.loc, w.maize.carton, w.maize.piece, 1);
    const first = await api.sendOne(w.manager.token, cmd);
    expect(await api.sendOne(w.manager.token, cmd)).toEqual(first);
    const other = convert(w.loc, w.maize.carton, w.maize.piece, 2);
    const copies = await Promise.all(Array.from({ length: 10 }, () => api.sendOne(w.manager.token, other)));
    for (const r of copies) expect(r).toEqual(copies[0]);
    expect(copies[0]).toMatchObject({ status: 'ACCEPTED', result: { from_after: 2, units_added: 48 } });
    expect(await conversions(w.owner.businessId)).toHaveLength(2);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(72);
  });

  // ---------------------------------------------------------------- 7. audit, change_log, isolation
  it('7. audit stock.converted without the note, change_log for both balances, and another business stays apart', async () => {
    const w = await api.world();
    const b: World = await api.world('Duka B');
    await api.sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 2 }]));
    t.clock.advanceMinutes(1);
    await api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 1, { note: 'private convert note' }));

    const audit = (await api.auditRows(w.owner.businessId)).filter((a) => a.action === 'stock.converted');
    expect(audit).toEqual([
      {
        action: 'stock.converted',
        target_type: 'location',
        target_id: w.loc,
        actor_membership_id: w.manager.membershipId,
        metadata: {
          location_id: w.loc,
          from_pack_type_id: w.maize.carton,
          to_pack_type_id: w.maize.piece,
          quantity: 1,
          units_added: 24,
          approved_by_membership_id: w.manager.membershipId,
          approval_id: null,
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('private convert note');
    // The receive's INSERT, then the convert: the carton UPDATE first (larger pack), then the piece INSERT.
    expect(await api.balanceLog(w.owner.businessId)).toEqual([
      { pack_type_id: w.maize.carton, operation: 'INSERT' },
      { pack_type_id: w.maize.carton, operation: 'UPDATE' },
      { pack_type_id: w.maize.piece, operation: 'INSERT' },
    ]);

    // Another business's location or pack type: the same answer as a missing one, nothing written.
    const missingLoc = await api.sendOne(w.manager.token, convert(randomUUID(), w.maize.carton, w.maize.piece, 1));
    const foreignLoc = await api.sendOne(w.manager.token, convert(b.loc, w.maize.carton, w.maize.piece, 1));
    expect(foreignLoc).toEqual({ ...missingLoc, command_id: foreignLoc.command_id });
    expect(foreignLoc.reason).toBe('LOCATION_NOT_FOUND');
    const missingPack = await api.sendOne(w.manager.token, convert(w.loc, randomUUID(), w.maize.piece, 1));
    const foreignPack = await api.sendOne(w.manager.token, convert(w.loc, b.maize.carton, w.maize.piece, 1));
    expect(foreignPack).toEqual({ ...missingPack, command_id: foreignPack.command_id });
    expect(foreignPack.reason).toBe('PACK_TYPE_NOT_FOUND');
    expect(await api.balances(b.owner.businessId)).toEqual([]);
    expect(await conversions(b.owner.businessId)).toEqual([]);

    // Archived locations and pack types may be converted, so old stock can be cleaned up.
    expect((await api.sendOne(w.owner.token, api.command('product.update', { product_id: w.maize.productId, archived: true }))).status).toBe('ACCEPTED');
    expect(await api.sendOne(w.manager.token, convert(w.loc, w.maize.carton, w.maize.piece, 1))).toMatchObject({ status: 'ACCEPTED', result: { from_after: 0 } });
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });
});
