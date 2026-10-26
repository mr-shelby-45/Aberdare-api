import { randomUUID } from 'node:crypto';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { ApprovalsRepository } from '../src/modules/approvals/approvals.repository.js';
import { LocationsService } from '../src/modules/locations/locations.service.js';
import { ProductsService } from '../src/modules/products/products.service.js';
import { StockIntegrityService } from '../src/modules/stock/stock-integrity.service.js';
import { type MovementContext, StockRepository } from '../src/modules/stock/stock.repository.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';
import { type Shop, seedShop } from './helpers/shop.js';

// Phase C1: schema, triggers, integrity check, housekeeping
// (docs/phase-c-design.md sections 3 and 9). Numbers in test names refer to
// the C1 list in section 13. Test 1 (the inventories) lives in
// test/step4-migrations.spec.ts and test/b5-hardening.spec.ts; test 8 is the
// earlier suites, run unchanged apart from mechanical updates.

const AT = new Date('2026-10-26T08:00:00.000Z');

describe('C1: stock schema, triggers and integrity', { timeout: 120_000 }, () => {
  let t: TestApp;
  const repo = new StockRepository();
  const stock = new StockService(repo);
  const integrity = new StockIntegrityService(repo);
  const approvals = new ApprovalsRepository();

  beforeAll(async () => {
    t = await startTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tenants = () => t.app.get(TenantRunner, { strict: false });
  const ctx = (s: Shop): MovementContext => ({ occurredAt: AT, createdByMembershipId: s.member, syncCommandId: null });

  /** A movement written directly, as app_user in the tenant transaction (bypassing the service on purpose). */
  const movement = (s: Shop, fields: Record<string, unknown>) =>
    tenants().run(s.biz, () =>
      currentTx().stockMovement.create({
        data: {
          businessId: s.biz,
          locationId: s.loc,
          packTypeId: s.piece,
          quantityChange: 1,
          movementType: 'RECEIVE',
          quantityAfter: 1,
          occurredAt: AT,
          ...fields,
        } as never, // test-only: deliberately invalid combinations
        select: { id: true },
      }),
    );

  const syncCommand = (s: Shop) =>
    tenants().run(s.biz, async () => {
      const rows = await currentTx().$queryRaw<{ id: string }[]>`
        INSERT INTO sync_command (business_id, command_id, type, status, result, occurred_at, received_at)
        VALUES (${s.biz}::uuid, ${randomUUID()}::uuid, 'stock.convert', 'ACCEPTED', '{}'::jsonb, ${AT}::timestamptz, ${AT}::timestamptz)
        RETURNING id`;
      return rows[0].id;
    });

  const device = (s: Shop) =>
    tenants().run(s.biz, async () =>
      (
        await currentTx().device.create({
          data: { businessId: s.biz, name: 'Till', platform: 'android', secretHash: 'x'.repeat(64), status: 'ACTIVE', registeredByMembershipId: s.member },
          select: { id: true },
        })
      ).id,
    );

  // ---------------------------------------------------------------- 2. checks
  it('2. the database refuses movements that break the ledger rules, and the ledger stays append-only', async () => {
    const s = await seedShop(tenants());
    // Each valid kind is accepted.
    await movement(s, { quantityChange: 5, movementType: 'RECEIVE', unitCost: '12.50', reference: 'INV-1', note: 'n'.repeat(200) });
    await movement(s, { quantityChange: -1, movementType: 'ADJUST', reason: 'DAMAGED' });
    await movement(s, { quantityChange: 2, movementType: 'ADJUST', reason: 'FOUND' });
    await movement(s, { quantityChange: -3, movementType: 'ADJUST', reason: 'CORRECTION' });
    await movement(s, { quantityChange: 3, movementType: 'ADJUST', reason: 'OTHER' });
    await movement(s, { quantityChange: -2, movementType: 'COUNT', expectedQuantity: 6, countedQuantity: 4 });
    await movement(s, { quantityChange: 3, movementType: 'COUNT', expectedQuantity: -3, countedQuantity: 0 });
    await movement(s, { packTypeId: s.carton, quantityChange: -1, movementType: 'CONVERT_OUT' });
    await movement(s, { quantityChange: 24, movementType: 'CONVERT_IN' });
    await movement(s, { quantityChange: -4, movementType: 'SALE' });

    const refused: [string, Record<string, unknown>, RegExp][] = [
      ['unknown type', { movementType: 'TELEPORT' }, /stock_movement_type_known/],
      ['negative RECEIVE', { quantityChange: -1 }, /stock_movement_type_sign/],
      ['negative CONVERT_IN', { quantityChange: -1, movementType: 'CONVERT_IN' }, /stock_movement_type_sign/],
      ['positive CONVERT_OUT', { quantityChange: 1, movementType: 'CONVERT_OUT' }, /stock_movement_type_sign/],
      ['positive DAMAGED', { quantityChange: 1, movementType: 'ADJUST', reason: 'DAMAGED' }, /stock_movement_reason_sign/],
      ['positive EXPIRED', { quantityChange: 1, movementType: 'ADJUST', reason: 'EXPIRED' }, /stock_movement_reason_sign/],
      ['positive LOST', { quantityChange: 1, movementType: 'ADJUST', reason: 'LOST' }, /stock_movement_reason_sign/],
      ['positive SUPPLIER_RETURN', { quantityChange: 1, movementType: 'ADJUST', reason: 'SUPPLIER_RETURN' }, /stock_movement_reason_sign/],
      ['negative FOUND', { quantityChange: -1, movementType: 'ADJUST', reason: 'FOUND' }, /stock_movement_reason_sign/],
      ['unknown reason', { quantityChange: -1, movementType: 'ADJUST', reason: 'STOLEN' }, /stock_movement_reason_known/],
      ['ADJUST without reason', { quantityChange: -1, movementType: 'ADJUST' }, /stock_movement_reason_on_adjust/],
      ['reason on RECEIVE', { reason: 'FOUND' }, /stock_movement_reason_on_adjust/],
      ['unit_cost on CONVERT_IN', { movementType: 'CONVERT_IN', unitCost: '1.00' }, /stock_movement_unit_cost_on_receive/],
      ['unit_cost on ADJUST', { movementType: 'ADJUST', reason: 'FOUND', unitCost: '1.00' }, /stock_movement_unit_cost_on_receive/],
      ['negative unit_cost', { unitCost: '-0.01' }, /stock_movement_unit_cost_on_receive/],
      ['COUNT without quantities', { quantityChange: -2, movementType: 'COUNT' }, /stock_movement_count_quantities/],
      ['COUNT without counted', { quantityChange: -2, movementType: 'COUNT', expectedQuantity: 6 }, /stock_movement_count_quantities/],
      ['COUNT with the wrong delta', { quantityChange: -3, movementType: 'COUNT', expectedQuantity: 6, countedQuantity: 4 }, /stock_movement_count_quantities/],
      ['COUNT with a negative count', { quantityChange: -7, movementType: 'COUNT', expectedQuantity: 6, countedQuantity: -1 }, /stock_movement_count_quantities/],
      ['expected on RECEIVE', { expectedQuantity: 1, countedQuantity: 2 }, /stock_movement_count_quantities/],
      ['zero change', { quantityChange: 0 }, /stock_movement_quantity_change_nonzero/],
      ['note over 200', { note: 'n'.repeat(201) }, /stock_movement_note_length/],
      ['reference over 60', { reference: 'r'.repeat(61) }, /stock_movement_reference_length/],
    ];
    for (const [label, fields, constraint] of refused) {
      await expect(movement(s, fields), label).rejects.toThrow(constraint);
    }
    expect(await tenants().run(s.biz, () => currentTx().stockMovement.count())).toBe(10);

    // app_user can never change or remove a movement.
    await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [s.biz]);
      for (const sql of ["UPDATE stock_movement SET note = 'x'", 'DELETE FROM stock_movement']) {
        await c.query('SAVEPOINT p');
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied for table stock_movement/);
        await c.query('ROLLBACK TO SAVEPOINT p');
      }
      await c.query('ROLLBACK');
    });
  });

  // ---------------------------------------------------------------- 3. composite keys
  it("3. a movement's creator and command, a conversion's approver and an approval's members must be in the same business", async () => {
    const a = await seedShop(tenants(), 'Shop A');
    const b = await seedShop(tenants(), 'Shop B');
    const bCommand = await syncCommand(b);
    const aDevice = await device(a);

    await expect(movement(a, { createdByMembershipId: b.member })).rejects.toThrow(/stock_movement_business_id_created_by_membership_id_fkey/);
    await expect(movement(a, { syncCommandId: bCommand })).rejects.toThrow(/stock_movement_business_id_sync_command_id_fkey/);
    // The same with A's own member and command works.
    await movement(a, { createdByMembershipId: a.member, syncCommandId: await syncCommand(a) });

    // A conversion approved by B's member.
    const out = await movement(a, { packTypeId: a.carton, quantityChange: -1, movementType: 'CONVERT_OUT' });
    const into = await movement(a, { quantityChange: 24, movementType: 'CONVERT_IN' });
    await expect(
      tenants().run(a.biz, () =>
        currentTx().stockConversion.create({
          data: { businessId: a.biz, outMovementId: out.id, inMovementId: into.id, createdByMembershipId: a.member, approvedByMembershipId: b.member },
        }),
      ),
    ).rejects.toThrow(/stock_conversion_business_id_approved_by_membership_id_fkey/);

    // An approval naming B's member as requester or approver, or B's command as consumer.
    const approval = (fields: Record<string, unknown>) =>
      tenants().run(a.biz, () =>
        currentTx().approval.create({
          data: {
            businessId: a.biz,
            purpose: 'STOCK_CONVERT',
            requesterMembershipId: a.member,
            approverMembershipId: a.member,
            deviceId: aDevice,
            createdAt: AT,
            validUntil: new Date(AT.getTime() + 15 * 60_000),
            ...fields,
          } as never,
          select: { id: true },
        }),
      );
    await expect(approval({ requesterMembershipId: b.member })).rejects.toThrow(/approval_business_id_requester_membership_id_fkey/);
    await expect(approval({ approverMembershipId: b.member })).rejects.toThrow(/approval_business_id_approver_membership_id_fkey/);
    await expect(approval({ consumedAt: AT, consumedBySyncCommandId: bCommand })).rejects.toThrow(/approval_business_id_consumed_by_sync_command_id_fkey/);
    // An unknown purpose (SALE_VOID is a known one since E1).
    await expect(approval({ purpose: 'REFUND' })).rejects.toThrow(/approval_purpose_known/);
    await expect(approval({ validUntil: AT })).rejects.toThrow(/approval_valid_after_created/);
    await expect(approval({ consumedAt: AT })).rejects.toThrow(/approval_consumed_together/);
    await approval({});
  });

  // ---------------------------------------------------------------- 4. balance trigger
  it('4. the stock_balance trigger logs inserts and updates, through the strict update and the sale-mode upsert; a rollback logs nothing', async () => {
    const s = await seedShop(tenants());
    const balanceLog = () =>
      asAdmin(
        async (c) =>
          (
            await c.query<{ operation: string; row_id: string }>(
              "SELECT operation, row_id FROM change_log WHERE business_id = $1 AND table_name = 'stock_balance' ORDER BY id",
              [s.biz],
            )
          ).rows,
      );
    await tenants().run(s.biz, () => stock.receive(s.loc, s.piece, 10, ctx(s))); // upsert: INSERT
    await tenants().run(s.biz, () => stock.receive(s.loc, s.piece, 5, ctx(s))); // upsert: UPDATE
    await tenants().run(s.biz, () => stock.decreaseStrict(s.loc, s.piece, 3, ctx(s))); // strict UPDATE
    await tenants().run(s.biz, () => stock.decreaseForSale(s.loc, s.piece, 20, ctx(s))); // sale-mode upsert, below zero
    const balanceId = await asAdmin(
      async (c) => (await c.query<{ id: string }>('SELECT id FROM stock_balance WHERE business_id = $1', [s.biz])).rows[0].id,
    );
    expect(await balanceLog()).toEqual([
      { operation: 'INSERT', row_id: balanceId },
      { operation: 'UPDATE', row_id: balanceId },
      { operation: 'UPDATE', row_id: balanceId },
      { operation: 'UPDATE', row_id: balanceId },
    ]);
    // The balance went negative (sale mode): there is no quantity check.
    expect(await tenants().run(s.biz, () => repo.balanceOf(s.loc, s.piece))).toBe(-8);

    // A rolled-back change writes no change_log row.
    await expect(
      tenants().run(s.biz, async () => {
        await stock.receive(s.loc, s.piece, 1, ctx(s));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await balanceLog()).toHaveLength(4);

    // Every movement carries its type, quantity after, time and creator.
    const rows = await asAdmin(
      async (c) =>
        (
          await c.query<{ movement_type: string; quantity_change: number; quantity_after: number; created_by_membership_id: string; occurred_at: Date }>(
            'SELECT movement_type, quantity_change, quantity_after, created_by_membership_id, occurred_at FROM stock_movement WHERE business_id = $1 ORDER BY created_at, id',
            [s.biz],
          )
        ).rows,
    );
    expect(rows.map((r) => [r.movement_type, r.quantity_change, r.quantity_after])).toEqual([
      ['RECEIVE', 10, 10],
      ['RECEIVE', 5, 15],
      ['ADJUST', -3, 12],
      ['SALE', -20, -8],
    ]);
    for (const r of rows) {
      expect(r.created_by_membership_id).toBe(s.member);
      expect(r.occurred_at.toISOString()).toBe(AT.toISOString());
    }
  });

  // ---------------------------------------------------------------- 5. integrity check
  it('5. the integrity check: consistent data is clean; changed, orphan and missing balances are each reported; never another business', async () => {
    const a = await seedShop(tenants(), 'Shop A');
    const b = await seedShop(tenants(), 'Shop B');
    for (const s of [a, b]) {
      await tenants().run(s.biz, () => stock.receive(s.loc, s.piece, 10, ctx(s)));
      await tenants().run(s.biz, () => stock.receive(s.loc, s.carton, 2, ctx(s)));
      await tenants().run(s.biz, () => stock.convert(s.loc, s.carton, s.piece, 1, ctx(s)));
    }
    expect(await tenants().run(a.biz, () => integrity.check())).toEqual([]);
    expect(await tenants().run(b.biz, () => integrity.check())).toEqual([]);

    // Break B three ways, as the superuser (nothing in the API can do this).
    const bSecondLocation = await tenants().run(b.biz, async () =>
      (await currentTx().location.create({ data: { businessId: b.biz, name: 'Store' }, select: { id: true } })).id,
    );
    await asAdmin(async (c) => {
      await c.query('UPDATE stock_balance SET quantity = quantity + 1 WHERE business_id = $1 AND pack_type_id = $2', [b.biz, b.piece]);
      // A balance with no movements.
      await c.query(
        'INSERT INTO stock_balance (business_id, location_id, pack_type_id, quantity, updated_at) VALUES ($1, $2, $3, 0, now())',
        [b.biz, bSecondLocation, b.carton],
      );
      // Movements with no balance.
      await c.query(
        `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at)
         VALUES ($1, $2, $3, 4, 'RECEIVE', 4, now())`,
        [b.biz, bSecondLocation, b.piece],
      );
    });
    const found = await tenants().run(b.biz, () => integrity.check());
    const expected = [
      { locationId: b.loc, packTypeId: b.piece, balance: 35, ledgerSum: 34 },
      { locationId: bSecondLocation, packTypeId: b.carton, balance: 0, ledgerSum: null },
      { locationId: bSecondLocation, packTypeId: b.piece, balance: null, ledgerSum: 4 },
    ];
    expect([...found].sort((x, y) => `${x.locationId}${x.packTypeId}`.localeCompare(`${y.locationId}${y.packTypeId}`))).toEqual(
      [...expected].sort((x, y) => `${x.locationId}${x.packTypeId}`.localeCompare(`${y.locationId}${y.packTypeId}`)),
    );
    // A is untouched, and B's problems never show up in A's check.
    expect(await tenants().run(a.biz, () => integrity.check())).toEqual([]);
    // Outside a tenant transaction there is nothing to check.
    await expect(integrity.check()).rejects.toThrow(/TENANT_CONTEXT_MISSING|tenant/i);
  });

  // ---------------------------------------------------------------- 6. approval consumption
  it('6. 20 concurrent consumes of one approval give exactly one row', async () => {
    const s = await seedShop(tenants());
    const till = await device(s);
    const approvalId = await tenants().run(s.biz, async () =>
      (
        await currentTx().approval.create({
          data: {
            businessId: s.biz,
            purpose: 'STOCK_CONVERT',
            requesterMembershipId: s.member,
            approverMembershipId: s.member,
            deviceId: till,
            createdAt: AT,
            validUntil: new Date(AT.getTime() + 15 * 60_000),
          },
          select: { id: true },
        })
      ).id,
    );
    const commands: string[] = [];
    for (let i = 0; i < 20; i++) commands.push(await syncCommand(s));
    const results = await Promise.all(
      commands.map((cmd) =>
        tenants().run(s.biz, () =>
          approvals.consume({
            approvalId,
            purpose: 'STOCK_CONVERT',
            requesterMembershipId: s.member,
            deviceId: till,
            syncCommandId: cmd,
            occurredAt: new Date(AT.getTime() + 60_000),
            receivedAt: new Date(AT.getTime() + 120_000),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r === s.member)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(19);
    const winner = commands[results.findIndex((r) => r !== null)];
    const row = await asAdmin(
      async (c) =>
        (await c.query<{ consumed_by_sync_command_id: string }>('SELECT consumed_by_sync_command_id FROM approval WHERE id = $1', [approvalId])).rows[0],
    );
    expect(row.consumed_by_sync_command_id).toBe(winner);
  });

  it('6. the consumption checks purpose, requester, device and time; app_user cannot change any other approval column', async () => {
    const s = await seedShop(tenants());
    const till = await device(s);
    const otherTill = await device(s);
    const mint = () =>
      tenants().run(s.biz, async () =>
        (
          await currentTx().approval.create({
            data: { businessId: s.biz, purpose: 'STOCK_CONVERT', requesterMembershipId: s.member, approverMembershipId: s.member, deviceId: till, createdAt: AT, validUntil: new Date(AT.getTime() + 15 * 60_000) },
            select: { id: true },
          })
        ).id,
      );
    const consume = async (approvalId: string, change: Partial<Parameters<ApprovalsRepository['consume']>[0]> = {}) => {
      const cmd = await syncCommand(s);
      return tenants().run(s.biz, () =>
        approvals.consume({
          approvalId,
          purpose: 'STOCK_CONVERT',
          requesterMembershipId: s.member,
          deviceId: till,
          syncCommandId: cmd,
          occurredAt: new Date(AT.getTime() + 60_000),
          receivedAt: new Date(AT.getTime() + 120_000),
          ...change,
        }),
      );
    };
    const minute = 60_000;
    const id = await mint();
    expect(await consume(id, { requesterMembershipId: randomUUID() })).toBeNull();
    expect(await consume(id, { deviceId: otherTill })).toBeNull();
    expect(await consume(id, { occurredAt: new Date(AT.getTime() + 16 * minute) })).toBeNull(); // after valid_until
    expect(await consume(id, { occurredAt: new Date(AT.getTime() - 6 * minute) })).toBeNull(); // too long before creation
    expect(await consume(id, { receivedAt: new Date(AT.getTime() + 25 * 60 * minute) })).toBeNull(); // received after 24 h
    expect(await consume(randomUUID())).toBeNull(); // no such approval
    // Still unused after all those: the right use works once, then never again.
    expect(await consume(id, { occurredAt: new Date(AT.getTime() - 4 * minute) })).toBe(s.member);
    expect(await consume(id)).toBeNull();

    await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [s.biz]);
      for (const sql of [
        "UPDATE approval SET valid_until = valid_until + interval '1 day'",
        'UPDATE approval SET approver_membership_id = requester_membership_id',
        "UPDATE approval SET purpose = 'STOCK_CONVERT'",
        'DELETE FROM approval',
      ]) {
        await c.query('SAVEPOINT p');
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied for table approval/);
        await c.query('ROLLBACK TO SAVEPOINT p');
      }
      await c.query('ROLLBACK');
    });
  });

  // ---------------------------------------------------------------- 7. errorCode in logs
  it('7. a failing database write logs its errorCode; a one-time code still never appears in any log line', async () => {
    const sms = t.app.get(SmsSender) as FakeSmsSender;
    const mail = t.app.get(EmailSender) as FakeEmailSender;
    const post = (url: string, payload: unknown, token?: string) =>
      t.app.inject({ method: 'POST', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.110' });
    const phone = '+254711000101';
    const email = 'c1owner@example.com';
    expect((await post('/v1/auth/signup/start', { phone, email })).statusCode).toBe(202);
    const smsCode = sms.outbox.find((m) => m.to === phone)!.message.match(/\d{6}/)![0];
    const emailCode = mail.outbox.find((m) => m.to === email)!.message.match(/\d{6}/)![0];
    // A wrong attempt first, then the right one: both carry one-time codes.
    await post('/v1/auth/signup/verify', { phone, email, phone_code: '000000', email_code: '000000' });
    const verified = await post('/v1/auth/signup/verify', { phone, email, phone_code: smsCode, email_code: emailCode });
    const signup = await post('/v1/auth/signup', {
      signup_token: (verified.json() as { signup_token: string }).signup_token,
      owner_name: 'Amina',
      business_name: 'Duka C',
      business_type: 'RETAIL',
      password: 'baobab-sunrise-73',
      pin: '9384',
      device: { name: 'p', platform: 'android' },
    });
    expect(signup.statusCode).toBe(201);
    const { access_token: token, membership } = signup.json() as { access_token: string; membership: { business_id: string } };
    const firstLine = t.logs.length;

    // A 500: the location write runs a statement that breaks a check (23514).
    vi.spyOn(t.app.get(LocationsService, { strict: false }), 'create').mockImplementationOnce(async () => {
      await currentTx().$executeRaw`INSERT INTO product (business_id, name, updated_at) VALUES (${membership.business_id}::uuid, '', now())`;
      throw new Error('unreachable');
    });
    expect((await post('/v1/locations', { name: 'Store' }, token)).statusCode).toBe(500);

    // A FAILED sync command with the same database error.
    vi.spyOn(t.app.get(ProductsService, { strict: false }), 'createProduct').mockImplementationOnce(async () => {
      await currentTx().$executeRaw`INSERT INTO product (business_id, name, updated_at) VALUES (${membership.business_id}::uuid, '', now())`;
    });
    const res = await post(
      '/v1/sync/commands',
      {
        commands: [
          {
            command_id: randomUUID(),
            type: 'product.create',
            occurred_at: t.clock.now().toISOString(),
            payload: { product_id: randomUUID(), name: 'x', pack_types: [{ pack_type_id: randomUUID(), name: 'piece', units_per_pack: 1, sell_price: '1' }] },
          },
        ],
      },
      token,
    );
    expect((res.json() as { results: { status: string }[] }).results[0].status).toBe('FAILED');

    const mine = t.logs.slice(firstLine);
    const unhandled = mine.find((l) => l.msg === 'unhandled error') as { error?: { errorCode?: string; name?: string } } | undefined;
    expect(unhandled?.error).toMatchObject({ errorCode: '23514' });
    const failed = mine.find((l) => l.msg === 'sync command failed');
    expect(failed).toMatchObject({ commandType: 'product.create', errorCode: '23514' });

    // The redaction of "code" stays: no one-time code appears anywhere.
    const raw = t.rawLogs();
    for (const code of [smsCode, emailCode]) {
      expect(new RegExp(`["=:\\s]${code}["\\s,}]`).test(raw), 'a one-time code appears in the logs').toBe(false);
    }
  });
});
