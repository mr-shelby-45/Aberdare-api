import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type World, stockApi } from './helpers/stock-api.js';

// Phase E3: payments inside sale.create, and payment.attach
// (docs/phase-e-design.md sections 4, 5 and 9). Numbers in test names refer to
// the E3 list in section 13.

describe('E3: payments', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.181', 98_100_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  let refSeq = 0;
  const cash = (amount: string) => ({ method: 'CASH', amount });
  const mpesa = (amount: string, mpesa_code: string) => ({ method: 'MPESA', amount, mpesa_code });
  // A sale of `qty` maize pieces at 100.00 each, with these payments.
  const sale = (w: World, payments: object[] | undefined, qty = 1, extra: object = {}) =>
    api.command('sale.create', {
      sale_id: randomUUID(),
      local_ref: `P-${++refSeq}`,
      location_id: w.loc,
      lines: [{ pack_type_id: w.maize.piece, quantity: qty, unit_price: '100' }],
      ...(payments ? { payments } : {}),
      ...extra,
    });
  const saleIdOf = (cmd: { payload: object }) => (cmd.payload as { sale_id: string }).sale_id;
  const attach = (saleId: string, payments: object[]) => api.command('payment.attach', { sale_id: saleId, payments });
  /** A saved sale of `qty` pieces without payments; returns its id. */
  async function unpaidSale(w: World, by: Member, qty = 1): Promise<string> {
    const cmd = sale(w, undefined, qty);
    expect(['ACCEPTED', 'FLAGGED']).toContain((await api.sendOne(by.token, cmd)).status);
    return saleIdOf(cmd);
  }

  const paymentRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{
          id: string;
          sale_id: string;
          method: string;
          amount: string;
          mpesa_code: string | null;
          verified: boolean;
          duplicate_of_payment_id: string | null;
          status: string;
          created_by_membership_id: string;
          occurred_at: Date;
        }>(
          `SELECT id, sale_id, method, amount::text, mpesa_code, verified, duplicate_of_payment_id, status, created_by_membership_id, occurred_at
             FROM payment WHERE business_id = $1 ORDER BY created_at, amount`,
          [businessId],
        )).rows,
    );
  const saleMoney = (saleId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ total: string; paid_total: string; balance_due: string }>('SELECT total::text, paid_total::text, balance_due::text FROM sale WHERE id = $1', [saleId]))
          .rows[0],
    );
  const saleCount = (businessId: string) =>
    asAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM sale WHERE business_id = $1', [businessId])).rows[0].n));
  /** Waits until at least n backends of the test database wait for a lock (forces the overlap in race tests). */
  async function lockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const waiting = await asAdmin(
        async (c) =>
          Number(
            (await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n,
          ),
      );
      if (waiting >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`fewer than ${n} backends waited for a lock`);
  }
  const heldClient = async () => {
    const c = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await c.connect();
    await c.query('BEGIN');
    return c;
  };

  // ---------------------------------------------------------------- 1. payments in a sale
  it('1. cash and M-Pesa payments in a sale: unverified rows, paid_total and balance_due; split, partial and over payments', async () => {
    const w = await api.world();
    // Split exactly: 300.00 = 120.50 cash + 179.50 M-Pesa.
    const split = sale(w, [cash('120.50'), mpesa('179.5', 'qwe12345rt')], 3);
    expect(await api.sendOne(w.attendant.token, split)).toMatchObject({
      status: 'FLAGGED', // no stock
      reason: 'STOCK_NEGATIVE',
      result: { total: '300.00', paid_total: '300.00', balance_due: '0.00', flags: ['STOCK_NEGATIVE'] },
    });
    expect(await saleMoney(saleIdOf(split))).toEqual({ total: '300.00', paid_total: '300.00', balance_due: '0.00' });
    const rows = await paymentRows(w.owner.businessId);
    expect(rows.map((p) => ({ ...p, id: undefined, occurred_at: undefined }))).toEqual([
      { id: undefined, sale_id: saleIdOf(split), method: 'CASH', amount: '120.50', mpesa_code: null, verified: false, duplicate_of_payment_id: null, status: 'RECORDED', created_by_membership_id: w.attendant.membershipId, occurred_at: undefined },
      { id: undefined, sale_id: saleIdOf(split), method: 'MPESA', amount: '179.50', mpesa_code: 'QWE12345RT', verified: false, duplicate_of_payment_id: null, status: 'RECORDED', created_by_membership_id: w.attendant.membershipId, occurred_at: undefined },
    ]);
    expect(rows[0].occurred_at.toISOString()).toBe((split as { occurred_at: string }).occurred_at);

    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 100 }] }));
    // Partial: a balance stays due. No payments: the whole total is due.
    expect(await api.sendOne(w.attendant.token, sale(w, [cash('50')], 2))).toMatchObject({ status: 'ACCEPTED', result: { total: '200.00', paid_total: '50.00', balance_due: '150.00', flags: [] } });
    expect(await api.sendOne(w.attendant.token, sale(w, [], 2))).toMatchObject({ status: 'ACCEPTED', result: { paid_total: '0.00', balance_due: '200.00' } });
    // Over: saved and flagged; nothing is due.
    const over = sale(w, [cash('100'), cash('0.01')], 1);
    expect(await api.sendOne(w.attendant.token, over)).toMatchObject({
      status: 'FLAGGED',
      reason: 'OVERPAYMENT',
      result: { total: '100.00', paid_total: '100.01', balance_due: '0.00', flags: ['OVERPAYMENT'] },
    });
    expect(await saleMoney(saleIdOf(over))).toEqual({ total: '100.00', paid_total: '100.01', balance_due: '0.00' });
    // Exact cents: 0.10 + 0.20 is 0.30, not 0.30000000000000004.
    expect(await api.sendOne(w.attendant.token, api.command('sale.create', { sale_id: randomUUID(), local_ref: 'cents', location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 3, unit_price: '0.10' }], payments: [cash('0.10'), cash('0.20')] }))).toMatchObject({
      status: 'ACCEPTED',
      result: { total: '0.30', paid_total: '0.30', balance_due: '0.00' },
    });
  });

  // ---------------------------------------------------------------- 2. validation
  it('2. every bad payment is listed and nothing is saved; codes are stored upper-case', async () => {
    const w = await api.world();
    const r = await api.sendOne(
      w.attendant.token,
      sale(w, [
        cash('10'), // 1: fine
        { method: 'CARD', amount: '10' }, // 2
        { method: 'cash', amount: '10' }, // 3: methods are exact
        cash('0'), // 4
        cash('-5'), // 5
        cash('1.234'), // 6
        { method: 'MPESA', amount: '10' }, // 7: no code
        { method: 'MPESA', amount: '10', mpesa_code: null }, // 8: no code
        { method: 'CASH', amount: '10', mpesa_code: 'ABCD1234' }, // 9: cash with a code
        mpesa('10', 'ABC1234'), // 10: 7 characters
      ]),
    );
    expect(r).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_PAYMENTS',
      result: {
        invalid_payments: [
          { payment: 2, reason: 'METHOD_INVALID' },
          { payment: 3, reason: 'METHOD_INVALID' },
          { payment: 4, reason: 'AMOUNT_INVALID' },
          { payment: 5, reason: 'AMOUNT_INVALID' },
          { payment: 6, reason: 'AMOUNT_INVALID' },
          { payment: 7, reason: 'MPESA_CODE_MISSING' },
          { payment: 8, reason: 'MPESA_CODE_MISSING' },
          { payment: 9, reason: 'MPESA_CODE_NOT_ALLOWED' },
          { payment: 10, reason: 'MPESA_CODE_INVALID' },
        ],
      },
    });
    expect(await api.sendOne(w.attendant.token, sale(w, [mpesa('10', 'ABCDEF1234567'), cash('10'), mpesa('10', 'ABCD-1234'), mpesa('10', 'ABCDEFGH')]))).toMatchObject({
      reason: 'INVALID_PAYMENTS',
      result: { invalid_payments: [{ payment: 1, reason: 'MPESA_CODE_INVALID' }, { payment: 3, reason: 'MPESA_CODE_INVALID' }] }, // 13 characters; other characters
    });
    // Malformed shapes and too many payments fail the whole command.
    for (const payments of [[{ method: 'CASH', amount: 10 }], [{ method: 'CASH', amount: '1', extra: true }], Array.from({ length: 11 }, () => cash('1'))]) {
      expect(await api.sendOne(w.attendant.token, sale(w, payments)), JSON.stringify(payments).slice(0, 60)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    // Ten payments above NUMERIC(14,2) together.
    expect(await api.sendOne(w.attendant.token, sale(w, Array.from({ length: 10 }, () => cash('999999999999.99'))))).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    // Bad lines are reported before payments.
    const both = api.command('sale.create', { sale_id: randomUUID(), local_ref: 'x', location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 0, unit_price: '1' }], payments: [cash('0')] });
    expect(await api.sendOne(w.attendant.token, both)).toMatchObject({ reason: 'INVALID_LINES' });
    expect(await saleCount(w.owner.businessId)).toBe(0);
    expect(await paymentRows(w.owner.businessId)).toEqual([]);

    // Lower case and surrounding spaces are normalised.
    expect((await api.sendOne(w.attendant.token, sale(w, [mpesa('100', '  rk45hj78lp ')]))).status).not.toBe('REJECTED');
    expect((await paymentRows(w.owner.businessId)).map((p) => p.mpesa_code)).toEqual(['RK45HJ78LP']);
    // ... so the same code in another case is a duplicate.
    expect(await api.sendOne(w.attendant.token, sale(w, [mpesa('100', 'Rk45Hj78Lp')]))).toMatchObject({ result: { flags: expect.arrayContaining(['DUPLICATE_MPESA_CODE']) } });
  });

  // ---------------------------------------------------------------- 3. reused codes
  it('3. a reused code keeps the sale, marks the payment as a duplicate of the first and flags DUPLICATE_MPESA_CODE; another business may use it', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.piece, quantity: 100 }] }));
    const first = sale(w, [mpesa('100', 'SAMECODE01')]);
    expect(await api.sendOne(w.attendant.token, first)).toMatchObject({ status: 'ACCEPTED', result: { flags: [] } });
    const second = sale(w, [mpesa('100', 'SAMECODE01')]);
    expect(await api.sendOne(w.attendant.token, second)).toMatchObject({
      status: 'FLAGGED',
      reason: 'DUPLICATE_MPESA_CODE',
      result: { sale_number: 2, paid_total: '100.00', balance_due: '0.00', flags: ['DUPLICATE_MPESA_CODE'] },
    });
    // Two payments with one code inside one sale: the second is a duplicate of the first.
    const twice = sale(w, [mpesa('50', 'INSALE0001'), mpesa('50', 'INSALE0001')]);
    expect(await api.sendOne(w.attendant.token, twice)).toMatchObject({ status: 'FLAGGED', reason: 'DUPLICATE_MPESA_CODE' });
    // The flag order: OVERPAYMENT comes after DUPLICATE_MPESA_CODE.
    expect(await api.sendOne(w.attendant.token, sale(w, [mpesa('150', 'SAMECODE01')]))).toMatchObject({ reason: 'DUPLICATE_MPESA_CODE', result: { flags: ['DUPLICATE_MPESA_CODE', 'OVERPAYMENT'] } });

    const rows = await paymentRows(w.owner.businessId);
    const original = rows.find((p) => p.sale_id === saleIdOf(first))!;
    expect(original.duplicate_of_payment_id).toBeNull();
    expect(rows.filter((p) => p.mpesa_code === 'SAMECODE01' && p.id !== original.id).map((p) => p.duplicate_of_payment_id)).toEqual([original.id, original.id]);
    const inSale = rows.filter((p) => p.sale_id === saleIdOf(twice));
    expect(inSale.filter((p) => p.duplicate_of_payment_id === null)).toHaveLength(1);
    expect(inSale.filter((p) => p.duplicate_of_payment_id !== null).map((p) => p.duplicate_of_payment_id)).toEqual([inSale.find((p) => p.duplicate_of_payment_id === null)!.id]);
    expect(await saleCount(w.owner.businessId)).toBe(4);

    // Another business: an original of its own.
    expect(await api.sendOne(b.attendant.token, sale(b, [mpesa('100', 'SAMECODE01')]))).toMatchObject({ result: { flags: ['STOCK_NEGATIVE'] } });
    expect((await paymentRows(b.owner.businessId)).map((p) => p.duplicate_of_payment_id)).toEqual([null]);
  });

  it('3. 20 concurrent sales with one code: all saved, exactly one original and 19 duplicates', async () => {
    const w = await api.world();
    const results = await Promise.all(Array.from({ length: 20 }, () => api.sendOne(w.attendant.token, sale(w, [mpesa('100', 'RACECODE20')]))));
    expect(results.filter((r) => r.status === 'REJECTED' || r.status === 'FAILED')).toEqual([]);
    expect(results.filter((r) => (r.result as { flags: string[] }).flags.includes('DUPLICATE_MPESA_CODE'))).toHaveLength(19);
    const rows = await paymentRows(w.owner.businessId);
    expect(rows).toHaveLength(20);
    const originals = rows.filter((p) => p.duplicate_of_payment_id === null);
    expect(originals).toHaveLength(1);
    expect(new Set(rows.filter((p) => p.duplicate_of_payment_id !== null).map((p) => p.duplicate_of_payment_id))).toEqual(new Set([originals[0].id]));
    expect(await saleCount(w.owner.businessId)).toBe(20);
  });

  it('3. race: attaches wait for an uncommitted original with the same code, then all become its duplicates (forced overlap)', async () => {
    const w = await api.world();
    const sales = [];
    for (let i = 0; i < 9; i++) sales.push(await unpaidSale(w, w.attendant));
    // An uncommitted original for the code, on the first sale.
    const held = await heldClient();
    let committed = false;
    try {
      const inserted = await held.query<{ id: string }>(
        `INSERT INTO payment (business_id, sale_id, method, amount, mpesa_code, status, occurred_at, created_by_membership_id, location_id, recorded_by_device_id)
         SELECT $1, $2, 'MPESA', 1, 'HELDCODE01', 'RECORDED', now(), $3, s.location_id, s.device_id FROM sale s WHERE s.id = $2 RETURNING id`,
        [w.owner.businessId, sales[0], w.attendant.membershipId],
      );
      const pending = sales.slice(1).map((id) => api.sendOne(w.manager.token, attach(id, [mpesa('10', 'HELDCODE01')])));
      await lockWaiters(8);
      await held.query('COMMIT');
      committed = true;
      const results = await Promise.all(pending);
      for (const r of results) expect(r).toMatchObject({ status: 'FLAGGED', reason: 'DUPLICATE_MPESA_CODE' });
      const rows = (await paymentRows(w.owner.businessId)).filter((p) => p.mpesa_code === 'HELDCODE01');
      expect(rows).toHaveLength(9);
      expect(rows.filter((p) => p.id !== inserted.rows[0].id).map((p) => p.duplicate_of_payment_id)).toEqual(Array(8).fill(inserted.rows[0].id));
    } finally {
      if (!committed) await held.query('ROLLBACK');
      await held.end();
    }
  });

  it('3. race: 20 concurrent attaches with one new code on 20 sales give exactly one original', async () => {
    const w = await api.world();
    const sales = [];
    for (let i = 0; i < 20; i++) sales.push(await unpaidSale(w, w.attendant));
    const results = await Promise.all(sales.map((id) => api.sendOne(w.manager.token, attach(id, [mpesa('100', 'ATTACHRACE')])))) ;
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'FLAGGED' && r.reason === 'DUPLICATE_MPESA_CODE')).toHaveLength(19);
    const rows = await paymentRows(w.owner.businessId);
    expect(rows.filter((p) => p.duplicate_of_payment_id === null)).toHaveLength(1);
    expect(rows).toHaveLength(20);
  });

  // ---------------------------------------------------------------- 4. payment.attach
  it('4. payment.attach pays a balance; unknown, foreign and (for attendants) other members\' sales are SALE_NOT_FOUND; voided is SALE_VOIDED', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    const own = await unpaidSale(w, w.attendant, 3); // 300.00 due
    expect(await api.sendOne(w.attendant.token, attach(own, [cash('100')]))).toEqual(expect.objectContaining({ status: 'ACCEPTED', result: { paid_total: '100.00', balance_due: '200.00', flags: [] } }));
    // The same command id twice attaches once (the stored outcome is replayed).
    const again = attach(own, [mpesa('150', 'ATTACH0001')]);
    const firstTry = await api.sendOne(w.attendant.token, again);
    expect(firstTry).toMatchObject({ status: 'ACCEPTED', result: { paid_total: '250.00', balance_due: '50.00' } });
    expect(await api.sendOne(w.attendant.token, again)).toEqual(firstTry);
    expect(await saleMoney(own)).toEqual({ total: '300.00', paid_total: '250.00', balance_due: '50.00' });
    // Over the total: saved and flagged.
    expect(await api.sendOne(w.attendant.token, attach(own, [cash('60')]))).toMatchObject({ status: 'FLAGGED', reason: 'OVERPAYMENT', result: { paid_total: '310.00', balance_due: '0.00', flags: ['OVERPAYMENT'] } });
    // Already paid: any further payment is an overpayment.
    expect(await api.sendOne(w.attendant.token, attach(own, [cash('1')]))).toMatchObject({ reason: 'OVERPAYMENT', result: { paid_total: '311.00' } });

    // Not found: unknown, another business's, and another member's for an attendant (identical answers).
    const managers = await unpaidSale(w, w.manager);
    const foreign = await unpaidSale(b, b.attendant);
    const answers = [];
    for (const id of [randomUUID(), foreign, managers]) answers.push(await api.sendOne(w.attendant.token, attach(id, [cash('1')])));
    for (const a of answers) expect({ ...a, command_id: null }).toEqual({ command_id: null, status: 'REJECTED', reason: 'SALE_NOT_FOUND', message: answers[0].message });
    // A manager attaches to an attendant's sale; an owner too.
    expect((await api.sendOne(w.manager.token, attach(own, [cash('1')]))).status).toBe('FLAGGED');
    expect((await api.sendOne(w.owner.token, attach(managers, [cash('100')]))).status).toBe('ACCEPTED');

    // A voided sale (void is E5; set here as the superuser).
    const voided = await unpaidSale(w, w.attendant);
    await asAdmin((c) =>
      c.query(
        `UPDATE sale SET status = 'VOIDED', voided_at = now(), voided_by_membership_id = $2, void_reason = 'MISTAKE', void_approved_by_membership_id = $2 WHERE id = $1`,
        [voided, w.manager.membershipId],
      ),
    );
    expect(await api.sendOne(w.manager.token, attach(voided, [cash('1')]))).toMatchObject({ status: 'REJECTED', reason: 'SALE_VOIDED' });
    expect(await saleMoney(voided)).toEqual({ total: '100.00', paid_total: '0.00', balance_due: '100.00' });

    // Bad payments: listed, nothing saved; a paid_total beyond NUMERIC(14,2) is VALIDATION_FAILED.
    const before = (await paymentRows(w.owner.businessId)).length;
    expect(await api.sendOne(w.attendant.token, attach(own, [cash('1'), cash('x')]))).toMatchObject({ reason: 'INVALID_PAYMENTS', result: { invalid_payments: [{ payment: 2, reason: 'AMOUNT_INVALID' }] } });
    expect(await api.sendOne(w.owner.token, attach(managers, [cash('999999999999.99')]))).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await api.sendOne(w.attendant.token, api.command('payment.attach', { sale_id: own, payments: [] }))).toMatchObject({ reason: 'VALIDATION_FAILED' });
    expect(await api.sendOne(w.attendant.token, api.command('payment.attach', { sale_id: own, payments: [cash('1')], business_id: b.owner.businessId }))).toMatchObject({ reason: 'VALIDATION_FAILED' });
    expect((await paymentRows(w.owner.businessId)).length).toBe(before);
    expect(await saleMoney(managers)).toEqual({ total: '100.00', paid_total: '100.00', balance_due: '0.00' });
    expect(await paymentRows(b.owner.businessId)).toEqual([]);
  });

  it('4. race: concurrent attaches to one sale add up exactly (they queue on the sale row, forced overlap)', async () => {
    const w = await api.world();
    const id = await unpaidSale(w, w.attendant, 10); // 1000.00
    const held = await heldClient();
    let committed = false;
    try {
      await held.query('SELECT 1 FROM sale WHERE id = $1 FOR UPDATE', [id]);
      const pending = Array.from({ length: 8 }, (_, i) => api.sendOne(w.manager.token, attach(id, [cash(`${i + 1}.01`)])));
      await lockWaiters(8);
      await held.query('COMMIT');
      committed = true;
      const results = await Promise.all(pending);
      for (const r of results) expect(r.status).toBe('ACCEPTED');
    } finally {
      if (!committed) await held.query('ROLLBACK');
      await held.end();
    }
    // 1.01 + 2.01 + ... + 8.01 = 36.08
    expect(await saleMoney(id)).toEqual({ total: '1000.00', paid_total: '36.08', balance_due: '963.92' });
    expect((await paymentRows(w.owner.businessId)).length).toBe(8);
  });

  // ---------------------------------------------------------------- 5. permissions
  it('5. payments need payments.confirm; a sale without payments does not; an attendant sale with payments works', async () => {
    const w = await api.world();
    // Every preset has payments.confirm and extras only add, so this actor is built directly.
    const sync = t.app.get(SyncService, { strict: false });
    const actor = { businessId: w.owner.businessId, membershipId: w.attendant.membershipId, deviceId: w.attendant.deviceId!, permissions: new Set(['sales.create']) };
    const paid = await unpaidSale(w, w.attendant);
    const [withPayments, without, attached] = await sync.processCommands(actor, [sale(w, [cash('100')]), sale(w, []), attach(paid, [cash('1')])]);
    expect(withPayments).toMatchObject({ status: 'REJECTED', code: 'PERMISSION_DENIED' });
    expect(without).toMatchObject({ status: 'FLAGGED', code: 'STOCK_NEGATIVE' });
    expect(attached).toMatchObject({ status: 'REJECTED', code: 'PERMISSION_DENIED' });
    expect(await saleCount(w.owner.businessId)).toBe(2);
    expect(await paymentRows(w.owner.businessId)).toEqual([]);
    // A real attendant has payments.confirm.
    expect(await api.sendOne(w.attendant.token, sale(w, [cash('100')]))).toMatchObject({ result: { paid_total: '100.00' } });
  });

  // ---------------------------------------------------------------- 6. audit
  it('6. audit: sale.created carries payment totals, payment.attached once per attach; no code or single amount', async () => {
    const w = await api.world();
    const cmd = sale(w, [cash('40.25'), mpesa('59.75', 'AUDITCODE9')], 1);
    await api.sendOne(w.attendant.token, cmd);
    await api.sendOne(w.attendant.token, attach(saleIdOf(cmd), [cash('12.34'), mpesa('0.66', 'AUDITCODE9')]));
    const rows = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string; metadata: Record<string, unknown> }>(
          "SELECT action, actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action IN ('sale.created', 'payment.attached') ORDER BY action DESC",
          [w.owner.businessId],
        )).rows,
    );
    expect(rows).toEqual([
      {
        action: 'sale.created',
        actor_membership_id: w.attendant.membershipId,
        metadata: { sale_id: saleIdOf(cmd), sale_number: 1, location_id: w.loc, total: '100.00', line_count: 1, payment_count: 2, paid_total: '100.00', flags: ['STOCK_NEGATIVE'] },
      },
      {
        action: 'payment.attached',
        actor_membership_id: w.attendant.membershipId,
        metadata: { sale_id: saleIdOf(cmd), payment_count: 2, amount_total: '13.00', flags: ['DUPLICATE_MPESA_CODE', 'OVERPAYMENT'] },
      },
    ]);
    const text = JSON.stringify(rows);
    for (const secret of ['AUDITCODE9', '40.25', '59.75', '12.34', '0.66', 'mpesa']) expect(text, secret).not.toContain(secret);
  });
});
