import { existsSync } from 'node:fs';
import { PgBoss } from 'pg-boss';
import { createWorkerLogger } from './common/logging/worker-logger.js';
import { SWEEP_QUEUE } from './jobs/notification-jobs.service.js';
import { QUEUE_SCHEMA } from './jobs/queue-schema.js';
import { SCHEDULES } from './jobs/scheduled-jobs.service.js';

// `pnpm job:run <name>` (Phase F6): enqueues one run of a scheduled job now,
// for the running worker to pick up (the walkthrough, and support). Only the
// scheduled jobs' names are accepted. It connects as queue_user
// (QUEUE_DATABASE_URL), like the worker; it never touches business data.
if (existsSync('.env')) process.loadEnvFile('.env');
const log = createWorkerLogger(process.env.LOG_LEVEL ?? 'info');
const allowed = [...Object.keys(SCHEDULES), SWEEP_QUEUE];
const name = process.argv[2];
if (!name || !allowed.includes(name)) {
  log.error({ allowed }, 'usage: pnpm job:run <job name>');
  process.exit(2);
}
const connectionString = process.env.QUEUE_DATABASE_URL;
if (!connectionString) throw new Error('QUEUE_DATABASE_URL is not set');
const boss = new PgBoss({ connectionString, schema: QUEUE_SCHEMA, createSchema: false, migrate: false, supervise: false, schedule: false, registerInstance: false, max: 1 });
boss.on('error', () => undefined);
await boss.start();
const jobId = await boss.send(name, {});
await boss.stop({ graceful: false, close: true });
log.info({ job: name, jobId }, 'job enqueued');
