import { PrismaService } from '../src/database/prisma.service.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { ProductsRepository } from '../src/modules/products/products.repository.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';
import {
  HAND_WRITTEN_INDEXES,
  findDestructiveStatements,
  readMigrations,
} from './helpers/migration-guard.js';
import { prismaWithPool } from './helpers/prisma.js';
import { type Shop, seedShop } from './helpers/shop.js';

// Spike step 4: Prisma migrations with hand-written SQL (docs/spike.md).
// These run against the test database after `prisma migrate deploy` has
// applied every migration from nothing (test/global-setup.ts).

describe('step 4: migrations keep hand-written SQL', () => {
  describe('migration guard (fails the build if a migration drops custom objects)', () => {
    it('no migration drops or weakens a policy, trigger, function, extension or hand-written index', () => {
      const offenders = readMigrations().flatMap(({ name, sql }) =>
        findDestructiveStatements(sql).map((statement) => `${name}: ${statement}`),
      );
      expect(offenders).toEqual([]);
    });

    it('the guard catches the DROP INDEX Prisma generated for the trigram index', () => {
      // Copied from Prisma's diff before the index was declared in schema.prisma.
      const prismaOutput = '-- DropIndex\nDROP INDEX "product_name_trgm_idx";\n';
      expect(findDestructiveStatements(prismaOutput)).toEqual([
        '-- DropIndex\nDROP INDEX "product_name_trgm_idx"',
      ]);
      for (const sql of [
        'DROP POLICY shop_only ON product;',
        'ALTER TABLE product DISABLE ROW LEVEL SECURITY;',
        'ALTER TABLE product NO FORCE ROW LEVEL SECURITY;',
        'DROP TRIGGER product_change_log ON product;',
        'DROP FUNCTION log_product_change();',
        'DROP EXTENSION pg_trgm;',
        'DROP INDEX "pack_type_one_base_unit_per_product";',
      ]) {
        expect(findDestructiveStatements(sql), sql).toHaveLength(1);
      }
    });

    it('a migration can still do it on purpose, with an explicit marker', () => {
      const sql = '-- allow-destructive: replacing shop_only with a stricter policy\nDROP POLICY shop_only ON product;';
      expect(findDestructiveStatements(sql)).toEqual([]);
    });

    it('ordinary Prisma SQL is not flagged', () => {
      expect(
        findDestructiveStatements('ALTER TABLE "product" ADD COLUMN "sku" TEXT;\nDROP INDEX "some_prisma_index";'),
      ).toEqual([]);
    });
  });

  describe('the database after all migrations', () => {
    it('every table with a business_id has RLS enabled and forced with the NULLIF shop_only policy', async () => {
      const rows = await asAppUser(async (c) =>
        (
          await c.query<{
            tbl: string;
            rls: boolean;
            forced: boolean;
            using_expr: string | null;
            check_expr: string | null;
          }>(`
            SELECT c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                   pg_get_expr(p.polqual, p.polrelid) AS using_expr,
                   pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
            FROM pg_class c
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'business_id' AND NOT a.attisdropped
            LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'shop_only'
            WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
            ORDER BY 1`)
        ).rows,
      );
      const nullif = "(business_id = (NULLIF(current_setting('app.business_id'::text, true), ''::text))::uuid)";
      expect(rows.map((r) => r.tbl)).toEqual([
        'approval',
        'audit_log',
        'change_log',
        'device',
        'device_membership',
        'field_settlement', // Phase T1: field_settlement, field_settlement_line, stock_transfer
        'field_settlement_line',
        'location',
        'membership',
        'pack_type',
        'payment',
        'product',
        'product_barcode',
        'refresh_token',
        'sale', // Phase E1: sale, sale_counter, sale_item, payment
        'sale_counter',
        'sale_item',
        'stock_balance',
        'stock_conversion',
        'stock_movement',
        'stock_transfer',
        'sync_command',
      ]);
      for (const r of rows) {
        expect(r, r.tbl).toEqual({ tbl: r.tbl, rls: true, forced: true, using_expr: nullif, check_expr: nullif });
      }
    });

    it('the triggers, their functions, the extension and the hand-written indexes exist', async () => {
      const found = await asAppUser(async (c) => ({
        triggers: (await c.query(`SELECT tgname, tgrelid::regclass::text AS tbl FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`)).rows,
        functions: (await c.query(`SELECT proname FROM pg_proc WHERE proname LIKE 'log\\_%\\_change' ORDER BY 1`)).rows,
        extensions: (await c.query(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)).rows,
        indexes: (
          await c.query<{ indexname: string; indexdef: string }>(
            `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1) ORDER BY 1`,
            [HAND_WRITTEN_INDEXES],
          )
        ).rows,
      }));
      // The exact inventory: a new trigger or function must be added here on purpose (Phase B1 added three).
      expect(found.triggers).toEqual([
        { tgname: 'location_change_log', tbl: 'location' },
        { tgname: 'pack_type_change_log', tbl: 'pack_type' },
        { tgname: 'payment_change_log', tbl: 'payment' },
        { tgname: 'product_barcode_change_log', tbl: 'product_barcode' },
        { tgname: 'product_change_log', tbl: 'product' },
        { tgname: 'sale_change_log', tbl: 'sale' }, // Phase E1: sale, sale_item, payment
        { tgname: 'sale_item_change_log', tbl: 'sale_item' },
        { tgname: 'stock_balance_change_log', tbl: 'stock_balance' },
      ]);
      expect(found.functions).toEqual([{ proname: 'log_product_barcode_change' }, { proname: 'log_product_change' }]);
      // Phase D1: the one function that deletes change_log rows, and the owner policies it relies on.
      const prune = await asAdmin(async (c) => ({
        functions: (
          await c.query(
            `SELECT p.proname, p.prosecdef AS security_definer,
                    has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_may_run,
                    has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_run
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'change\\_log\\_%' ORDER BY 1`,
          )
        ).rows,
        policies: (await c.query(`SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'change_log'::regclass ORDER BY 1`)).rows,
      }));
      expect(prune.functions).toEqual([{ proname: 'change_log_prune', security_definer: true, app_user_may_run: true, public_may_run: false }]);
      expect(prune.policies).toEqual([
        { polname: 'owner_prune_delete', polcmd: 'd' },
        { polname: 'owner_prune_read', polcmd: 'r' },
        { polname: 'shop_only', polcmd: '*' },
      ]);
      expect(found.extensions).toEqual([{ extname: 'pg_trgm' }]);
      const byName = new Map(found.indexes.map((i) => [i.indexname, i.indexdef]));
      expect(byName.get('location_one_default_per_business')).toMatch(/CREATE UNIQUE INDEX .* WHERE is_default/);
      expect([...byName.keys()]).toEqual([
        'location_one_active_field_per_member',
        'location_one_default_per_business',
        'membership_one_owner_per_business',
        'pack_type_one_base_unit_per_product',
        'payment_mpesa_code_unique',
        'product_name_trgm_idx',
      ]);
      // Phase T1: one active field location per member.
      expect(byName.get('location_one_active_field_per_member')).toMatch(
        /CREATE UNIQUE INDEX .* \(business_id, assigned_membership_id\) WHERE \(\(kind = 'FIELD'::text\) AND \(archived_at IS NULL\)\)/,
      );
      // Phase E1: one original payment per M-Pesa code per business.
      expect(byName.get('payment_mpesa_code_unique')).toMatch(
        /CREATE UNIQUE INDEX .* \(business_id, mpesa_code\) WHERE \(\(mpesa_code IS NOT NULL\) AND \(duplicate_of_payment_id IS NULL\)\)/,
      );
      expect(byName.get('pack_type_one_base_unit_per_product')).toMatch(
        /CREATE UNIQUE INDEX .* WHERE \(units_per_pack = 1\)/,
      );
      expect(byName.get('product_name_trgm_idx')).toMatch(/USING gin \(name gin_trgm_ops\)/);
      expect(byName.get('membership_one_owner_per_business')).toMatch(
        /CREATE UNIQUE INDEX .*\(business_id\) WHERE \(role_preset = 'OWNER'::role_preset\)/,
      );
    });

    it('migrations alone give app_user access to the public schema, and nobody else can create in it', async () => {
      const privs = await asAppUser(async (c) =>
        (
          await c.query(`
            SELECT has_schema_privilege('app_user', 'public', 'USAGE')  AS app_usage,
                   has_schema_privilege('app_user', 'public', 'CREATE') AS app_create,
                   has_schema_privilege('public', 'public', 'CREATE')   AS public_create`)
        ).rows[0],
      );
      expect(privs).toEqual({ app_usage: true, app_create: false, public_create: false });
    });

    it('the ordinary schema change (product.sku) is present', async () => {
      const cols = await asAppUser(async (c) =>
        (
          await c.query(
            `SELECT data_type, is_nullable FROM information_schema.columns
             WHERE table_name = 'product' AND column_name = 'sku'`,
          )
        ).rows,
      );
      expect(cols).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    });
  });

  describe('the hand-written objects work', () => {
    const products = new ProductsRepository();
    let prisma: PrismaService;
    let tenants: TenantRunner;
    let shop: Shop;

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
      shop = await seedShop(tenants);
    });

    // change_log rows seedShop writes: location, product, piece, carton.
    const SEED_SHOP_LOG_ROWS = 4;

    const changes = (biz: string) =>
      tenants.run(biz, () =>
        currentTx().changeLog.findMany({
          orderBy: { id: 'asc' },
          select: { tableName: true, operation: true, rowId: true, rowKey: true, businessId: true },
        }),
      );

    it('the triggers write one change_log row per product insert and update, and per barcode insert and delete', async () => {
      const rowsOf = async (table: string) => (await changes(shop.biz)).filter((c) => c.tableName === table);
      // seedShop created one product (its location and pack types are logged too, since B1).
      expect((await rowsOf('product')).map((c) => c.operation)).toEqual(['INSERT']);

      const p = await tenants.run(shop.biz, () => products.create('Maize flour 2kg'));
      await tenants.run(shop.biz, () => products.rename(p.id, 'Maize flour 2 kg'));
      expect((await rowsOf('product')).slice(1)).toEqual([
        { tableName: 'product', operation: 'INSERT', rowId: p.id, rowKey: null, businessId: shop.biz },
        { tableName: 'product', operation: 'UPDATE', rowId: p.id, rowKey: null, businessId: shop.biz },
      ]);

      // Products are archived, never deleted: app_user has no DELETE since B1.
      await expect(
        tenants.run(shop.biz, () => currentTx().$executeRaw`DELETE FROM product WHERE id = ${p.id}::uuid`),
      ).rejects.toThrow(/permission denied for table product/);

      // Deletes are logged on product_barcode, with the code in row_key.
      const personId = await asAdmin(
        async (c) => (await c.query<{ id: string }>("INSERT INTO person (phone) VALUES ('+254700000001') RETURNING id")).rows[0].id,
      );
      const barcode = await tenants.run(shop.biz, async () => {
        const tx = currentTx();
        const m = await tx.membership.create({
          data: { businessId: shop.biz, personId, displayName: 'Owner', rolePreset: 'OWNER', status: 'ACTIVE' },
          select: { id: true },
        });
        const piece = await tx.packType.findUniqueOrThrow({ where: { id: shop.piece } });
        return tx.productBarcode.create({
          data: { businessId: shop.biz, barcode: '06161101560029', productId: piece.productId, packTypeId: piece.id, createdByMembershipId: m.id },
          select: { id: true },
        });
      });
      await tenants.run(shop.biz, () => currentTx().productBarcode.delete({ where: { id: barcode.id } }));
      expect(await rowsOf('product_barcode')).toEqual([
        { tableName: 'product_barcode', operation: 'INSERT', rowId: barcode.id, rowKey: '06161101560029', businessId: shop.biz },
        { tableName: 'product_barcode', operation: 'DELETE', rowId: barcode.id, rowKey: '06161101560029', businessId: shop.biz },
      ]);
    });

    it('a rolled-back product change leaves no change_log row', async () => {
      await expect(
        tenants.run(shop.biz, async () => {
          await products.create('never saved');
          throw new Error('handler failed');
        }),
      ).rejects.toThrow('handler failed');
      // Only seedShop's 4 rows (location, product, 2 pack types; logged since B1).
      expect(await changes(shop.biz)).toHaveLength(SEED_SHOP_LOG_ROWS);
    });

    it("change_log rows are tenant-scoped and append-only for app_user", async () => {
      const other = await seedShop(tenants, 'Shop B');
      expect((await changes(other.biz)).every((c) => c.businessId === other.biz)).toBe(true);
      expect(await changes(other.biz)).toHaveLength(SEED_SHOP_LOG_ROWS);

      for (const sql of ['UPDATE change_log SET operation = $1', 'DELETE FROM change_log']) {
        await expect(
          tenants.run(shop.biz, () =>
            sql.startsWith('UPDATE')
              ? currentTx().$executeRawUnsafe(sql, 'X')
              : currentTx().$executeRawUnsafe(sql),
          ),
          sql,
        ).rejects.toThrow(/permission denied for table change_log/);
      }
    });

    it('the partial unique index allows one piece per product, and any number of other packs', async () => {
      const productId = await tenants.run(shop.biz, async () =>
        (await currentTx().packType.findUniqueOrThrow({ where: { id: shop.piece } })).productId,
      );
      await expect(
        tenants.run(shop.biz, () =>
          currentTx().packType.create({
            data: { businessId: shop.biz, productId, name: 'single', unitsPerPack: 1, sellPrice: '50.00' },
          }),
        ),
      ).rejects.toThrow(/Unique constraint|pack_type_one_base_unit_per_product/);

      await tenants.run(shop.biz, () =>
        currentTx().packType.create({
          data: { businessId: shop.biz, productId, name: 'carton of 12', unitsPerPack: 12, sellPrice: '600.00' },
        }),
      );
      const packs = await tenants.run(shop.biz, () => currentTx().packType.count());
      expect(packs).toBe(3); // piece, carton of 24, carton of 12
    });

    it('trigram search finds a misspelt product name', async () => {
      await tenants.run(shop.biz, async () => {
        await products.create('Maize flour 2kg');
        await products.create('Cooking oil 1L');
      });
      const rows = await tenants.run(shop.biz, () =>
        currentTx().$queryRaw<{ name: string }[]>`
          SELECT name FROM product WHERE name % ${'maze flor'} ORDER BY similarity(name, ${'maze flor'}) DESC`,
      );
      expect(rows.map((r) => r.name)).toEqual(['Maize flour 2kg']);
    });
  });
});
