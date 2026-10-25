import { PRODUCTION_SCRYPT_PARAMS, PasswordHasher } from '../src/common/auth/password-hasher.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/app.config.js';
import { createApp } from '../src/create-app.js';
import { TEST_ENV } from './helpers/app.js';
import { FastPasswordHasher, TEST_SCRYPT_PARAMS } from './helpers/fast-password-hasher.js';

// The other tests use a lower scrypt cost for speed (test/helpers/
// fast-password-hasher.ts, approved by Ian before B3). This file proves the
// real app still hashes at the production cost chosen in A2.

describe('PasswordHasher: production cost', () => {
  const config = loadConfig(TEST_ENV);

  it('the production parameters are the ones Ian chose in A2: N=2^15, r=8, p=3', () => {
    expect(PRODUCTION_SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 3 });
  });

  it('the real class stores hashes at the production cost, and they verify', async () => {
    const hasher = new PasswordHasher(config);
    const stored = await hasher.hash('baobab-sunrise-73');
    expect(stored.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(await hasher.verify('baobab-sunrise-73', stored)).toBe(true);
    expect(await hasher.verify('baobab-sunrise-74', stored)).toBe(false);
  });

  it('the app built by createApp(), as main.ts builds it, uses exactly the production hasher', async () => {
    const app = await createApp(AppModule, config, { nestLogs: false });
    try {
      const hasher = app.get(PasswordHasher);
      expect(hasher.constructor).toBe(PasswordHasher);
      expect(hasher).not.toBeInstanceOf(FastPasswordHasher);
      expect((await hasher.hash('x')).startsWith('scrypt$32768$8$3$')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('hashes made at the test cost still verify with the real class (the format records its own cost)', async () => {
    const fast = await new FastPasswordHasher(config).hash('1357');
    expect(fast.startsWith(`scrypt$${TEST_SCRYPT_PARAMS.N}$8$1$`)).toBe(true);
    expect(await new PasswordHasher(config).verify('1357', fast)).toBe(true);
  });
});
