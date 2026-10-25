import { randomUUID } from 'node:crypto';
import { Clock } from '../src/common/time/clock.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { AdjustStockHandler } from '../src/modules/stock/commands/adjust-stock.handler.js';
import { ReceiveStockHandler } from '../src/modules/stock/commands/receive-stock.handler.js';
import { StockError } from '../src/modules/stock/stock.error.js';
import { StockRepository } from '../src/modules/stock/stock.repository.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import type { SyncActor } from '../src/modules/sync/command-outcome.js';
import { SyncRepository } from '../src/modules/sync/sync.repository.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { resetTables } from './helpers/db.js';
import { prismaWithPool } from './helpers/prisma.js';
import { type Shop, seedShop } from './helpers/shop.js';

// Spike step 3: idempotent commands (docs/spike.md).
// Numbered tests match the numbered list in the spike document.

describe('step 3: idempotent commands', () => {
  const stockRepo = new StockRepository();
  const stock = new StockService(stockRepo);
  let prisma: PrismaService;
  let tenants: TenantRunner;
  let sync: SyncService;
  let shop: Shop;

  /** A manager: may receive and adjust stock. */
  const manager = (s: Shop): SyncActor => ({
    businessId: s.biz,
    membershipId: MEMBER,
    permissions: new Set(['stock.receive', 'stock.adjust']),
  });

  // The acting membership; the stock handlers do not use it.
  const MEMBER = randomUUID();

  // Any valid ISO time; the spike tests do not depend on it.
  const OCCURRED = '2026-10-24T08:00:00.000Z';

  const receive = (s: Shop, quantity: number, commandId = randomUUID()) => ({
    command_id: commandId,
    occurred_at: OCCURRED,
    type: 'stock.receive',
    payload: { locationId: s.loc, packTypeId: s.piece, quantity },
  });

  const adjust = (s: Shop, quantity: number, commandId = randomUUID()) => ({
    command_id: commandId,
    occurred_at: OCCURRED,
    type: 'stock.adjust',
    payload: { locationId: s.loc, packTypeId: s.piece, quantity },
  });

  /** Stock and command rows as the tenant sees them. */
  async function state(s: Shop) {
    return tenants.run(s.biz, async () => ({
      balance: await stockRepo.balanceOf(s.loc, s.piece),
      sum: await stockRepo.movementSum(s.loc, s.piece),
      movements: await currentTx().stockMovement.count(),
      commands: await currentTx().syncCommand.count(),
    }));
  }

  beforeAll(async () => {
    prisma = prismaWithPool(10);
    await prisma.$connect();
    tenants = new TenantRunner(prisma);
    sync = new SyncService(
      tenants,
      new SyncRepository(),
      new Clock(),
      // The endpoint's own list is the catalogue handlers; the spike tests the stock ones.
      { all: [new ReceiveStockHandler(stock), new AdjustStockHandler(stock)] },
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTables();
    shop = await seedShop(tenants);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. the same command twice in sequence is processed once; the second gets the stored result', async () => {
    const cmd = receive(shop, 5);
    const [first] = await sync.processCommands(manager(shop), [cmd]);
    const [second] = await sync.processCommands(manager(shop), [cmd]);

    expect(first).toEqual({
      commandId: cmd.command_id,
      status: 'ACCEPTED',
      data: { quantity: 5 },
    });
    expect(second).toEqual(first);
    expect(await state(shop)).toEqual({ balance: 5, sum: 5, movements: 1, commands: 1 });
  });

  it('2. the same command 20 times concurrently is processed exactly once; all callers get the same result', async () => {
    const cmd = receive(shop, 5);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        sync.processCommands(manager(shop), [cmd]),
      ),
    );

    const flat = results.map(([r]) => r);
    expect(flat).toHaveLength(20);
    for (const r of flat) {
      expect(r).toEqual({
        commandId: cmd.command_id,
        status: 'ACCEPTED',
        data: { quantity: 5 },
      });
    }
    expect(await state(shop)).toEqual({ balance: 5, sum: 5, movements: 1, commands: 1 });
  });

  it('3. a batch of 5 where command 3 is invalid: 1, 2, 4, 5 accepted, 3 rejected with a reason code', async () => {
    const batch = [
      receive(shop, 1),
      receive(shop, 2),
      receive(shop, 0), // invalid: quantity must be at least 1
      receive(shop, 4),
      receive(shop, 5),
    ];
    const results = await sync.processCommands(manager(shop), batch);

    expect(results.map((r) => [r.commandId, r.status, r.code])).toEqual([
      [batch[0].command_id, 'ACCEPTED', undefined],
      [batch[1].command_id, 'ACCEPTED', undefined],
      [batch[2].command_id, 'REJECTED', 'VALIDATION_FAILED'],
      [batch[3].command_id, 'ACCEPTED', undefined],
      [batch[4].command_id, 'ACCEPTED', undefined],
    ]);
    // 1 + 2 + 4 + 5; the rejection is stored too.
    expect(await state(shop)).toEqual({ balance: 12, sum: 12, movements: 4, commands: 5 });
  });

  it('4. a batch where one command lacks permission: that one is rejected, the others proceed', async () => {
    await sync.processCommands(manager(shop), [receive(shop, 10)]);
    // An actor who may receive stock but not adjust it.
    const receiver: SyncActor = {
      businessId: shop.biz,
      membershipId: MEMBER,
      permissions: new Set(['stock.receive']),
    };
    const batch = [receive(shop, 1), adjust(shop, 3), receive(shop, 2)];
    const results = await sync.processCommands(receiver, batch);

    expect(results.map((r) => [r.status, r.code])).toEqual([
      ['ACCEPTED', undefined],
      ['REJECTED', 'PERMISSION_DENIED'],
      ['ACCEPTED', undefined],
    ]);
    expect(await state(shop)).toEqual({ balance: 13, sum: 13, movements: 3, commands: 4 });
  });

  it('5. re-sending a rejected command returns the same rejection, even when it would now succeed', async () => {
    await sync.processCommands(manager(shop), [receive(shop, 10)]);
    const noAdjust: SyncActor = {
      businessId: shop.biz,
      membershipId: MEMBER,
      permissions: new Set(['stock.receive']),
    };
    const cmd = adjust(shop, 3);

    const [first] = await sync.processCommands(noAdjust, [cmd]);
    expect(first).toMatchObject({ status: 'REJECTED', code: 'PERMISSION_DENIED' });

    // Same command again, now from someone who does have the permission.
    const [second] = await sync.processCommands(manager(shop), [cmd]);
    expect(second).toEqual(first);

    // A business-rule rejection is just as final.
    const tooMuch = adjust(shop, 999);
    const [r1] = await sync.processCommands(manager(shop), [tooMuch]);
    await sync.processCommands(manager(shop), [receive(shop, 2000)]);
    const [r2] = await sync.processCommands(manager(shop), [tooMuch]);
    expect(r1).toMatchObject({ status: 'REJECTED', code: 'STOCK_INSUFFICIENT' });
    expect(r2).toEqual(r1);

    expect(await state(shop)).toMatchObject({ balance: 2010, movements: 2 });
  });

  it("6. business A's command UUID used by business B is a different command", async () => {
    const shopB = await seedShop(tenants, 'Shop B');
    const shared = randomUUID();

    const [a] = await sync.processCommands(manager(shop), [receive(shop, 3, shared)]);
    const [b] = await sync.processCommands(manager(shopB), [receive(shopB, 7, shared)]);

    expect(a).toEqual({ commandId: shared, status: 'ACCEPTED', data: { quantity: 3 } });
    expect(b).toEqual({ commandId: shared, status: 'ACCEPTED', data: { quantity: 7 } });
    expect(await state(shop)).toEqual({ balance: 3, sum: 3, movements: 1, commands: 1 });
    expect(await state(shopB)).toEqual({ balance: 7, sum: 7, movements: 1, commands: 1 });
  });

  it('7. a crash after the command row is inserted rolls everything back, and the retry works', async () => {
    const cmd = receive(shop, 5);
    // Crash after the balance update, before the ledger row: deep inside the
    // handler, well after the command row was claimed.
    vi.spyOn(stockRepo, 'insertMovement').mockRejectedValueOnce(
      new Error('simulated server crash'),
    );

    const [crashed] = await sync.processCommands(manager(shop), [cmd]);
    expect(crashed).toEqual({
      commandId: cmd.command_id,
      status: 'FAILED',
      code: 'INTERNAL_ERROR',
      message: 'The command could not be processed. It will be retried.',
      // For the server log only (Phase B2); the controller never sends it.
      failure: { type: 'stock.receive', errorName: expect.any(String) },
    });
    // No command row saying "done", no stock change.
    expect(await state(shop)).toEqual({ balance: 0, sum: 0, movements: 0, commands: 0 });

    const [retried] = await sync.processCommands(manager(shop), [cmd]);
    expect(retried).toEqual({
      commandId: cmd.command_id,
      status: 'ACCEPTED',
      data: { quantity: 5 },
    });
    expect(await state(shop)).toEqual({ balance: 5, sum: 5, movements: 1, commands: 1 });
  });

  describe('supporting checks', () => {
    it('20 concurrent copies of a command that is rejected all get the same rejection', async () => {
      const cmd = adjust(shop, 1); // nothing in stock
      const results = await Promise.all(
        Array.from({ length: 20 }, () => sync.processCommands(manager(shop), [cmd])),
      );
      for (const [r] of results) {
        expect(r).toMatchObject({ status: 'REJECTED', code: 'STOCK_INSUFFICIENT' });
      }
      expect(await state(shop)).toEqual({ balance: 0, sum: 0, movements: 0, commands: 1 });
    });

    it('a rejection after the handler already wrote is undone by the savepoint, and the rejection is kept', async () => {
      // The balance update succeeds, then the handler fails with a business rule.
      vi.spyOn(stockRepo, 'insertMovement').mockRejectedValueOnce(
        new StockError('STOCK_QUANTITY_INVALID', 'rejected after a write'),
      );
      const [r] = await sync.processCommands(manager(shop), [receive(shop, 5)]);
      expect(r).toMatchObject({ status: 'REJECTED', code: 'STOCK_QUANTITY_INVALID' });
      expect(await state(shop)).toEqual({ balance: 0, sum: 0, movements: 0, commands: 1 });
    });

    it("a command pointing at another business's location is rejected as INVALID_REFERENCE, not retried forever", async () => {
      const shopB = await seedShop(tenants, 'Shop B');
      const [r] = await sync.processCommands(manager(shop), [
        { command_id: randomUUID(), occurred_at: OCCURRED, type: 'stock.receive', payload: { locationId: shopB.loc, packTypeId: shop.piece, quantity: 5 } },
      ]);
      expect(r).toMatchObject({ status: 'REJECTED', code: 'INVALID_REFERENCE' });
      expect(await state(shop)).toEqual({ balance: 0, sum: 0, movements: 0, commands: 1 });
      expect(await state(shopB)).toEqual({ balance: 0, sum: 0, movements: 0, commands: 0 });
    });

    it('envelopes and payloads are validated: bad ones are rejected, and only those with a valid UUID are stored', async () => {
      const valid = randomUUID();
      const results = await sync.processCommands(manager(shop), [
        null,
        'not an object',
        { command_id: 'not-a-uuid', occurred_at: OCCURRED, type: 'stock.receive', payload: {} },
        { command_id: randomUUID(), occurred_at: OCCURRED, type: 'stock.receive', payload: {}, extra: 1 },
        { command_id: randomUUID(), occurred_at: OCCURRED, type: 'stock.teleport', payload: {} },
        { command_id: valid, occurred_at: OCCURRED, type: 'stock.receive', payload: { locationId: shop.loc, packTypeId: shop.piece, quantity: '5' } },
        { command_id: randomUUID(), occurred_at: OCCURRED, type: 'stock.receive', payload: { locationId: shop.loc, packTypeId: shop.piece, quantity: 2.5 } },
        { command_id: randomUUID(), occurred_at: OCCURRED, type: 'stock.receive', payload: { locationId: shop.loc, packTypeId: shop.piece, quantity: 1, businessId: randomUUID() } },
      ]);
      expect(results.map((r) => [r.status, r.code])).toEqual([
        ['REJECTED', 'VALIDATION_FAILED'],
        ['REJECTED', 'VALIDATION_FAILED'],
        ['REJECTED', 'VALIDATION_FAILED'],
        ['REJECTED', 'VALIDATION_FAILED'],
        ['REJECTED', 'UNKNOWN_COMMAND_TYPE'],
        ['REJECTED', 'VALIDATION_FAILED'], // "5" is a string, not a number
        ['REJECTED', 'VALIDATION_FAILED'], // no fractional quantities
        ['REJECTED', 'VALIDATION_FAILED'], // business_id never comes from the phone
      ]);
      expect(results.slice(0, 4).every((r) => r.commandId === null)).toBe(true);
      // Stored: unknown type + the three payload failures.
      expect(await state(shop)).toEqual({ balance: 0, sum: 0, movements: 0, commands: 4 });
    });

    it('a stored outcome can never be rewritten or deleted by app_user', async () => {
      const cmd = adjust(shop, 1);
      await sync.processCommands(manager(shop), [cmd]); // REJECTED, stored
      const changed = await tenants.run(shop.biz, () =>
        currentTx().$executeRaw`
          UPDATE sync_command
          SET status = 'ACCEPTED', result = '{"status":"ACCEPTED"}'::jsonb
          WHERE command_id = ${cmd.command_id}::uuid`,
      );
      expect(changed).toBe(0); // outcome_is_final hides it from UPDATE
      await expect(
        tenants.run(shop.biz, () =>
          currentTx().$executeRaw`DELETE FROM sync_command`,
        ),
      ).rejects.toThrow(/permission denied for table sync_command/);
      const [again] = await sync.processCommands(manager(shop), [cmd]);
      expect(again).toMatchObject({ status: 'REJECTED', code: 'STOCK_INSUFFICIENT' });
    });

    it('the database refuses a finished command without a result', async () => {
      await expect(
        tenants.run(shop.biz, () =>
          currentTx().$executeRaw`
            INSERT INTO sync_command (business_id, command_id, type, status, occurred_at, received_at)
            VALUES (${shop.biz}::uuid, ${randomUUID()}::uuid, 'stock.receive', 'ACCEPTED', now(), now())`,
        ),
      ).rejects.toThrow(/sync_command_result_when_done/);
    });
  });
});
