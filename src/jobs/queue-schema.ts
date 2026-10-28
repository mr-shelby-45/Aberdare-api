import { PgBoss } from 'pg-boss';

/** The schema pg-boss keeps its tables in (created empty by the f1_queue_schema migration). */
export const QUEUE_SCHEMA = 'pgboss';

/**
 * Creates or upgrades pg-boss's own tables in the pgboss schema (Phase F1
 * privilege plan, docs/phase-f-design.md section 3). Run as the MIGRATION
 * role, right after `prisma migrate deploy`: the objects it creates belong to
 * migrator, and the schema's default privileges give queue_user exactly what
 * the worker needs. The worker itself never migrates (migrate: false).
 */
export async function migrateQueueSchema(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    // The migration created the schema; pg-boss only fills it.
    createSchema: false,
    migrate: true,
    // Install only: no maintenance, schedules or instance row.
    supervise: false,
    schedule: false,
    registerInstance: false,
    max: 1,
  });
  let failure: unknown = null;
  boss.on('error', (err: unknown) => {
    failure ??= err;
  });
  await boss.start();
  await boss.stop({ graceful: false, close: true });
  if (failure !== null) throw failure;
}
