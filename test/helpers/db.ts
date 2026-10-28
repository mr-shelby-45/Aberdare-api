import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Test-only helpers. They connect as migrator (the table owner) to set up and
// wipe data. The code under test always connects as app_user.

export async function asMigrator<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The postgres superuser, for seeding rows that no app role may write yet
 * (for example a person's email and password before the A2 signup function).
 * Never use it for anything under test.
 */
export async function asAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url) throw new Error('TEST_ADMIN_DATABASE_URL is not set (see .env.example)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A raw connection as app_user, for checks that must run on one known connection. */
export async function asAppUser<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Empties all spike tables. TRUNCATE is not subject to RLS and, as migrator,
 * is the only way rows of the append-only ledger are ever removed (tests only).
 */
export async function resetTables(): Promise<void> {
  await asMigrator((c) =>
    c.query(
      `TRUNCATE audit_log, otp_challenge, refresh_token, device_membership, device, membership, person,
                change_log, sync_command, stock_conversion, stock_movement,
                stock_balance, pack_type, location, product, business, error_event CASCADE`,
    ),
  );
  // Phase D1: the prune horizon back to "nothing removed".
  await asMigrator((c) => c.query(`UPDATE change_log_horizon SET pruned_through_txid = '0', pruned_through_id = 0`));
}

/**
 * Creates a business and returns its id. business has forced RLS on its own
 * id (Phase A1), so the id is generated first and set as the tenant before the
 * insert, the same way signup will do it.
 */
export async function createBusiness(name: string): Promise<string> {
  const id = randomUUID();
  await asMigrator(async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true)", [id]);
    await c.query("INSERT INTO business (id, name, type) VALUES ($1, $2, 'RETAIL')", [id, name]);
    await c.query('COMMIT');
  });
  return id;
}
