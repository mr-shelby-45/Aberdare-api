import { PrismaService } from '../src/database/prisma.service.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { StockRepository } from '../src/modules/stock/stock.repository.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import { resetTables } from './helpers/db.js';
import { prismaWithPool } from './helpers/prisma.js';
import { type Shop, seedShop as seedShopWith } from './helpers/shop.js';

// Spike step 2: atomic stock updates under concurrency (docs/spike.md).
// Numbered tests match the numbered list in the spike document. Each
// concurrency scenario is a function so test 6 can repeat all of them.

describe('step 2: atomic stock updates under concurrency', () => {
  const repo = new StockRepository();
  const stock = new StockService(repo);
  let prisma: PrismaService;
  let tenants: TenantRunner;

  beforeAll(async () => {
    prisma = prismaWithPool(10);
    await prisma.$connect();
    tenants = new TenantRunner(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seedShop = (name?: string): Promise<Shop> => seedShopWith(tenants, name);

  /** Balance, ledger sum and ledger row count for one pool, read as the tenant. */
  async function ledger(shop: Shop, packTypeId: string) {
    return tenants.run(shop.biz, async () => ({
      balance: await repo.balanceOf(shop.loc, packTypeId),
      sum: await repo.movementSum(shop.loc, packTypeId),
      rows: await currentTx().stockMovement.count({
        where: { locationId: shop.loc, packTypeId },
      }),
    }));
  }

  function settle<T>(results: PromiseSettledResult<T>[]) {
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason as unknown] : [],
    );
    return { ok, failed };
  }

  // ---------- scenarios ----------

  async function strictScenario(): Promise<void> {
    const shop = await seedShop();
    await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, 10));

    const { ok, failed } = settle(
      await Promise.allSettled(
        Array.from({ length: 50 }, () =>
          tenants.run(shop.biz, () =>
            stock.decreaseStrict(shop.loc, shop.piece, 1),
          ),
        ),
      ),
    );

    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(40);
    for (const reason of failed) {
      expect(reason).toMatchObject({ code: 'STOCK_INSUFFICIENT' });
    }
    // Each success saw a distinct, never-negative remaining quantity.
    expect(ok.map((r) => r.quantity).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    const l = await ledger(shop, shop.piece);
    expect(l.balance).toBe(0);
    expect(l.sum).toBe(l.balance);
    expect(l.rows).toBe(11); // 1 receive + 10 decreases
  }

  async function saleScenario(): Promise<void> {
    const shop = await seedShop();
    await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, 10));

    const { ok, failed } = settle(
      await Promise.allSettled(
        Array.from({ length: 50 }, () =>
          tenants.run(shop.biz, () =>
            stock.decreaseForSale(shop.loc, shop.piece, 1),
          ),
        ),
      ),
    );

    expect(failed).toEqual([]);
    expect(ok).toHaveLength(50);
    const quantities = ok.map((r) => r.quantity).sort((a, b) => a - b);
    expect(quantities).toEqual(Array.from({ length: 50 }, (_, i) => i - 40));
    expect(ok.filter((r) => r.flagged)).toHaveLength(40);
    for (const r of ok) expect(r.flagged).toBe(r.quantity < 0);

    const l = await ledger(shop, shop.piece);
    expect(l.balance).toBe(-40);
    expect(l.sum).toBe(l.balance);
    expect(l.rows).toBe(51);
  }

  async function mixedScenario(): Promise<void> {
    const shop = await seedShop();
    const start = 30;
    await tenants.run(shop.biz, () =>
      stock.receive(shop.loc, shop.piece, start),
    );

    const sizes = [1, 2, 5];
    const ops = Array.from({ length: 60 }, (_, i) => ({
      kind: (['strict', 'sale', 'receive'] as const)[i % 3],
      qty: sizes[Math.floor(i / 3) % 3],
    }));

    const results = await Promise.allSettled(
      ops.map((op) =>
        tenants.run(shop.biz, () => {
          if (op.kind === 'strict')
            return stock.decreaseStrict(shop.loc, shop.piece, op.qty);
          if (op.kind === 'sale')
            return stock.decreaseForSale(shop.loc, shop.piece, op.qty);
          return stock.receive(shop.loc, shop.piece, op.qty);
        }),
      ),
    );

    let expectedDelta = 0;
    let succeeded = 0;
    results.forEach((r, i) => {
      const op = ops[i];
      if (r.status === 'rejected') {
        // Only a strict decrease may fail, and only for lack of stock.
        expect(op.kind).toBe('strict');
        expect(r.reason).toMatchObject({ code: 'STOCK_INSUFFICIENT' });
        return;
      }
      succeeded++;
      expectedDelta += op.kind === 'receive' ? op.qty : -op.qty;
      if (op.kind === 'strict') expect(r.value.quantity).toBeGreaterThanOrEqual(0);
    });

    const l = await ledger(shop, shop.piece);
    expect(l.balance).toBe(start + expectedDelta);
    expect(l.sum).toBe(l.balance);
    expect(l.rows).toBe(1 + succeeded);
  }

  async function conversionScenario(): Promise<void> {
    const shop = await seedShop();
    await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.carton, 5));

    const { ok, failed } = settle(
      await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          tenants.run(shop.biz, () =>
            stock.convertOne(shop.loc, shop.carton, shop.piece),
          ),
        ),
      ),
    );

    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(15);
    for (const reason of failed) {
      expect(reason).toMatchObject({ code: 'STOCK_INSUFFICIENT' });
    }

    const cartons = await ledger(shop, shop.carton);
    const pieces = await ledger(shop, shop.piece);
    expect(cartons).toEqual({ balance: 0, sum: 0, rows: 6 }); // +5, then 5 x -1
    expect(pieces).toEqual({ balance: 120, sum: 120, rows: 5 }); // 5 x +24
    const conversions = await tenants.run(shop.biz, () =>
      currentTx().stockConversion.count(),
    );
    expect(conversions).toBe(5);
  }

  // ---------- the spike tests ----------

  it('1. strict mode: 50 concurrent decreases of 1 from 10 -> exactly 10 succeed, balance 0', async () => {
    await strictScenario();
  });

  it('2. sale mode: 50 concurrent decreases of 1 from 10 -> all recorded, balance -40, 40 flagged', async () => {
    await saleScenario();
  });

  it('3. mixed quantities and modes at once: balance always equals the sum of movements', async () => {
    await mixedScenario();
  });

  it('4. a failure halfway leaves neither a movement nor a balance change', async () => {
    const shop = await seedShop();
    await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, 10));

    // a) Error after the balance update and movement insert, before commit.
    let seenInside: number | undefined;
    await expect(
      tenants.run(shop.biz, async () => {
        await stock.decreaseStrict(shop.loc, shop.piece, 3);
        seenInside = await repo.balanceOf(shop.loc, shop.piece);
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    expect(seenInside).toBe(7); // the update really happened inside the transaction

    // b) Error after the balance update but before the movement insert.
    vi.spyOn(repo, 'insertMovement').mockRejectedValueOnce(
      new Error('crash between balance and ledger'),
    );
    await expect(
      tenants.run(shop.biz, () => stock.decreaseForSale(shop.loc, shop.piece, 4)),
    ).rejects.toThrow('crash between balance and ledger');

    // c) A conversion that fails at its very last write.
    await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.carton, 1));
    vi.spyOn(repo, 'insertConversion').mockRejectedValueOnce(
      new Error('crash before linking'),
    );
    await expect(
      tenants.run(shop.biz, () =>
        stock.convertOne(shop.loc, shop.carton, shop.piece),
      ),
    ).rejects.toThrow('crash before linking');

    expect(await ledger(shop, shop.piece)).toEqual({ balance: 10, sum: 10, rows: 1 });
    expect(await ledger(shop, shop.carton)).toEqual({ balance: 1, sum: 1, rows: 1 });
  });

  it('5. break bulk: one conversion writes two linked movements; 20 concurrent against 5 cartons -> 5 succeed', async () => {
    const shop = await seedShop();
    await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.carton, 2));

    const result = await tenants.run(shop.biz, () =>
      stock.convertOne(shop.loc, shop.carton, shop.piece),
    );
    expect(result.toQuantity).toBe(24);

    const conversion = await tenants.run(shop.biz, () =>
      currentTx().stockConversion.findUniqueOrThrow({
        where: { id: result.conversionId },
        include: { outMovement: true, inMovement: true },
      }),
    );
    expect(conversion.outMovement).toMatchObject({
      packTypeId: shop.carton,
      quantityChange: -1,
    });
    expect(conversion.inMovement).toMatchObject({
      packTypeId: shop.piece,
      quantityChange: 24,
    });
    expect(await ledger(shop, shop.carton)).toEqual({ balance: 1, sum: 1, rows: 2 });
    expect(await ledger(shop, shop.piece)).toEqual({ balance: 24, sum: 24, rows: 1 });

    // The concurrent part, on a fresh shop with exactly 5 cartons.
    await conversionScenario();
  });

  it('6. every concurrency scenario stays green 20 times in a row', { timeout: 300_000 }, async () => {
    for (let i = 0; i < 20; i++) {
      await strictScenario();
      await saleScenario();
      await mixedScenario();
      await conversionScenario();
    }
  });

  // ---------- supporting checks ----------

  describe('database rules behind the tests', () => {
    it('transactions run at READ COMMITTED (the Postgres default; not changed)', async () => {
      const shop = await seedShop();
      const [{ level }] = await tenants.run(shop.biz, () =>
        currentTx().$queryRaw<{ level: string }[]>`SELECT current_setting('transaction_isolation') AS level`,
      );
      expect(level).toBe('read committed');
    });

    it('app_user cannot UPDATE or DELETE ledger rows, or DELETE balances', async () => {
      const shop = await seedShop();
      await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, 5));
      for (const [sql, table] of [
        ['UPDATE stock_movement SET quantity_change = 99', 'stock_movement'],
        ['DELETE FROM stock_movement', 'stock_movement'],
        ['UPDATE stock_conversion SET created_at = now()', 'stock_conversion'],
        ['DELETE FROM stock_conversion', 'stock_conversion'],
        ['DELETE FROM stock_balance', 'stock_balance'],
      ]) {
        await expect(
          tenants.run(shop.biz, () => currentTx().$executeRawUnsafe(sql)),
          sql,
        ).rejects.toThrow(new RegExp(`permission denied for table ${table}`));
      }
      expect(await ledger(shop, shop.piece)).toEqual({ balance: 5, sum: 5, rows: 1 });
    });

    it("a business cannot point its rows at another business's location or pack type (composite FKs)", async () => {
      const a = await seedShop('Shop A');
      const b = await seedShop('Shop B');
      await expect(
        tenants.run(a.biz, () => stock.receive(b.loc, a.piece, 5)),
      ).rejects.toThrow(/foreign key/i);
      await expect(
        tenants.run(a.biz, () => stock.receive(a.loc, b.piece, 5)),
      ).rejects.toThrow(/foreign key/i);
      expect(await ledger(b, b.piece)).toEqual({ balance: 0, sum: 0, rows: 0 });
    });

    it("a business cannot see another business's stock", async () => {
      const a = await seedShop('Shop A');
      const b = await seedShop('Shop B');
      await tenants.run(a.biz, () => stock.receive(a.loc, a.piece, 7));
      const seenByB = await tenants.run(b.biz, async () => ({
        balance: await repo.balanceOf(a.loc, a.piece),
        movements: await currentTx().stockMovement.count(),
        balances: await currentTx().stockBalance.count(),
      }));
      expect(seenByB).toEqual({ balance: 0, movements: 0, balances: 0 });
    });

    it('check constraints: no zero movements, no self-linked conversion, no zero-size pack', async () => {
      const shop = await seedShop();
      await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, 1));
      const [{ id }] = await tenants.run(shop.biz, () =>
        currentTx().$queryRaw<{ id: string }[]>`SELECT id FROM stock_movement LIMIT 1`,
      );

      await expect(
        tenants.run(shop.biz, () =>
          currentTx().$executeRaw`
            INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change)
            VALUES (${shop.biz}::uuid, ${shop.loc}::uuid, ${shop.piece}::uuid, 0)`,
        ),
      ).rejects.toThrow(/stock_movement_quantity_change_nonzero/);

      await expect(
        tenants.run(shop.biz, () =>
          currentTx().$executeRaw`
            INSERT INTO stock_conversion (business_id, out_movement_id, in_movement_id)
            VALUES (${shop.biz}::uuid, ${id}::uuid, ${id}::uuid)`,
        ),
      ).rejects.toThrow(/stock_conversion_movements_differ/);

      await expect(
        tenants.run(shop.biz, () =>
          currentTx().$executeRaw`
            UPDATE pack_type SET units_per_pack = 0 WHERE id = ${shop.piece}::uuid`,
        ),
      ).rejects.toThrow(/pack_type_units_per_pack_positive/);
    });

    it('invalid quantities are refused before any write', async () => {
      const shop = await seedShop();
      for (const qty of [0, -1, 1.5, Number.NaN]) {
        await expect(
          tenants.run(shop.biz, () => stock.decreaseForSale(shop.loc, shop.piece, qty)),
        ).rejects.toMatchObject({ code: 'STOCK_QUANTITY_INVALID' });
        await expect(
          tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, qty)),
        ).rejects.toMatchObject({ code: 'STOCK_QUANTITY_INVALID' });
      }
      expect(await ledger(shop, shop.piece)).toEqual({ balance: 0, sum: 0, rows: 0 });
    });

    it('a strict decrease on a pool with no balance row fails with STOCK_INSUFFICIENT', async () => {
      const shop = await seedShop();
      await expect(
        tenants.run(shop.biz, () => stock.decreaseStrict(shop.loc, shop.piece, 1)),
      ).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT' });
    });

    it('converting pieces up into cartons is refused', async () => {
      const shop = await seedShop();
      await tenants.run(shop.biz, () => stock.receive(shop.loc, shop.piece, 48));
      await expect(
        tenants.run(shop.biz, () => stock.convertOne(shop.loc, shop.piece, shop.carton)),
      ).rejects.toMatchObject({ code: 'STOCK_CONVERSION_INVALID' });
      expect(await ledger(shop, shop.piece)).toEqual({ balance: 48, sum: 48, rows: 1 });
    });
  });
});
