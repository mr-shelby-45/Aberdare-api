// Phone and email normalisation (CLAUDE.md section 6: always E.164 before
// comparing or storing).

/**
 * Kenyan mobile numbers to E.164: "0712 345 678", "254712345678" and
 * "+254712345678" all become "+254712345678". Kenya only for now; anything
 * else returns null.
 */
export function normalizeKenyanPhone(input: string): string | null {
  const s = input.replace(/[\s-]/g, '');
  if (/^\+254[17]\d{8}$/.test(s)) return s;
  if (/^254[17]\d{8}$/.test(s)) return `+${s}`;
  if (/^0[17]\d{8}$/.test(s)) return `+254${s.slice(1)}`;
  return null;
}

/** Trimmed and lowercased. Validity is checked by the DTO (@IsEmail). */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
