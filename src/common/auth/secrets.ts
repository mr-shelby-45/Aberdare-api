import { createHash, randomBytes, randomInt } from 'node:crypto';

// Random values for codes and credentials. Never Math.random
// (docs/phase-a-design.md section 7).

/** A string of `length` random decimal digits, for SMS and email codes and temp PINs. */
export function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

/** A high-entropy credential (device secret, refresh token): 32 random bytes, base64url. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex. Only for high-entropy secrets (device secrets, refresh tokens), never for passwords or PINs. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
