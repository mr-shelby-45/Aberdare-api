import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TenantRunner } from '../src/database/tenant.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { prismaWithPool } from './helpers/prisma.js';
import { type Shop, seedShop } from './helpers/shop.js';
import type { PrismaService } from '../src/database/prisma.service.js';

// Phase E1: the sales schema (docs/phase-e-design.md section 3). Numbers in
// test names refer to the E1 list in section 13. Everything here is raw SQL
// as app_user on one known connection, so the database rules themselves are
// what is tested (the services come in E2 to E5). E1 test 1's exact
// inventories are in test/step4-migrations.spec.ts and test/b5-hardening.spec.ts;
// E1 test 7 is the earlier suites.

interface World extends Shop {
  device: string;
}

describe('E1: sales schema', { timeout: 120_000 }, () => {
  let prisma: PrismaService;
  let tenants: TenantRunner;

  beforeAll(async () => {
    prisma = prismaWithPool(5);
    await prisma.$connect();
    tenants = new TenantRunner(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTables();
  });

  /** One statement as app_user in the business's tenant transaction: "ok <rows>" or the error message. */
  async function asApp(businessId: string, sql: string, params: unknown[] = []): Promise<string> {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return `ok ${r.rowCount}`;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      return (e as Error).message;
    } finally {
      await c.end();
    }
  }

  async function world(name = 'Shop A'): Promise<World> {
    const s = await seedShop(tenants, name);
    const device = randomUUID();
    expect(
      await asApp(s.biz, "INSERT INTO device (id, business_id, name, platform, secret_hash, status, registered_by_membership_id) VALUES ($1, $2, 'phone', 'android', 'x', 'ACTIVE', $3)", [
        device,
        s.biz,
        s.member,
      ]),
    ).toBe('ok 1');
    return { ...s, device };
  }

  const insertSale = (w: World, id: string, over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id,
      business_id: w.biz,
      sale_number: 1,
      local_ref: 'R-1',
      location_id: w.loc,
      device_id: w.device,
      created_by_membership_id: w.member,
      occurred_at: '2026-10-26T08:00:00Z',
      received_at: '2026-10-26T08:00:05Z',
      status: 'COMPLETED',
      total: '100.00',
      paid_total: '0',
      balance_due: '100.00',
      ...over,
    };
    const cols = Object.keys(row);
    return asApp(w.biz, `INSERT INTO sale (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  const insertItem = (w: World, saleId: string, over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      business_id: w.biz,
      sale_id: saleId,
      line_no: 1,
      pack_type_id: w.piece,
      product_name: 'Soda 300ml',
      pack_type_name: 'piece',
      quantity: 3,
      unit_price: '33.33',
      list_price: '50.00',
      line_total: '99.99',
      ...over,
    };
    const cols = Object.keys(row);
    return asApp(w.biz, `INSERT INTO sale_item (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  const insertPayment = (w: World, saleId: string, over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      business_id: w.biz,
      sale_id: saleId,
      method: 'CASH',
      amount: '10.00',
      status: 'RECORDED',
      occurred_at: '2026-10-26T08:00:00Z',
      created_by_membership_id: w.member,
      ...over,
    };
    const cols = Object.keys(row);
    return asApp(w.biz, `INSERT INTO payment (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  const insertMovement = (w: World, over: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      business_id: w.biz,
      location_id: w.loc,
      pack_type_id: w.piece,
      quantity_change: -1,
      movement_type: 'SALE',
      quantity_after: 0,
      occurred_at: '2026-10-26T08:00:00Z',
      ...over,
    };
    const cols = Object.keys(row);
    return asApp(w.biz, `INSERT INTO stock_movement (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  const voidFields = (w: World) => ({
    status: 'VOIDED',
    voided_at: '2026-10-26T09:00:00Z',
    voided_by_membership_id: w.member,
    void_reason: 'MISTAKE',
    void_approved_by_membership_id: w.member,
  });

  // ---------------------------------------------------------------- 1. privileges
  it('1. app_user cannot delete any sale row, cannot update an item, and updates only the listed columns', async () => {
    const w = await world();
    const sale = randomUUID();
    expect(await insertSale(w, sale)).toBe('ok 1');
    expect(await insertItem(w, sale)).toBe('ok 1');
    expect(await insertPayment(w, sale)).toBe('ok 1');
    expect(await asApp(w.biz, 'INSERT INTO sale_counter (business_id, last_number) VALUES ($1, 1)', [w.biz])).toBe('ok 1');

    const denied = /permission denied for table/;
    for (const sql of ['DELETE FROM sale', 'DELETE FROM sale_item', 'DELETE FROM payment', 'DELETE FROM sale_counter']) {
      expect(await asApp(w.biz, sql), sql).toMatch(denied);
    }
    for (const sql of [
      'UPDATE sale_item SET quantity = 2',
      'UPDATE sale SET total = 1',
      'UPDATE sale SET sale_number = 9',
      'UPDATE sale SET location_id = location_id',
      'UPDATE payment SET amount = 1',
      "UPDATE payment SET mpesa_code = 'ABCDEFGH'",
      'UPDATE sale_counter SET business_id = business_id',
    ]) {
      expect(await asApp(w.biz, sql), sql).toMatch(denied);
    }
    // The allowed ones.
    expect(await asApp(w.biz, 'UPDATE sale SET paid_total = 10, balance_due = 90')).toBe('ok 1');
    expect(await asApp(w.biz, "UPDATE payment SET status = 'REVERSED'")).toBe('ok 1');
    expect(await asApp(w.biz, 'UPDATE sale_counter SET last_number = last_number + 1')).toBe('ok 1');
    expect(await asApp(w.biz, "UPDATE sale SET status = 'VOIDED', voided_at = now(), voided_by_membership_id = $1, void_reason = 'OTHER', void_approved_by_membership_id = $1, void_note = 'x'", [w.member])).toBe('ok 1');
  });

  // ---------------------------------------------------------------- 2. checks
  it('2. the database refuses rows that break the sales rules', async () => {
    const w = await world();
    const sale = randomUUID();
    expect(await insertSale(w, sale)).toBe('ok 1');
    let n = 1;
    const next = () => ({ sale_number: ++n });
    const refused: [string, () => Promise<string>, RegExp][] = [
      ['status outside the list', () => insertSale(w, randomUUID(), { ...next(), status: 'OPEN' }), /sale_status_known/],
      ['a partial set of void fields', () => insertSale(w, randomUUID(), { ...next(), status: 'VOIDED', voided_at: '2026-10-26T09:00:00Z' }), /sale_void_fields_together/],
      ['void fields on a completed sale', () => insertSale(w, randomUUID(), { ...next(), ...voidFields(w), status: 'COMPLETED' }), /sale_void_fields_together/],
      ['a void note without a void', () => insertSale(w, randomUUID(), { ...next(), void_note: 'x' }), /sale_void_fields_together/],
      ['a void reason outside the list', () => insertSale(w, randomUUID(), { ...next(), ...voidFields(w), void_reason: 'STOLEN' }), /sale_void_reason_known/],
      ['a negative total', () => insertSale(w, randomUUID(), { ...next(), total: '-1.00', balance_due: '0' }), /sale_total_not_negative/],
      ['a negative balance', () => insertSale(w, randomUUID(), { ...next(), total: '10.00', paid_total: '20.00', balance_due: '-10.00' }), /sale_balance_due/],
      ['a balance that is not total minus paid', () => insertSale(w, randomUUID(), { ...next(), balance_due: '99.00' }), /sale_balance_due/],
      ['a note over 200', () => insertSale(w, randomUUID(), { ...next(), note: 'n'.repeat(201) }), /sale_note_length/],
      ['a local reference over 30', () => insertSale(w, randomUUID(), { ...next(), local_ref: 'r'.repeat(31) }), /sale_local_ref_length/],
      ['an empty local reference', () => insertSale(w, randomUUID(), { ...next(), local_ref: '' }), /sale_local_ref_length/],
      ['a void note over 200', () => insertSale(w, randomUUID(), { ...next(), ...voidFields(w), void_note: 'n'.repeat(201) }), /sale_void_note_length/],
      ['a sale number of 0', () => insertSale(w, randomUUID(), { sale_number: 0 }), /sale_number_positive/],
      ['quantity 0', () => insertItem(w, sale, { line_no: 2, quantity: 0, line_total: '0' }), /sale_item_quantity_range/],
      ['quantity 100,001', () => insertItem(w, sale, { line_no: 2, quantity: 100001, unit_price: '0', line_total: '0' }), /sale_item_quantity_range/],
      ['a negative unit price', () => insertItem(w, sale, { line_no: 2, unit_price: '-1.00', line_total: '-3.00' }), /sale_item_prices_not_negative/],
      ['a wrong line total', () => insertItem(w, sale, { line_no: 2, line_total: '100.00' }), /sale_item_line_total/],
      ['a payment of 0', () => insertPayment(w, sale, { amount: '0' }), /payment_amount_positive/],
      ['a negative payment', () => insertPayment(w, sale, { amount: '-1.00' }), /payment_amount_positive/],
      ['a code on CASH', () => insertPayment(w, sale, { mpesa_code: 'QWE123RTY9' }), /payment_mpesa_code_on_mpesa/],
      ['MPESA without a code', () => insertPayment(w, sale, { method: 'MPESA' }), /payment_mpesa_code_on_mpesa/],
      ['a method outside the list', () => insertPayment(w, sale, { method: 'CARD' }), /payment_method_known/],
      ['a payment status outside the list', () => insertPayment(w, sale, { status: 'PENDING' }), /payment_status_known/],
      ['a verified payment (not before Phase M)', () => insertPayment(w, sale, { verified: true }), /payment_unverified_until_phase_m/],
      ['a counter at 0', () => asApp(w.biz, 'INSERT INTO sale_counter (business_id, last_number) VALUES ($1, 0)', [w.biz]), /sale_counter_positive/],
      ['a SALE_VOID with a negative change', () => insertMovement(w, { movement_type: 'SALE_VOID', quantity_change: -1, sale_id: sale }), /stock_movement_type_sign/],
      ['a positive SALE', () => insertMovement(w, { quantity_change: 1 }), /stock_movement_type_sign/],
      ['a SALE_VOID without a sale', () => insertMovement(w, { movement_type: 'SALE_VOID', quantity_change: 1 }), /stock_movement_sale_id_on_sales/],
      ['a sale on a RECEIVE', () => insertMovement(w, { movement_type: 'RECEIVE', quantity_change: 1, sale_id: sale }), /stock_movement_sale_id_on_sales/],
      ['an approval purpose outside the list', () =>
        asApp(w.biz, "INSERT INTO approval (business_id, purpose, requester_membership_id, approver_membership_id, device_id, valid_until) VALUES ($1, 'REFUND', $2, $2, $3, now() + interval '15 minutes')", [w.biz, w.member, w.device]),
        /approval_purpose_known/],
    ];
    for (const [label, attempt, constraint] of refused) {
      expect(await attempt(), label).toMatch(constraint);
    }
    // The valid kinds are accepted.
    expect(await insertItem(w, sale, { line_no: 2, unit_price: '0', line_total: '0' })).toBe('ok 1'); // a price of 0
    expect(await insertPayment(w, sale, { method: 'MPESA', mpesa_code: 'QWE123RTY9' })).toBe('ok 1');
    expect(await insertMovement(w, { quantity_change: -2, sale_id: sale })).toBe('ok 1');
    expect(await insertMovement(w, { quantity_change: -2 })).toBe('ok 1'); // the spike's sale mode: no sale behind it
    expect(await insertMovement(w, { movement_type: 'SALE_VOID', quantity_change: 2, sale_id: sale })).toBe('ok 1');
    expect(
      await asApp(w.biz, "INSERT INTO approval (business_id, purpose, requester_membership_id, approver_membership_id, device_id, valid_until) VALUES ($1, 'SALE_VOID', $2, $2, $3, now() + interval '15 minutes')", [w.biz, w.member, w.device]),
    ).toBe('ok 1');
    expect(await insertSale(w, randomUUID(), { ...next(), ...voidFields(w), void_note: 'n'.repeat(200) })).toBe('ok 1');
    expect(await insertSale(w, randomUUID(), { ...next(), total: '10.00', paid_total: '25.00', balance_due: '0' })).toBe('ok 1'); // overpaid
  });

  // ---------------------------------------------------------------- 3. composite keys
  it('3. every reference must belong to the same business', async () => {
    const a = await world('Shop A');
    const b = await world('Shop B');
    const saleA = randomUUID();
    const saleB = randomUUID();
    expect(await insertSale(a, saleA)).toBe('ok 1');
    expect(await insertSale(b, saleB)).toBe('ok 1');
    const approvalB = randomUUID();
    expect(
      await asApp(b.biz, "INSERT INTO approval (id, business_id, purpose, requester_membership_id, approver_membership_id, device_id, valid_until) VALUES ($1, $2, 'SALE_VOID', $3, $3, $4, now() + interval '15 minutes')", [
        approvalB,
        b.biz,
        b.member,
        b.device,
      ]),
    ).toBe('ok 1');
    const fk = /violates foreign key constraint/;
    const cases: [string, () => Promise<string>, RegExp][] = [
      ["a sale at B's location", () => insertSale(a, randomUUID(), { sale_number: 2, location_id: b.loc }), /sale_business_id_location_id_fkey/],
      ["a sale on B's device", () => insertSale(a, randomUUID(), { sale_number: 3, device_id: b.device }), /sale_business_id_device_id_fkey/],
      ["a sale by B's member", () => insertSale(a, randomUUID(), { sale_number: 4, created_by_membership_id: b.member }), /sale_business_id_created_by_membership_id_fkey/],
      ["a void with B's approval", () => insertSale(a, randomUUID(), { sale_number: 5, ...voidFields(a), void_approval_id: approvalB }), /sale_business_id_void_approval_id_fkey/],
      ["a void approved by B's member", () => insertSale(a, randomUUID(), { sale_number: 6, ...voidFields(a), void_approved_by_membership_id: b.member }), /sale_business_id_void_approved_by_membership_id_fkey/],
      ["an item of B's pack type", () => insertItem(a, saleA, { pack_type_id: b.piece }), /sale_item_business_id_pack_type_id_fkey/],
      ["an item of B's sale", () => insertItem(a, saleB), /sale_item_business_id_sale_id_fkey/],
      ["a payment of B's sale", () => insertPayment(a, saleB), /payment_business_id_sale_id_fkey/],
      ["a payment by B's member", () => insertPayment(a, saleA, { created_by_membership_id: b.member }), /payment_business_id_created_by_membership_id_fkey/],
      ["a movement of B's sale", () => insertMovement(a, { sale_id: saleB }), /stock_movement_business_id_sale_id_fkey/],
    ];
    for (const [label, attempt, constraint] of cases) {
      const r = await attempt();
      expect(r, label).toMatch(fk);
      expect(r, label).toMatch(constraint);
    }
    // A payment marked duplicate of B's payment.
    expect(await insertPayment(b, saleB, { method: 'MPESA', mpesa_code: 'BBB12345' })).toBe('ok 1');
    const bPayment = await asAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM payment WHERE business_id = $1', [b.biz])).rows[0].id);
    expect(await insertPayment(a, saleA, { method: 'MPESA', mpesa_code: 'BBB12345', duplicate_of_payment_id: bPayment })).toMatch(/payment_business_id_duplicate_of_payment_id_fkey/);
    // And A's own rows read nothing of B (RLS).
    expect(await asApp(a.biz, 'SELECT 1 FROM sale')).toBe('ok 1');
  });

  // ---------------------------------------------------------------- 4. the M-Pesa code index
  it('4. one original payment per M-Pesa code per business; duplicates and other businesses are fine', async () => {
    const a = await world('Shop A');
    const b = await world('Shop B');
    const saleA = randomUUID();
    const saleB = randomUUID();
    expect(await insertSale(a, saleA)).toBe('ok 1');
    expect(await insertSale(b, saleB)).toBe('ok 1');
    const code = 'QWE123RTY9';
    expect(await insertPayment(a, saleA, { method: 'MPESA', mpesa_code: code })).toBe('ok 1');
    expect(await insertPayment(a, saleA, { method: 'MPESA', mpesa_code: code })).toMatch(/payment_mpesa_code_unique/);
    const first = await asAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM payment WHERE business_id = $1', [a.biz])).rows[0].id);
    expect(await insertPayment(a, saleA, { method: 'MPESA', mpesa_code: code, duplicate_of_payment_id: first })).toBe('ok 1');
    expect(await insertPayment(a, saleA, { method: 'MPESA', mpesa_code: code, duplicate_of_payment_id: first })).toBe('ok 1');
    expect(await insertPayment(b, saleB, { method: 'MPESA', mpesa_code: code })).toBe('ok 1');
    // Reversed payments keep their code: a reversed original still blocks a new original.
    expect(await asApp(a.biz, "UPDATE payment SET status = 'REVERSED' WHERE id = $1", [first])).toBe('ok 1');
    expect(await insertPayment(a, saleA, { method: 'MPESA', mpesa_code: code })).toMatch(/payment_mpesa_code_unique/);
    // A payment cannot be a duplicate of itself.
    const self = randomUUID();
    expect(await insertPayment(a, saleA, { id: self, method: 'MPESA', mpesa_code: 'ZZZ12345', duplicate_of_payment_id: self })).toMatch(/payment_not_duplicate_of_itself/);
  });

  // ---------------------------------------------------------------- 5. triggers
  it('5. inserts and updates of sale, sale_item and payment are logged in change_log; a rolled-back change is not', async () => {
    const w = await world();
    const log = () =>
      asAdmin(
        async (c) =>
          (await c.query<{ table_name: string; operation: string; row_id: string }>(
            "SELECT table_name, operation, row_id FROM change_log WHERE business_id = $1 AND table_name IN ('sale', 'sale_item', 'payment') ORDER BY id",
            [w.biz],
          )).rows,
      );
    const sale = randomUUID();
    expect(await insertSale(w, sale)).toBe('ok 1');
    expect(await insertItem(w, sale)).toBe('ok 1');
    expect(await insertPayment(w, sale)).toBe('ok 1');
    expect(await asApp(w.biz, 'UPDATE sale SET paid_total = 10, balance_due = 90')).toBe('ok 1');
    expect(await asApp(w.biz, "UPDATE payment SET status = 'REVERSED'")).toBe('ok 1');
    const ids = await asAdmin(async (c) => ({
      item: (await c.query<{ id: string }>('SELECT id FROM sale_item WHERE sale_id = $1', [sale])).rows[0].id,
      payment: (await c.query<{ id: string }>('SELECT id FROM payment WHERE sale_id = $1', [sale])).rows[0].id,
    }));
    expect(await log()).toEqual([
      { table_name: 'sale', operation: 'INSERT', row_id: sale },
      { table_name: 'sale_item', operation: 'INSERT', row_id: ids.item },
      { table_name: 'payment', operation: 'INSERT', row_id: ids.payment },
      { table_name: 'sale', operation: 'UPDATE', row_id: sale },
      { table_name: 'payment', operation: 'UPDATE', row_id: ids.payment },
    ]);
    // A rolled-back insert writes nothing.
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [w.biz]);
      await c.query(
        "INSERT INTO sale (id, business_id, sale_number, local_ref, location_id, device_id, created_by_membership_id, occurred_at, received_at, status, total, balance_due) VALUES ($1, $2, 2, 'R', $3, $4, $5, now(), now(), 'COMPLETED', 0, 0)",
        [randomUUID(), w.biz, w.loc, w.device, w.member],
      );
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect(await log()).toHaveLength(5);
  });

  // ---------------------------------------------------------------- 6. a voided sale is final
  it('6. a VOIDED sale cannot be updated again: no second void, no un-void, no payment change', async () => {
    const w = await world();
    const sale = randomUUID();
    expect(await insertSale(w, sale)).toBe('ok 1');
    const voidSql = "UPDATE sale SET status = 'VOIDED', voided_at = now(), voided_by_membership_id = $2, void_reason = $3, void_approved_by_membership_id = $2 WHERE id = $1";
    expect(await asApp(w.biz, `${voidSql} AND status = 'COMPLETED'`, [sale, w.member, 'MISTAKE'])).toBe('ok 1');
    const before = await asAdmin(async (c) => (await c.query('SELECT * FROM sale WHERE id = $1', [sale])).rows[0]);
    expect(await asApp(w.biz, voidSql, [sale, w.member, 'OTHER'])).toBe('ok 0');
    expect(await asApp(w.biz, "UPDATE sale SET status = 'COMPLETED', voided_at = NULL, voided_by_membership_id = NULL, void_reason = NULL, void_approved_by_membership_id = NULL WHERE id = $1", [sale])).toBe('ok 0');
    expect(await asApp(w.biz, 'UPDATE sale SET paid_total = 100, balance_due = 0 WHERE id = $1', [sale])).toBe('ok 0');
    expect(await asAdmin(async (c) => (await c.query('SELECT * FROM sale WHERE id = $1', [sale])).rows[0])).toEqual(before);
    expect(before).toMatchObject({ status: 'VOIDED', void_reason: 'MISTAKE' });
    // A completed sale of the same business still updates.
    const other = randomUUID();
    expect(await insertSale(w, other, { sale_number: 2 })).toBe('ok 1');
    expect(await asApp(w.biz, 'UPDATE sale SET paid_total = 100, balance_due = 0 WHERE id = $1', [other])).toBe('ok 1');
  });
});
