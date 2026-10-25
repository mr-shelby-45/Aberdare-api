// Money in JSON (docs/phase-b-design.md section 4): KES as a string with up to
// 12 integer digits and up to 2 decimals. Numbers, negatives, ".5", "1e3",
// three decimals and longer values are refused. Never parsed into a
// JavaScript number: the database stores NUMERIC(14,2) (CLAUDE.md rule 7).
export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * The canonical form with two decimals, by string work only:
 * "180" -> "180.00", "0.5" -> "0.50", "007.1" -> "7.10".
 * The input must already match MONEY_PATTERN.
 */
export function normalizeMoney(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}
