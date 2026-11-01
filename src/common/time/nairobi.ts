// Africa/Nairobi calendar days (Phase G1, docs/phase-g1-design.md section 4).
// Kenya is UTC+3 all year and has no daylight saving, so a fixed offset is
// exact: a Nairobi day D runs from D 00:00 +03:00 (D - 1 21:00 UTC) up to,
// not including, D + 1 00:00 +03:00. SQL that groups by day uses
// (occurred_at AT TIME ZONE 'Africa/Nairobi')::date; the G1a date test
// checks that both agree at the midnight edge.

const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day as YYYY-MM-DD, or null if the text is not a real date (2026-02-30 is not). */
export function parseDay(text: string): string | null {
  const m = DATE.exec(text);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === text ? text : null;
}

/** The first instant of a Nairobi day (a YYYY-MM-DD from parseDay). */
export function nairobiDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - OFFSET_MS);
}

/** The first instant after a Nairobi day: the end of a half-open range. */
export function nairobiDayEnd(day: string): Date {
  return new Date(nairobiDayStart(day).getTime() + DAY_MS);
}

/** The Nairobi calendar day of an instant, as YYYY-MM-DD. */
export function nairobiDay(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days from day a to day b (both YYYY-MM-DD); negative when b is before a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}
