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
      `TRUNCATE sync_command, stock_conversion, stock_movement, stock_balance,
                pack_type, location, product, business CASCADE`,
    ),
  );
}

/** Creates a business (no RLS on business) and returns its id. */
export async function createBusiness(name: string): Promise<string> {
  return asMigrator(async (c) => {
    const res = await c.query<{ id: string }>(
      'INSERT INTO business (name) VALUES ($1) RETURNING id',
      [name],
    );
    return res.rows[0].id;
  });
}
