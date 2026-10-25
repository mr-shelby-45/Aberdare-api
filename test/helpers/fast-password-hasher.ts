import { PasswordHasher, type ScryptParams } from '../../src/common/auth/password-hasher.js';

/**
 * Tests only (approved by Ian before B3): the same hasher with a far lower
 * scrypt cost, about 4 ms per hash instead of about 400 ms. Everything else
 * (pepper, format, constant-time check, dummy verify) is the production code.
 * test/password-hasher.spec.ts checks that the real app still uses the
 * production cost.
 */
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 10, r: 8, p: 1 };

export class FastPasswordHasher extends PasswordHasher {
  protected override readonly params = TEST_SCRYPT_PARAMS;
}
