import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { migrateQueueSchema } from '../src/jobs/queue-schema.js';

// Runs once before all test files: applies every migration to the test
// database as migrator, exactly as a deploy would.
export default async function setup(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set');
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, MIGRATION_DATABASE_URL: url },
    stdio: 'inherit',
  });
  // pg-boss's own tables, as migrator, as a deploy does (pnpm queue:migrate; Phase F1).
  await migrateQueueSchema(url);
  await fastCommitsForTests(url);
}

/**
 * Test-only speed-up (approved by Ian before B3): commits in the test database
 * do not wait for the disk. A crash can lose the last few commits there, which
 * every test run wipes anyway; it cannot corrupt data. It is a setting on this
 * one database (not the server, not a migration), so dev and production never
 * get it, and it refuses to run on a database whose name does not end in _test.
 */
async function fastCommitsForTests(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    const db = rows[0].db;
    if (!db.endsWith('_test')) {
      throw new Error(`Refusing to change synchronous_commit on "${db}": not a test database`);
    }
    // Takes effect for every new connection, which is all the tests' connections.
    await client.query(`ALTER DATABASE ${client.escapeIdentifier(db)} SET synchronous_commit = off`);
  } finally {
    await client.end();
  }
}
