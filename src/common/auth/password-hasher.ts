import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppConfig } from '../../config/app.config.js';

const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// OWASP's scrypt minimum, in the variant that needs the least memory per hash
// (32 MiB). Chosen by Ian in A2; measured about 430 ms per hash on the dev
// machine. Stored with every hash, so it can be raised later.
export const PRODUCTION_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Hashes passwords and PINs: HMAC-SHA256 with the server pepper first, then
// scrypt. Stored as scrypt$N$r$p$salt$hash (salt and hash base64url).
@Injectable()
export class PasswordHasher {
  /**
   * The cost of new hashes. Always the production value in the app: there is
   * no setting for it. Only the test helpers replace it, with a test-only
   * subclass (test/helpers/fast-password-hasher.ts), to keep the suite fast.
   */
  protected readonly params: ScryptParams = PRODUCTION_SCRYPT_PARAMS;

  constructor(private readonly config: AppConfig) {}

  async hash(secret: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const { N, r, p } = this.params;
    const key = await this.derive(secret, salt, this.params);
    return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
  }

  /** Constant-time check. False for any malformed stored value. */
  async verify(secret: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (![N, r, p].every(Number.isSafeInteger)) return false;
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = await this.derive(secret, salt, { N, r, p }, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /**
   * The same work as a real check, for an unknown account, so a missing email
   * takes as long as a wrong password (docs/phase-a-design.md section 10).
   */
  async dummyVerify(secret: string): Promise<false> {
    await this.derive(secret, randomBytes(SALT_BYTES), this.params);
    return false;
  }

  private derive(
    secret: string,
    salt: Buffer,
    params: { N: number; r: number; p: number },
    keyBytes = KEY_BYTES,
  ): Promise<Buffer> {
    const peppered = createHmac('sha256', this.config.authPepper).update(secret, 'utf8').digest();
    // scrypt needs 128 * N * r bytes; give it twice that so Node never refuses.
    const maxmem = 2 * 128 * params.N * params.r;
    return scryptAsync(peppered, salt, keyBytes, { ...params, maxmem });
  }
}
