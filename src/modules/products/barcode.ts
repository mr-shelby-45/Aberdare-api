// Barcode rules (docs/phase-b-design.md section 4). A barcode is text, never a
// number: leading zeros matter. Applied on every write and every lookup.
const BARCODE_PATTERN = /^[A-Za-z0-9._-]{4,48}$/;

/**
 * Trims, and gives a 12-digit numeric code a leading 0 (UPC-A equals EAN-13
 * with a leading zero). Check digits are not validated and case is not
 * changed. Returns null when the result is not a valid barcode (bad
 * characters, inner spaces, fewer than 4 or more than 48 characters).
 */
export function normalizeBarcode(raw: string): string | null {
  const code = raw.trim();
  const full = /^\d{12}$/.test(code) ? `0${code}` : code;
  return BARCODE_PATTERN.test(full) ? full : null;
}
