import { MONEY_PATTERN } from '../validation/money.js';

// Exact money arithmetic for KES (CLAUDE.md rule 7), Phase E2: amounts as
// whole cents in a BigInt, never a JavaScript number. Strings in, strings
// out, matching NUMERIC(14,2) in the database.

/** The largest NUMERIC(14,2) value, 999,999,999,999.99, in cents. */
export const MAX_CENTS = 99_999_999_999_999n;

/** Cents of a money string ("180", "33.3", "0.05"), or null if it is not one (negative included). */
export function toCents(value: string): bigint | null {
  if (!MONEY_PATTERN.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** The canonical string with two decimals: 9999n -> "99.99", 5n -> "0.05". */
export function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
