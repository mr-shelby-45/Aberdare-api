// Reads the Postgres SQLSTATE out of a Prisma 7 error. With the pg driver
// adapter it sits at meta.driverAdapterError.cause.originalCode for both raw
// queries (Prisma code P2010) and model calls (for example P2003), so this is
// the one reliable place to look (checked in spike step 3).
function postgresErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('meta' in err)) {
    return undefined;
  }
  const meta = (err as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }).meta;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === 'string' ? code : undefined;
}

/** True when an insert or update hit a unique constraint. */
export function isUniqueViolation(err: unknown): boolean {
  return postgresErrorCode(err) === '23505';
}

/** True when a row referenced something that does not exist for this business. */
export function isForeignKeyViolation(err: unknown): boolean {
  return postgresErrorCode(err) === '23503';
}
