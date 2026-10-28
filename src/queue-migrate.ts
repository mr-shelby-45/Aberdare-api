import { existsSync } from 'node:fs';
import { migrateQueueSchema } from './jobs/queue-schema.js';

// `pnpm queue:migrate`: creates or upgrades pg-boss's tables as the migration
// role (MIGRATION_DATABASE_URL). Run it after every `prisma migrate deploy`
// (Phase F1, docs/phase-f-design.md section 3). Real environment variables win
// over .env, as in main.ts.
if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
await migrateQueueSchema(url);
