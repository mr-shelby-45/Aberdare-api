import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/app.config.js';
import { IdentityLookup } from '../src/database/identity-lookup.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { ChallengeService } from '../src/modules/auth/challenge.service.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { normalizeEmail, normalizeKenyanPhone } from '../src/common/validation/contact.js';
import { TEST_ENV, type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, createBusiness, resetTables } from './helpers/db.js';
import { prismaWithPool } from './helpers/prisma.js';

// Phase A2: codes and signup (docs/phase-a-design.md sections 6, 7, 10, 19).
// Numbers in test names refer to the A2 list in section 19.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let phoneSeq = 0;
/** A fresh Kenyan mobile for each use, so send limits never collide. */
function newPhone(): string {
  phoneSeq += 1;
  return `+2547${String(10_000_000 + phoneSeq).slice(-8)}`;
}
const newEmail = () => `owner-${randomUUID().slice(0, 8)}@example.com`;

describe('A2: codes and signup', { timeout: 30_000 }, () => {
  let t: TestApp;
  let sms: FakeSmsSender;
  let mail: FakeEmailSender;

  beforeAll(async () => {
    t = await startTestApp();
    sms = t.app.get(SmsSender) as FakeSmsSender;
    mail = t.app.get(EmailSender) as FakeEmailSender;
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    sms.outbox.length = 0;
    mail.outbox.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const post = (url: string, payload: object, remoteAddress = '198.51.100.10') =>
    t.app.inject({ method: 'POST', url, payload, remoteAddress });

  /** The code in the latest message sent to `to` (as the app normalises it). */
  function lastCode(outbox: { to: string; message: string }[], to: string): string {
    const target = normalizeKenyanPhone(to) ?? normalizeEmail(to);
    const msg = [...outbox].reverse().find((m) => m.to === target);
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${to}`);
    return code;
  }

  const start = (phone: string, email: string) => post('/v1/auth/signup/start', { phone, email });

  async function verify(phone: string, email: string, codes?: { phone?: string; email?: string }) {
    return post('/v1/auth/signup/verify', {
      phone,
      email,
      phone_code: codes?.phone ?? lastCode(sms.outbox, phone),
      email_code: codes?.email ?? lastCode(mail.outbox, email),
    });
  }

  async function signupToken(phone: string, email: string): Promise<string> {
    expect((await start(phone, email)).statusCode).toBe(202);
    const res = await verify(phone, email);
    expect(res.statusCode).toBe(200);
    return (res.json() as { signup_token: string }).signup_token;
  }

  const completeBody = (token: string, overrides: Record<string, unknown> = {}) => ({
    signup_token: token,
    owner_name: 'Amina Wanjiru',
    business_name: 'Duka la Amina',
    business_type: 'RETAIL',
    password: 'mango-tree-42-river',
    pin: '4826',
    device: { name: "Amina's phone", platform: 'android' },
    ...overrides,
  });

  const complete = (token: string, overrides: Record<string, unknown> = {}) =>
    post('/v1/auth/signup', completeBody(token, overrides));

  async function fullSignup(phone = newPhone(), email = newEmail()) {
    const res = await complete(await signupToken(phone, email));
    expect(res.statusCode).toBe(201);
    return { phone, email, body: res.json() as Record<string, unknown> & { membership: Record<string, string> } };
  }

  const challengeRows = (target: string) =>
    asAdmin(async (c) =>
      (
        await c.query<{ id: string; code_hash: string; attempts: number; verified_at: Date | null; consumed_at: Date | null }>(
          'SELECT id, code_hash, attempts, verified_at, consumed_at FROM otp_challenge WHERE target = $1 ORDER BY created_at',
          [target],
        )
      ).rows,
    );

  const count = (sql: string, params: unknown[] = []) =>
    asAdmin(async (c) => Number((await c.query<{ n: string }>(sql, params)).rows[0].n));

  describe('a successful signup', () => {
    it('creates person, business, owner membership, device and tokens, and returns them once', async () => {
      const { phone, email, body } = await fullSignup('0712 345 678', 'Amina@Example.COM');
      const phoneE164 = '+254712345678';

      expect(Object.keys(body).sort()).toEqual(['access_token', 'device_id', 'device_secret', 'membership', 'refresh_token']);
      expect(body.membership).toEqual({
        id: expect.any(String),
        business_id: expect.any(String),
        role_preset: 'OWNER',
        display_name: 'Amina Wanjiru',
      });

      // Stored at the test-only scrypt cost (startTestApp); the production cost is
      // checked in test/password-hasher.spec.ts.
      const db = await asAdmin(async (c) => ({
        person: (
          await c.query(
            `SELECT phone, email, phone_verified_at IS NOT NULL AS pv, email_verified_at IS NOT NULL AS ev,
                    password_hash LIKE 'scrypt$1024$8$1$%' AS scrypt FROM person`,
          )
        ).rows,
        business: (await c.query('SELECT id, name, type FROM business')).rows,
        membership: (await c.query("SELECT role_preset, status, pin_hash LIKE 'scrypt$1024$8$1$%' AS scrypt FROM membership")).rows,
        device: (await c.query('SELECT id, secret_hash, status, platform FROM device')).rows,
        refresh: (await c.query('SELECT token_hash FROM refresh_token')).rows,
      }));
      expect(db.person).toEqual([{ phone: phoneE164, email: 'amina@example.com', pv: true, ev: true, scrypt: true }]);
      expect(db.business).toEqual([{ id: body.membership.business_id, name: 'Duka la Amina', type: 'RETAIL' }]);
      expect(db.membership).toEqual([{ role_preset: 'OWNER', status: 'ACTIVE', scrypt: true }]);
      expect(db.device).toEqual([{ id: body.device_id, secret_hash: sha(body.device_secret as string), status: 'ACTIVE', platform: 'android' }]);
      expect(db.refresh).toEqual([{ token_hash: sha(body.refresh_token as string) }]);

      // The access token carries ids only (no permissions, no names), for 15 minutes.
      const claims = new JwtService().decode(body.access_token as string) as Record<string, unknown>;
      expect(Object.keys(claims).sort()).toEqual(['aud', 'bid', 'did', 'exp', 'iat', 'mid', 'sub']);
      expect(claims).toMatchObject({ aud: 'access', bid: body.membership.business_id, mid: body.membership.id, did: body.device_id });
      expect((claims.exp as number) - (claims.iat as number)).toBe(15 * 60);
      expect([phone, email]).toEqual(['0712 345 678', 'Amina@Example.COM']);
    });

    it('rejects a password equal to the email, its local part or the phone, before writing anything', async () => {
      const phone = newPhone(); // +2547XXXXXXXX
      const email = newEmail(); // owner-xxxxxxxx@example.com, local part 14 characters
      const token = await signupToken(phone, email);
      // Every candidate is 10+ characters, so only the personal-data rule can reject it.
      for (const password of [email, email.toUpperCase(), email.split('@')[0], phone, phone.slice(1), `0${phone.slice(4)}`]) {
        const res = await complete(token, { password });
        expect(res.statusCode, password).toBe(422);
        expect(res.json(), password).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      }
      expect(await count('SELECT count(*) AS n FROM person')).toBe(0);
      // The token was not used up by the refusals.
      expect((await complete(token)).statusCode).toBe(201);
    });
  });

  it('1. codes are stored hashed; no plaintext code appears in any table or log line', async () => {
    const phone = newPhone();
    const email = newEmail();
    expect((await start(phone, email)).statusCode).toBe(202);
    const smsCode = lastCode(sms.outbox, phone);
    const emailCode = lastCode(mail.outbox, email);

    const rows = await asAdmin(async (c) => (await c.query('SELECT * FROM otp_challenge')).rows);
    expect(rows).toHaveLength(2);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(smsCode);
    expect(everything).not.toContain(emailCode);
    for (const r of rows as { code_hash: string }[]) expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);

    await verify(phone, email);
    expect(t.rawLogs()).not.toContain(smsCode);
    expect(t.rawLogs()).not.toContain(emailCode);
  });

  describe('2. wrong, expired, sixth, reused and concurrent attempts', () => {
    it('a wrong code is refused without saying which one', async () => {
      const phone = newPhone();
      const email = newEmail();
      await start(phone, email);
      const res = await verify(phone, email, { phone: '000000' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'OTP_INVALID', message: 'The codes are not correct.' } });
    });

    it('an expired code is refused (SMS codes live 5 minutes)', async () => {
      const phone = newPhone();
      const email = newEmail();
      await start(phone, email);
      t.clock.advanceMinutes(6);
      const res = await verify(phone, email);
      expect(res.json()).toMatchObject({ error: { code: 'OTP_EXPIRED' } });
    });

    it('the right code on the sixth attempt is refused', async () => {
      const phone = newPhone();
      const email = newEmail();
      await start(phone, email);
      for (let i = 0; i < 5; i++) {
        expect((await verify(phone, email, { phone: '000000' })).statusCode).toBe(400);
      }
      const sixth = await verify(phone, email);
      expect(sixth.statusCode).toBe(400);
      expect(sixth.json()).toMatchObject({ error: { code: 'OTP_INVALID' } });
      expect((await challengeRows(phone))[0]).toMatchObject({ attempts: 6, verified_at: null });
    });

    it('a code cannot be used again after signup', async () => {
      const phone = newPhone();
      const email = newEmail();
      const token = await signupToken(phone, email);
      expect((await complete(token)).statusCode).toBe(201);
      const again = await verify(phone, email);
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ error: { code: 'OTP_INVALID' } });
    });

    it('20 parallel wrong guesses count exactly 20', async () => {
      const phone = newPhone();
      await start(phone, newEmail());
      const challenges = t.app.get(ChallengeService);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          challenges.verify({ channel: 'SMS', target: phone, purpose: 'SIGNUP' }, '000000'),
        ),
      );
      expect(results.every((r) => r.outcome !== 'VERIFIED')).toBe(true);
      expect((await challengeRows(phone))[0].attempts).toBe(20);
    });
  });

  describe('3. send limits', () => {
    const startStatus = async (phone: string, email: string) => {
      const res = await start(phone, email);
      return res.statusCode === 202 ? 202 : (res.json() as { error: { code: string } }).error.code;
    };

    it('60 seconds between sends, then at most 5 an hour and 10 a day per target', async () => {
      const phone = newPhone();
      const email = newEmail();
      expect(await startStatus(phone, email)).toBe(202);
      expect(await startStatus(phone, email)).toBe('OTP_RATE_LIMITED'); // too soon

      for (let i = 2; i <= 5; i++) {
        t.clock.advance(61_000);
        expect(await startStatus(phone, email), `send ${i}`).toBe(202);
      }
      t.clock.advance(61_000);
      expect(await startStatus(phone, email)).toBe('OTP_RATE_LIMITED'); // 6th in the hour

      t.clock.advanceMinutes(60);
      for (let i = 6; i <= 10; i++) {
        t.clock.advance(61_000);
        expect(await startStatus(phone, email), `send ${i}`).toBe(202);
      }
      t.clock.advanceMinutes(60);
      expect(await startStatus(phone, email)).toBe('OTP_RATE_LIMITED'); // 11th in the day
      expect(await count('SELECT count(*) AS n FROM otp_challenge WHERE target = $1', [phone])).toBe(10);
    });

    it('a per-IP limit applies to the public auth routes', async () => {
      const limited = await startTestApp({ AUTH_RATE_LIMIT_MAX: '3' });
      try {
        const call = (ip: string) =>
          limited.app.inject({
            method: 'POST',
            url: '/v1/auth/signup/start',
            payload: { phone: newPhone(), email: newEmail() },
            remoteAddress: ip,
          });
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await call('203.0.113.5')).statusCode);
        expect(statuses).toEqual([202, 202, 202, 429]);
        expect((await call('203.0.113.6')).statusCode).toBe(202);
      } finally {
        await limited.app.close();
      }
    });
  });

  it('4. signup/start answers identically for a new, a known and an unverified phone or email', async () => {
    const known = await fullSignup();
    const invitee = newPhone();
    await t.app.get(IdentityLookup).ensurePerson(invitee, t.clock.now());
    t.clock.advance(61_000);

    const answers = [];
    for (const [phone, email] of [
      [newPhone(), newEmail()],
      [known.phone, known.email],
      [invitee, newEmail()],
    ]) {
      const res = await start(phone, email);
      answers.push({ status: res.statusCode, body: res.json() });
    }
    expect(answers).toEqual([
      { status: 202, body: { status: 'CODES_SENT' } },
      { status: 202, body: { status: 'CODES_SENT' } },
      { status: 202, body: { status: 'CODES_SENT' } },
    ]);
  });

  describe('5. the signup token', () => {
    it('is refused when expired', async () => {
      const token = await signupToken(newPhone(), newEmail());
      t.clock.advanceMinutes(11);
      const res = await complete(token);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
    });

    it('is refused when tampered', async () => {
      const token = await signupToken(newPhone(), newEmail());
      const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
      expect((await complete(tampered)).json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
    });

    it('is refused when replayed after a successful signup', async () => {
      const token = await signupToken(newPhone(), newEmail());
      expect((await complete(token)).statusCode).toBe(201);
      const replay = await complete(token);
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
    });

    it('is refused when it is a token made for another purpose (an access token)', async () => {
      const { body } = await fullSignup();
      expect((await complete(body.access_token as string)).json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
    });

    it("is refused when correctly signed but paired with someone else's challenges", async () => {
      const victimPhone = newPhone();
      const victimEmail = newEmail();
      await signupToken(victimPhone, victimEmail); // victim's codes verified, not yet used
      const [victimSms] = await challengeRows(victimPhone);
      const [victimMail] = await challengeRows(victimEmail);

      // A validly signed token claiming the victim's proofs for another phone.
      // Dated by the app's (fake) clock, so only the challenge check can refuse it.
      const iat = Math.floor(t.clock.now().getTime() / 1000);
      const forged = await new JwtService().signAsync(
        { pc: victimSms.id, ec: victimMail.id, ph: newPhone(), em: victimEmail, iat, exp: iat + 600 },
        { secret: TEST_ENV.JWT_SECRET, algorithm: 'HS256', audience: 'signup' },
      );
      const res = await complete(forged);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
      expect(await count('SELECT count(*) AS n FROM person')).toBe(0);
    });
  });

  it('6. signup is atomic: a failure after the business insert leaves nothing, and the codes stay usable', async () => {
    const phone = newPhone();
    const email = newEmail();
    const token = await signupToken(phone, email);
    vi.spyOn(t.app.get(DevicesService), 'register').mockRejectedValueOnce(new Error('simulated crash'));

    const failed = await complete(token);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    for (const table of ['person', 'business', 'membership', 'device', 'refresh_token']) {
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect(await count('SELECT count(*) AS n FROM otp_challenge WHERE consumed_at IS NOT NULL')).toBe(0);

    // Nothing was consumed, so the same token still completes the signup.
    expect((await complete(token)).statusCode).toBe(201);
  });

  describe('7. ACCOUNT_EXISTS appears only after both codes are proven', () => {
    it('for a phone that already has an account', async () => {
      const existing = await fullSignup();
      t.clock.advance(61_000);
      const email = newEmail();
      expect((await start(existing.phone, email)).statusCode).toBe(202);
      expect((await verify(existing.phone, email, { phone: '000000' })).json()).toMatchObject({ error: { code: 'OTP_INVALID' } });
      const res = await complete(await (async () => {
        const v = await verify(existing.phone, email);
        return (v.json() as { signup_token: string }).signup_token;
      })());
      expect({ status: res.statusCode, body: res.json() }).toMatchObject({ status: 409, body: { error: { code: 'ACCOUNT_EXISTS' } } });
    });

    it('for an email that already belongs to someone else', async () => {
      const existing = await fullSignup();
      t.clock.advance(61_000);
      const res = await complete(await signupToken(newPhone(), existing.email));
      expect({ status: res.statusCode, body: res.json() }).toMatchObject({ status: 409, body: { error: { code: 'ACCOUNT_EXISTS' } } });
    });
  });

  it('8. a person first invited as staff can sign up as an owner and keeps their memberships', async () => {
    const phone = newPhone();
    const elsewhere = await createBusiness('Duka Lingine');
    const prisma = prismaWithPool(2);
    try {
      const identity = new IdentityLookup(prisma);
      const tenants = new TenantRunner(prisma);
      const invited = await identity.ensurePerson(phone, t.clock.now());
      await tenants.run(elsewhere, () =>
        currentTx().membership.create({
          data: { businessId: elsewhere, personId: invited.personId, displayName: 'Baraka', rolePreset: 'ATTENDANT', status: 'INVITED' },
        }),
      );

      await fullSignup(phone, newEmail());
      const rows = await asAdmin(async (c) =>
        (
          await c.query<{ id: string; memberships: string; pv: boolean }>(
            `SELECT p.id, (SELECT count(*) FROM membership m WHERE m.person_id = p.id) AS memberships,
                    p.phone_verified_at IS NOT NULL AS pv
             FROM person p WHERE p.phone = $1`,
            [phone],
          )
        ).rows,
      );
      expect(rows).toEqual([{ id: invited.personId, memberships: '2', pv: true }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  describe('9. configuration', () => {
    it('refuses to start in production with fixed dev codes on', () => {
      expect(() => loadConfig({ ...TEST_ENV, APP_ENV: 'production', AUTH_DEV_FIXED_CODES: 'true' })).toThrow(
        /authDevFixedCodes must be off in production/,
      );
    });

    it('refuses to start when the JWT secret or pepper is missing or too short', () => {
      expect(() => loadConfig({ ...TEST_ENV, AUTH_PEPPER: '' })).toThrow(/Invalid configuration: authPepper/);
      expect(() => loadConfig({ ...TEST_ENV, JWT_SECRET: 'short' })).toThrow(/Invalid configuration: jwtSecret/);
      const { AUTH_PEPPER: _p, JWT_SECRET: _j, ...rest } = TEST_ENV;
      expect(() => loadConfig(rest)).toThrow(/Invalid configuration: authPepper, jwtSecret/);
    });

    it('fixed dev codes apply only to allowlisted targets outside production', async () => {
      const listed = '+254700123456';
      const dev = await startTestApp({ APP_ENV: 'development', AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: `${listed}, dev@example.com` });
      try {
        const devSms = dev.app.get(SmsSender) as FakeSmsSender;
        const unlisted = newPhone();
        for (const phone of [listed, unlisted]) {
          await dev.app.inject({ method: 'POST', url: '/v1/auth/signup/start', payload: { phone, email: newEmail() } });
        }
        expect(lastCode(devSms.outbox, listed)).toBe('123456');
        expect(lastCode(devSms.outbox, unlisted)).not.toBe('123456');
      } finally {
        await dev.app.close();
      }
    });
  });

  it('errors from these routes use the standard error shape', async () => {
    const res = await post('/v1/auth/signup/verify', { phone: '0711', email: 'x@example.com', phone_code: '1', email_code: '2' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: expect.any(String), requestId: res.headers['x-request-id'], timestamp: expect.stringMatching(ISO_UTC) },
    });
  });
});
