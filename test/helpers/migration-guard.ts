import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Indexes created by hand-written migrations. Prisma's diff may try to drop
// these (it did for the trigram index, see docs/spike-results.md step 4).
export const HAND_WRITTEN_INDEXES = [
  'product_name_trgm_idx',
  'pack_type_one_base_unit_per_product',
  'membership_one_owner_per_business',
];

// SQL that removes or weakens objects Prisma does not manage.
const DESTRUCTIVE = [
  /\bDROP\s+POLICY\b/i,
  /\bALTER\s+POLICY\b/i,
  /\bDROP\s+TRIGGER\b/i,
  /\bDISABLE\s+TRIGGER\b/i,
  /\bDROP\s+FUNCTION\b/i,
  /\bDROP\s+EXTENSION\b/i,
  /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  ...HAND_WRITTEN_INDEXES.map(
    (name) => new RegExp(`\\bDROP\\s+INDEX\\b[^;]*\\b${name}\\b`, 'i'),
  ),
];

// A migration that really means to do one of the above says so on purpose.
const ALLOW_MARKER = /^--\s*allow-destructive:\s*\S/m;

/** The destructive statements in one migration's SQL, unless it is marked as intended. */
export function findDestructiveStatements(sql: string): string[] {
  if (ALLOW_MARKER.test(sql)) return [];
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => DESTRUCTIVE.some((pattern) => pattern.test(statement)));
}

/** Every migration.sql under prisma/migrations, by folder name. */
export function readMigrations(root = 'prisma/migrations'): { name: string; sql: string }[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(root, entry.name, 'migration.sql'), 'utf8'),
    }));
}
