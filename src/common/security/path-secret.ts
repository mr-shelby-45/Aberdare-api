import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time check of a secret taken from a URL path. Both sides are hashed
 * first, so they always have the same length and timingSafeEqual never reveals
 * the length of the real secret.
 */
export function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
