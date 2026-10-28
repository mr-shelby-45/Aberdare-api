import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import pg from 'pg';
import { loadConfig } from '../src/config/app.config.js';
import { type Worker, createWorker } from '../src/create-worker.js';
import { WorkerModule } from '../src/worker.module.js';
import { TEST_ENV } from './helpers/app.js';
import { asAdmin, asAppUser, createBusiness, resetTables } from './helpers/db.js';

// Phase F1: the notification and error_event tables, the business-list and
// purge functions, pg-boss and the worker skeleton (docs/phase-f-design.md
// sections 3 and 4). Test numbers follow the F1 list in section 11. The exact
// RLS and grants inventories are in test/step4-migrations.spec.ts and
// test/b5-hardening.spec.ts.

const queueUrl = () => {
  const url = process.env.QUEUE_DATABASE_URL;
  if (!url) throw new Error('TEST_QUEUE_DATABASE_URL is not set (see .env.example)');
  return url;
};
const workerConfig = (over: Record<string, string> = {}) => loadConfig({ ...TEST_ENV, QUEUE_DATABASE_URL: queueUrl(), ...over });

/** A worker exactly as production builds it, its log lines captured. */
async function startWorker(): Promise<Worker & { lines: () => string }> {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const worker = await createWorker(WorkerModule, workerConfig(), { logStream: sink, nestLogs: false });
  return Object.assign(worker, { lines: () => chunks.join('') });
}

/** One query as a role, returning rows or the SQLSTATE. */
async function as(url: string, sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] } | { code: string }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const result = await c.query(sql, params);
    // Several statements in one call give one result each; report the last.
    return { rows: (Array.isArray(result) ? (result as pg.QueryResult[])[(result as pg.QueryResult[]).length - 1] : result).rows };
  } catch (err) {
    return { code: (err as { code: string }).code };
  } finally {
    await c.end();
  }
}

/** A member of the business (person and membership, seeded as the superuser). */
async function member(businessId: string): Promise<string> {
  const id = randomUUID();
  await asAdmin(async (c) => {
    const person = randomUUID();
    await c.query('INSERT INTO person (id, phone) VALUES ($1, $2)', [person, `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`]);
    await c.query("INSERT INTO membership (id, business_id, person_id, display_name, role_preset, status) VALUES ($1, $2, $3, 'M', 'MANAGER', 'ACTIVE')", [id, businessId, person]);
  });
  return id;
}

