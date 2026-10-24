import pg from 'pg';
import { PrismaService } from '../src/database/prisma.service.js';

// Spike step 0: the app's database client connects as app_user, and app_user
// cannot change the schema. A probe table is created as migrator (the owner)
// so there is something real for app_user to try to alter.

const PROBE_TABLE = 'step0_probe';

function migratorClient(): pg.Client {
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set');
  return new pg.Client({ connectionString: url });
}

describe('step 0: database roles', () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    const migrator = migratorClient();
    await migrator.connect();
    await migrator.query(
      `CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id int PRIMARY KEY)`,
    );
    await migrator.end();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    const migrator = migratorClient();
    await migrator.connect();
    await migrator.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
    await migrator.end();
  });

  it('connects as app_user and runs SELECT 1', async () => {
    const rows = await prisma.$queryRaw<{ one: number; who: string }[]>`
      SELECT 1 AS one, current_user AS who`;
    expect(rows).toEqual([{ one: 1, who: 'app_user' }]);
  });

  it('app_user is not a superuser and cannot bypass RLS', async () => {
    const rows = await prisma.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('app_user cannot ALTER TABLE (it does not own the table)', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `ALTER TABLE ${PROBE_TABLE} ADD COLUMN sneaky text`,
      ),
    ).rejects.toThrow(/must be owner of table/);
  });

  it('app_user cannot CREATE TABLE in the public schema', async () => {
    await expect(
      prisma.$executeRawUnsafe(`CREATE TABLE step0_sneaky (id int)`),
    ).rejects.toThrow(/permission denied for schema public/);
  });
});
