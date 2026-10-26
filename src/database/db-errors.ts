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

/**
 * The error code worth logging (Phase C1 housekeeping): the Postgres SQLSTATE
 * when there is one (for example "23505"), otherwise the error's own string
 * code (Prisma's "P2028" when no transaction could be started). Logged as
 * errorCode, because the field name "code" is redacted to protect one-time
 * codes.
 */
export function errorCodeForLog(err: unknown): string | undefined {
  const sqlState = postgresErrorCode(err);
  if (sqlState) return sqlState;
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** True when an insert or update hit a unique constraint. */
export function isUniqueViolation(err: unknown): boolean {
  return postgresErrorCode(err) === '23505';
}

/**
 * The name of the unique constraint (or unique index) a write violated, or
 * undefined for any other error. Prisma 7 with the pg adapter puts it at
 * meta.driverAdapterError.cause.constraint.index, for model calls (P2002) and
 * raw queries (P2010) alike (checked by a probe in Phase B2).
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  if (!isUniqueViolation(err)) return undefined;
  const meta = (err as { meta?: { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } } }).meta;
  const index = meta?.driverAdapterError?.cause?.constraint?.index;
  return typeof index === 'string' ? index : undefined;
}

/** True when a row referenced something that does not exist for this business. */
export function isForeignKeyViolation(err: unknown): boolean {
  return postgresErrorCode(err) === '23503';
}

/** True when a value did not fit its numeric column (for example a NUMERIC(14,2) sum above 999,999,999,999.99). */
export function isNumericOverflow(err: unknown): boolean {
  return postgresErrorCode(err) === '22003';
}