/** Inserts a notification as app_user in the business's tenant; returns 'ok' or the violated constraint. */
async function insertNotification(businessId: string, over: Record<string, unknown>): Promise<string> {
  const row: Record<string, unknown> = { business_id: businessId, type: 'sale.flagged', channel: 'IN_APP', data: { sale_id: 'x' }, status: 'SENT', sent_at: new Date(), dedupe_key: 'sale.flagged:1', ...over };
  // data as JSON text: the driver would send a JavaScript array as a Postgres array.
  row.data = JSON.stringify(row.data);
  const cols = Object.keys(row);
  return asAppUser(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
      await c.query(`INSERT INTO notification (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
      await c.query('COMMIT');
      return 'ok';
    } catch (err) {
      await c.query('ROLLBACK');
      return (err as { constraint?: string; code: string }).constraint ?? (err as { code: string }).code;
    }
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('F1: worker schema, functions and pg-boss', { timeout: 120_000 }, () => {
  beforeEach(async () => {
    await resetTables();
  });

  // ---------------------------------------------------------------- 1. privileges
  it('1. functions, policies and roles: SECURITY DEFINER for app_user only; queue_user reaches only pgboss; app_user never pgboss', async () => {
    const functions = await asAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
                    has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_may_run,
                    has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_run,
                    has_function_privilege('queue_user', p.oid, 'EXECUTE') AS queue_user_may_run
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('list_business_ids', 'purge_old_notifications', 'purge_old_error_events') ORDER BY 1`,
          )
        ).rows,
    );
    expect(functions).toEqual([
      { proname: 'list_business_ids', owner: 'identity_owner', security_definer: true, app_user_may_run: true, public_may_run: false, queue_user_may_run: false },
      { proname: 'purge_old_error_events', owner: 'migrator', security_definer: true, app_user_may_run: true, public_may_run: false, queue_user_may_run: false },
      { proname: 'purge_old_notifications', owner: 'migrator', security_definer: true, app_user_may_run: true, public_may_run: false, queue_user_may_run: false },
    ]);
    const policies = await asAdmin(async (c) => (await c.query(`SELECT polname, polcmd, polroles::regrole[]::text[] AS roles FROM pg_policy WHERE polrelid = 'notification'::regclass ORDER BY 1`)).rows);
    expect(policies).toEqual([
      { polname: 'owner_purge_delete', polcmd: 'd', roles: ['migrator'] },
      { polname: 'owner_purge_read', polcmd: 'r', roles: ['migrator'] },
      { polname: 'shop_only', polcmd: '*', roles: ['-'] },
    ]);
    // identity_owner got CREATE on public only for the hand-over.
    const schemas = await asAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT has_schema_privilege('identity_owner', 'public', 'CREATE') AS identity_create,
                    has_schema_privilege('queue_user', 'pgboss', 'USAGE') AS queue_pgboss,
                    has_schema_privilege('queue_user', 'pgboss', 'CREATE') AS queue_create,
                    has_schema_privilege('queue_user', 'public', 'USAGE') AS queue_public,
                    has_schema_privilege('app_user', 'pgboss', 'USAGE') AS app_pgboss,
                    (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = 'queue_user') AS queue_powerful,
                    (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'pgboss'::regnamespace AND pg_get_userbyid(relowner) <> 'migrator') AS not_migrator_owned`,
          )
        ).rows[0],
    );
    expect(schemas).toEqual({ identity_create: false, queue_pgboss: true, queue_create: false, queue_public: false, app_pgboss: false, queue_powerful: false, not_migrator_owned: 0 });
    // In practice: queue_user cannot read a business table; app_user cannot reach pg-boss.
    const biz = await createBusiness('A');
    expect(await as(queueUrl(), 'SELECT id FROM public.business')).toEqual({ code: '42501' });
    expect(await as(queueUrl(), 'SELECT count(*) FROM pgboss.job')).toMatchObject({ rows: [{ count: expect.any(String) }] });
    expect(await as(process.env.TEST_DATABASE_URL!, 'SELECT count(*) FROM pgboss.job')).toEqual({ code: '42501' });
    expect(await as(process.env.TEST_DATABASE_URL!, 'SELECT pgboss.job_now()')).toEqual({ code: '42501' });
    // app_user: no DELETE on notification, INSERT only on error_event (and no INSERT ... RETURNING).
    const m = await member(biz);
    expect(await insertNotification(biz, { recipient_membership_id: m })).toBe('ok');
    const app = process.env.TEST_DATABASE_URL!;
    expect(await as(app, `BEGIN; SELECT set_config('app.business_id', '${biz}', true); DELETE FROM notification; COMMIT;`)).toEqual({ code: '42501' });
    expect(await as(app, "INSERT INTO error_event (source, code, detail, business_id) VALUES ('f1', 'TEST', 'x', NULL)")).toEqual({ rows: [] });
    expect(await as(app, "INSERT INTO error_event (source, code) VALUES ('f1', 'TEST') RETURNING id")).toEqual({ code: '42501' });
    expect(await as(app, 'SELECT * FROM error_event')).toEqual({ code: '42501' });
    // A dead push token can be cleared (the one new device column).
    expect(await as(app, `BEGIN; SELECT set_config('app.business_id', '${biz}', true); UPDATE device SET push_token = NULL WHERE false; COMMIT;`)).toEqual({ rows: [] });
  });

  // ---------------------------------------------------------------- 2. checks
  it('2. the database refuses bad types, channels, statuses, lengths and duplicates; the same key for another recipient or channel is fine', async () => {
    const biz = await createBusiness('A');
    const m1 = await member(biz);
    const m2 = await member(biz);
    const pending = { channel: 'PUSH', status: 'PENDING', sent_at: null, next_attempt_at: new Date() };
    expect(await insertNotification(biz, { recipient_membership_id: m1 })).toBe('ok');
    expect(await insertNotification(biz, { recipient_membership_id: m1 })).toBe('notification_business_id_recipient_membership_id_channel_de_key');
    expect(await insertNotification(biz, { recipient_membership_id: m2 })).toBe('ok');
    expect(await insertNotification(biz, { recipient_membership_id: m1, ...pending })).toBe('ok');
    const refused: [string, Record<string, unknown>, string][] = [
      ['an unknown type', { type: 'order.new' }, 'notification_type_known'],
      ['an unknown channel', { channel: 'WHATSAPP' }, 'notification_channel_known'],
      ['an unknown status', { ...pending, status: 'QUEUED' }, 'notification_status_known'],
      ['negative attempts', { ...pending, attempts: -1 }, 'notification_attempts_not_negative'],
      ['a long last_error', { ...pending, last_error: 'E'.repeat(61) }, 'notification_last_error_length'],
      ['an empty dedupe key', { dedupe_key: '' }, 'notification_dedupe_key_length'],
      ['data that is not an object', { data: [1, 2] }, 'notification_data_object'],
      ['an IN_APP row not SENT', { status: 'PENDING', sent_at: null, next_attempt_at: new Date() }, 'notification_in_app_sent'],
      ['a read PUSH row', { ...pending, read_at: new Date() }, 'notification_read_in_app'],
      ['SENT without sent_at', { sent_at: null }, 'notification_sent_at_with_status'],
      ['PENDING without a due time', { ...pending, next_attempt_at: null }, 'notification_pending_due'],
      ["another business's member", { recipient_membership_id: await member(await createBusiness('B')) }, 'notification_business_id_recipient_membership_id_fkey'],
    ];
    for (const [label, over, constraint] of refused) {
      expect(await insertNotification(biz, { recipient_membership_id: m1, dedupe_key: `k:${label}`, ...over }), label).toBe(constraint);
    }
    const errorEvent = (cols: string) => as(process.env.TEST_DATABASE_URL!, `INSERT INTO error_event (source, code, detail) VALUES ${cols}`);
    expect(await errorEvent(`('f1', 'TEST', '${'d'.repeat(200)}')`)).toEqual({ rows: [] });
    expect(await errorEvent(`('f1', 'TEST', '${'d'.repeat(201)}')`)).toEqual({ code: '23514' });
    expect(await errorEvent(`('${'s'.repeat(61)}', 'TEST', NULL)`)).toEqual({ code: '23514' });
    expect(await errorEvent(`('f1', '', NULL)`)).toEqual({ code: '23514' });
  });

  // ---------------------------------------------------------------- 3. list_business_ids
  it('3. list_business_ids returns every business once across pages of any size, in id order, ids only, with no tenant setting', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await createBusiness(`B${i}`));
    ids.sort();
    for (const size of [1, 2, 3, 7, 1000]) {
      const seen: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await asAppUser(async (c) => (await c.query<{ id: string }>('SELECT * FROM list_business_ids($1, $2)', [after, size])));
        expect(page.fields.map((f) => f.name)).toEqual(['id']);
        if (page.rows.length === 0) break;
        expect(page.rows.length).toBeLessThanOrEqual(size);
        seen.push(...page.rows.map((r) => r.id));
        after = page.rows[page.rows.length - 1].id;
      }
      expect(seen, `page size ${size}`).toEqual(ids);
    }
    // A limit below 1 is one row; app_user still sees no business row directly (RLS without a tenant).
    expect((await asAppUser((c) => c.query('SELECT * FROM list_business_ids(NULL, 0)'))).rows).toHaveLength(1);
    expect((await asAppUser((c) => c.query('SELECT count(*)::int AS n FROM business'))).rows[0].n).toBe(0);
  });

  // ---------------------------------------------------------------- 4. purges
  it('4. the purge functions delete only rows older than the cut-off, across businesses, and return the counts', async () => {
    const a = await createBusiness('A');
    const b = await createBusiness('B');
    const ma = await member(a);
    const mb = await member(b);
    const cut = new Date('2026-07-01T00:00:00Z');
    await asAdmin(async (c) => {
      for (const [biz, m] of [[a, ma], [b, mb]]) {
        for (const [key, at] of [['old1', '2026-06-01T00:00:00Z'], ['old2', '2026-06-30T23:59:59Z'], ['new', '2026-07-01T00:00:00Z']]) {
          await c.query(
            "INSERT INTO notification (business_id, type, recipient_membership_id, channel, data, status, sent_at, dedupe_key, created_at) VALUES ($1, 'sale.flagged', $2, 'IN_APP', '{}', 'SENT', $3, $4, $3)",
            [biz, m, at, key],
          );
        }
      }
      for (const at of ['2026-06-01T00:00:00Z', '2026-07-02T00:00:00Z']) {
        await c.query("INSERT INTO error_event (source, code, business_id, created_at) VALUES ('f1', 'TEST', $1, $2)", [a, at]);
      }
      await c.query("INSERT INTO error_event (source, code, created_at) VALUES ('f1', 'TEST', '2026-01-01T00:00:00Z')");
    });
    const purge = (fn: string) => asAppUser(async (c) => Number((await c.query<{ n: string }>(`SELECT ${fn}($1) AS n`, [cut])).rows[0].n));
    expect(await purge('purge_old_notifications')).toBe(4);
    expect(await purge('purge_old_error_events')).toBe(2);
    const left = await asAdmin(async (c) => ({
      notifications: (await c.query('SELECT business_id, dedupe_key FROM notification ORDER BY business_id')).rows,
      errors: (await c.query('SELECT created_at FROM error_event')).rows.map((r) => (r.created_at as Date).toISOString()),
    }));
    expect(left.notifications).toEqual([a, b].sort().map((biz) => ({ business_id: biz, dedupe_key: 'new' })));
    expect(left.errors).toEqual(['2026-07-02T00:00:00.000Z']);
    expect(await purge('purge_old_notifications')).toBe(0);
  });

  // ---------------------------------------------------------------- 5. pg-boss and the worker
  it('5a. the worker refuses to start without QUEUE_DATABASE_URL; pg-boss starts and stops as queue_user', async () => {
    await expect(createWorker(WorkerModule, loadConfig({ ...TEST_ENV }), { nestLogs: false })).rejects.toThrow(/queueDatabaseUrl/);
    const worker = await startWorker();
    const name = `f1.ping.${randomUUID()}`;
    const handled: string[] = [];
    await worker.queue.work<{ n: number }>(name, async (_data, id) => {
      handled.push(id);
    });
    const id = await worker.queue.send(name, { n: 1 });
    await waitFor(() => handled.length === 1, 'the job');
    expect(handled).toEqual([id]);
    await worker.shutdown();
    await worker.shutdown(); // twice is safe
    const roles = await asAdmin(
      async (c) =>
        (await c.query<{ usename: string }>("SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = 'aberdare_test' AND application_name LIKE 'pgboss%'")).rows,
    );
    expect(roles).toEqual([]); // the pool is closed
    expect(worker.lines()).toContain('"msg":"job done"');
    expect(worker.lines()).not.toContain('"n":1'); // job data never logged
  });

  it('5b. concurrency: two worker instances process 20 jobs, each exactly once', async () => {
    const [w1, w2] = [await startWorker(), await startWorker()];
    const name = `f1.load.${randomUUID()}`;
    const handled: { worker: number; id: string }[] = [];
    try {
      for (const [i, w] of [w1, w2].entries()) {
        await w.queue.work<{ n: number }>(name, async (_data, id) => {
          handled.push({ worker: i + 1, id });
          await new Promise((r) => setTimeout(r, 20));
        });
      }
      const ids = new Set<string | null>();
      for (let n = 0; n < 20; n++) ids.add(await w1.queue.send(name, { n }));
      await waitFor(() => handled.length >= 20, '20 jobs');
      await new Promise((r) => setTimeout(r, 1500)); // a late duplicate would show up here
      expect(handled).toHaveLength(20);
      expect(new Set(handled.map((h) => h.id))).toEqual(ids);
      const states = await asAdmin(async (c) => (await c.query('SELECT state, count(*)::int AS n FROM pgboss.job WHERE name = $1 GROUP BY 1', [name])).rows);
      expect(states).toEqual([{ state: 'completed', n: 20 }]);
    } finally {
      await w1.shutdown();
      await w2.shutdown();
    }
  });

  it('5c. shutdown lets the running job finish before the worker stops (the SIGTERM path)', async () => {
    const worker = await startWorker();
    const name = `f1.slow.${randomUUID()}`;
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await worker.queue.work<object>(name, async () => {
      events.push('job started');
      await gate;
      events.push('job finished');
    });
    const id = await worker.queue.send(name, {});
    await waitFor(() => events.includes('job started'), 'the job to start');
    const stopped = worker.shutdown().then(() => events.push('worker stopped'));
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toEqual(['job started']); // still waiting for the job
    release();
    await stopped;
    expect(events).toEqual(['job started', 'job finished', 'worker stopped']);
    const state = await asAdmin(async (c) => (await c.query('SELECT state FROM pgboss.job WHERE id = $1', [id])).rows[0].state);
    expect(state).toBe('completed');
  });
});
