import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantContextMissingError } from '../src/common/errors/tenant-context-missing.error.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { ProductsRepository } from '../src/modules/products/products.repository.js';
import {
  asAppUser,
  createBusiness,
  resetTables,
} from './helpers/db.js';

// Spike step 1: tenant isolation through Prisma (docs/spike.md).
// Numbered tests match the numbered list in the spike document.

/** A PrismaService with a fixed pool size, connected as app_user. */
function prismaWithPool(max: number): PrismaService {
  const previous = process.env.DATABASE_POOL_MAX;
  process.env.DATABASE_POOL_MAX = String(max);
  try {
    return new PrismaService();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = previous;
  }
}

describe('step 1: tenant isolation (RLS) through Prisma', () => {
  const repo = new ProductsRepository();
  let prisma: PrismaService;
  let tenants: TenantRunner;
  let bizA: string;
  let bizB: string;
  let productB1: string;

  beforeAll(async () => {
    prisma = prismaWithPool(3);
    await prisma.$connect();
    tenants = new TenantRunner(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTables();
    bizA = await createBusiness('Shop A');
    bizB = await createBusiness('Shop B');
    // Products are created the real way: as app_user, inside a tenant context.
    await tenants.run(bizA, async () => {
      await repo.create('A maize flour');
      await repo.create('A sugar');
    });
    productB1 = await tenants.run(bizB, async () => {
      const p = await repo.create('B cooking oil');
      await repo.create('B rice');
      await repo.create('B salt');
      return p.id;
    });
  });

  it('1. each business lists only its own products', async () => {
    const a = await tenants.run(bizA, () => repo.list());
    expect(a.map((p) => p.name)).toEqual(['A maize flour', 'A sugar']);
    expect(a.every((p) => p.businessId === bizA)).toBe(true);

    const b = await tenants.run(bizB, () => repo.list());
    expect(b.map((p) => p.name)).toEqual(['B cooking oil', 'B rice', 'B salt']);
    expect(b.every((p) => p.businessId === bizB)).toBe(true);
  });

  it("2. inside A, inserting a product with B's business_id fails (WITH CHECK)", async () => {
    await expect(
      tenants.run(bizA, () =>
        currentTx().product.create({
          data: { businessId: bizB, name: 'sneaky' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);

    // Moving one of A's own rows over to B is blocked the same way.
    await expect(
      tenants.run(bizA, () =>
        currentTx().product.updateMany({ data: { businessId: bizB } }),
      ),
    ).rejects.toThrow(/row-level security/);

    const b = await tenants.run(bizB, () => repo.list());
    expect(b.map((p) => p.name)).toEqual(['B cooking oil', 'B rice', 'B salt']);
  });

  it("3. inside A, updating or deleting B's rows affects zero rows", async () => {
    const renamed = await tenants.run(bizA, () =>
      repo.rename(productB1, 'hacked'),
    );
    const deleted = await tenants.run(bizA, () => repo.remove(productB1));
    expect(renamed).toBe(0);
    expect(deleted).toBe(0);

    // Unscoped bulk writes also only reach A's own rows.
    const bulk = await tenants.run(bizA, () =>
      currentTx().product.updateMany({ data: { name: 'renamed by A' } }),
    );
    expect(bulk.count).toBe(2);

    const b = await tenants.run(bizB, () => repo.list());
    expect(b.map((p) => p.name)).toEqual(['B cooking oil', 'B rice', 'B salt']);
  });

  it('4. forgotten wrapper: the repository throws, and the raw client sees zero rows', async () => {
    await expect(repo.list()).rejects.toThrow(TenantContextMissingError);
    await expect(repo.list()).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
    });
    await expect(repo.create('orphan')).rejects.toThrow(
      TenantContextMissingError,
    );

    // Defence in depth: even if someone used the raw client directly,
    // RLS returns nothing rather than everything.
    expect(await prisma.product.findMany()).toEqual([]);
    expect(await prisma.product.count()).toBe(0);
  });

  it('5. no leak between pooled connections (200 interleaved requests, pool of 3)', async () => {
    const expected = new Map([
      [bizA, ['A maize flour', 'A sugar']],
      [bizB, ['B cooking oil', 'B rice', 'B salt']],
    ]);
    const pids = new Set<number>();

    const requests = Array.from({ length: 200 }, (_, i) => {
      const biz = i % 2 === 0 ? bizA : bizB;
      return tenants.run(biz, async () => {
        const [{ pid, setting }] = await currentTx().$queryRaw<
          { pid: number; setting: string }[]
        >`SELECT pg_backend_pid() AS pid, current_setting('app.business_id', true) AS setting`;
        // Yield inside the transaction so requests genuinely interleave.
        await currentTx().$executeRaw`SELECT pg_sleep(0.001)`;
        const rows = await repo.list();
        pids.add(pid);
        return { biz, setting, rows };
      });
    });

    const results = await Promise.all(requests);

    expect(results).toHaveLength(200);
    for (const r of results) {
      expect(r.setting).toBe(r.biz);
      expect(r.rows.map((p) => p.name)).toEqual(expected.get(r.biz));
      expect(r.rows.every((p) => p.businessId === r.biz)).toBe(true);
    }
    // Proves connections were reused: at most 3 backends served 200 requests.
    expect(pids.size).toBeGreaterThanOrEqual(2);
    expect(pids.size).toBeLessThanOrEqual(3);
  });

  it('6. after a transaction, the same connection with no setting sees zero rows', async () => {
    // Through Prisma, with a pool of one so the same connection is certain.
    const single = prismaWithPool(1);
    await single.$connect();
    try {
      const runner = new TenantRunner(single);
      const inside = await runner.run(bizA, async () => {
        const [{ pid }] = await currentTx().$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        return { pid, rows: await repo.list() };
      });
      expect(inside.rows).toHaveLength(2);

      const [after] = await single.$queryRaw<
        { pid: number; setting: string | null }[]
      >`SELECT pg_backend_pid() AS pid, current_setting('app.business_id', true) AS setting`;
      expect(after.pid).toBe(inside.pid);
      // The empty-string case the NULLIF in the policy exists for.
      expect(after.setting).toBe('');
      expect(await single.product.findMany()).toEqual([]);
    } finally {
      await single.$disconnect();
    }

    // The same check on a raw connection, with no Prisma involved.
    await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [bizB]);
      expect((await c.query('SELECT * FROM product')).rowCount).toBe(3);
      await c.query('COMMIT');

      const setting = await c.query<{ s: string }>(
        "SELECT current_setting('app.business_id', true) AS s",
      );
      expect(setting.rows[0].s).toBe('');
      expect((await c.query('SELECT * FROM product')).rowCount).toBe(0);
    });
  });

  it('7. app_user cannot bypass RLS', async () => {
    await asAppUser(async (c) => {
      // Turning row security off makes Postgres refuse the query, not show all rows.
      await c.query('SET row_security = off');
      await expect(c.query('SELECT * FROM product')).rejects.toThrow(
        /query would be affected by row-level security policy/,
      );
      await c.query('RESET row_security');

      for (const sql of [
        'ALTER TABLE product DISABLE ROW LEVEL SECURITY',
        'ALTER TABLE product NO FORCE ROW LEVEL SECURITY',
        'DROP POLICY shop_only ON product',
        'ALTER POLICY shop_only ON product USING (true)',
        'CREATE POLICY see_all ON product USING (true)',
      ]) {
        await expect(c.query(sql), sql).rejects.toThrow(
          /must be owner of (table|relation) product/,
        );
      }

      await expect(c.query('SET ROLE migrator')).rejects.toThrow(
        /permission denied to set role "migrator"/,
      );

      const owner = await c.query<{ owner: string; me: string }>(
        "SELECT tableowner AS owner, current_user AS me FROM pg_tables WHERE tablename = 'product'",
      );
      expect(owner.rows[0]).toEqual({ owner: 'migrator', me: 'app_user' });

      const role = await c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  it('8. the wrapper rolls back everything when the handler throws', async () => {
    await expect(
      tenants.run(bizA, async () => {
        await repo.create('half-written 1');
        await repo.rename(
          (await repo.list())[0].id,
          'renamed before failure',
        );
        await repo.create('half-written 2');
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');

    const a = await tenants.run(bizA, () => repo.list());
    expect(a.map((p) => p.name)).toEqual(['A maize flour', 'A sugar']);
  });

  describe('guards against using the wrapper wrongly', () => {
    it('a class outside DatabaseModule cannot inject PrismaService', async () => {
      @Injectable()
      class SneakyRepository {
        // The realistic accident: plain constructor injection, no @Inject.
        constructor(readonly prisma: PrismaService) {}
      }

      @Module({ imports: [DatabaseModule], providers: [SneakyRepository] })
      class SneakyModule {}

      await expect(
        Test.createTestingModule({ imports: [SneakyModule] }).compile(),
      ).rejects.toThrow(/can't resolve dependencies of the SneakyRepository/);
    });

    it('other modules can get TenantRunner from DatabaseModule', async () => {
      @Injectable()
      class HonestService {
        constructor(readonly tenants: TenantRunner) {}
      }

      @Module({ imports: [DatabaseModule], providers: [HonestService] })
      class HonestModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [HonestModule],
      }).compile();
      await moduleRef.init();
      try {
        const svc = moduleRef.get(HonestService);
        const rows = await svc.tenants.run(bizA, () => repo.list());
        expect(rows).toHaveLength(2);
      } finally {
        await moduleRef.close();
      }
    });

    it('nested tenant transactions are refused', async () => {
      await expect(
        tenants.run(bizA, () => tenants.run(bizB, () => repo.list())),
      ).rejects.toThrow(/already inside a tenant transaction/);
    });

    it('a business id that is not a UUID is refused before touching the database', async () => {
      await expect(
        tenants.run("' OR 1=1 --", () => repo.list()),
      ).rejects.toThrow(/must be a UUID/);
    });
  });
});
