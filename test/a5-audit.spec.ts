import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PasswordHasher } from '../src/common/auth/password-hasher.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, createBusiness, resetTables } from './helpers/db.js';

// Phase A5: audit log and hardening (docs/phase-a-design.md sections 10, 14
// and 19). Numbers in test names refer to the A5 list in section 19.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const NEW_PASSWORD = 'jacaranda-rain-58';
const IP = '198.51.100.40';
let seq = 0;
const newPhone = () => `+2547${String(40_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `owner${++seq}@example.com`;

interface Owner {
  phone: string;
  email: string;
  businessId: string;
  membershipId: string;
  personId: string;
  deviceId: string;
  deviceSecret: string;
  accessToken: string;
  refreshToken: string;
  // Credentials seen on the way, for test 3.
  seen: string[];
}

interface AuditRow {
  action: string;
  actor_membership_id: string | null;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

describe('A5: audit log and hardening', { timeout: 120_000 }, () => {
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

  const tenants = () => t.app.get(TenantRunner, { strict: false });

  // ---------------------------------------------------------------- HTTP
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token?: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method,
      url,
      payload,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      remoteAddress: IP,
    });
  const post = (url: string, payload: object, token?: string) => call('POST', url, token, payload);
  const json = <T>(res: LightMyRequestResponse) => res.json() as T;
  /** What a caller can see: status, error code and message, and the body's keys. */
  const visible = (res: LightMyRequestResponse) => {
    const body = res.json() as { error?: { code: string; message: string } } & Record<string, unknown>;
    return {
      status: res.statusCode,
      code: body.error?.code,
      message: body.error?.message,
      keys: Object.keys(body).sort(),
    };
  };

  function lastCode(outbox: { to: string; message: string }[], to: string, containing = ''): string {
    const msg = [...outbox].reverse().find((m) => m.to === to && m.message.includes(containing));
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${to}`);
    return code;
  }

  // ---------------------------------------------------------------- seeding
  /** A real owner signup through the API. */
  async function signupOwner(name = 'Duka A'): Promise<Owner> {
    const phone = newPhone();
    const email = newEmail();
    expect((await post('/v1/auth/signup/start', { phone, email })).statusCode).toBe(202);
    const phoneCode = lastCode(sms.outbox, phone);
    const emailCode = lastCode(mail.outbox, email);
    const verified = await post('/v1/auth/signup/verify', { phone, email, phone_code: phoneCode, email_code: emailCode });
    expect(verified.statusCode, JSON.stringify(verified.json())).toBe(200);
    const signupToken = json<{ signup_token: string }>(verified).signup_token;
    const res = await post('/v1/auth/signup', {
      signup_token: signupToken,
      owner_name: 'Amina',
      business_name: name,
      business_type: 'RETAIL',
      password: PASSWORD,
      pin: PIN,
      device: { name: "Owner's phone", platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const r = json<{
      device_id: string;
      device_secret: string;
      access_token: string;
      refresh_token: string;
      membership: { id: string; business_id: string };
    }>(res);
    const personId = await asAdmin(
      async (c) => (await c.query<{ id: string }>('SELECT id FROM person WHERE phone = $1', [phone])).rows[0].id,
    );
    // Later codes to the same phone or email must not hit the 60-second gap.
    t.clock.advanceMinutes(2);
    return {
      phone,
      email,
      personId,
      businessId: r.membership.business_id,
      membershipId: r.membership.id,
      deviceId: r.device_id,
      deviceSecret: r.device_secret,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      seen: [phoneCode, emailCode, signupToken, r.device_secret, r.access_token, r.refresh_token],
    };
  }

  /** Invite, first login and activation through the API: an ACTIVE attendant. */
  async function activeStaff(owner: Owner) {
    const phone = newPhone();
    const created = await post('/v1/staff', { phone, display_name: 'Baraka', role_preset: 'ATTENDANT' }, owner.accessToken);
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const { membership_id: membershipId, temp_pin: tempPin } = json<{ membership_id: string; temp_pin: string }>(created);
    const first = await post('/v1/auth/first-login', { phone, temp_pin: tempPin });
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
    const setupToken = json<{ setup_token: string }>(first).setup_token;
    const code = lastCode(sms.outbox, phone);
    const res = await post('/v1/auth/staff/activate', {
      setup_token: setupToken,
      code,
      new_pin: '6071',
      device: { name: 'Staff phone', platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const s = json<{ device_id: string; device_secret: string; access_token: string; refresh_token: string }>(res);
    return {
      phone,
      membershipId,
      deviceId: s.device_id,
      token: s.access_token,
      seen: [tempPin, setupToken, code, '6071', s.device_secret, s.access_token, s.refresh_token],
    };
  }

  const auditRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (
          await c.query<AuditRow>(
            `SELECT action, actor_membership_id, target_type, target_id, metadata, host(ip) AS ip
               FROM audit_log WHERE business_id = $1 ORDER BY occurred_at, action`,
            [businessId],
          )
        ).rows,
    );
  const rowsFor = async (businessId: string, action: string) =>
    (await auditRows(businessId)).filter((r) => r.action === action);

  const pinLogin = (o: Owner, pin: string) =>
    post('/v1/auth/pin', { device_id: o.deviceId, device_secret: o.deviceSecret, pin });

  // ---------------------------------------------------------------- 1. audit events
  describe('1. each event writes an audit row in the same transaction', () => {
    it('signup records business.signed_up and device.registered, by the owner, with the caller IP', async () => {
      const o = await signupOwner();
      const rows = await auditRows(o.businessId);
      // location.created: the default location, added to signup in Phase B1.
      expect(rows.map((r) => r.action).sort()).toEqual(['business.signed_up', 'device.registered', 'location.created']);
      expect(rows.find((r) => r.action === 'location.created')).toMatchObject({
        actor_membership_id: o.membershipId,
        target_type: 'location',
        metadata: { is_default: true },
        ip: IP,
      });
      const signedUp = rows.find((r) => r.action === 'business.signed_up')!;
      expect(signedUp).toMatchObject({
        actor_membership_id: o.membershipId,
        target_type: 'business',
        target_id: o.businessId,
        metadata: { business_type: 'RETAIL', new_person: true },
        ip: IP,
      });
      const device = rows.find((r) => r.action === 'device.registered')!;
      expect(device).toMatchObject({ actor_membership_id: o.membershipId, target_id: o.deviceId, metadata: { platform: 'android' } });
    });

    it('the staff lifecycle records every change, with the owner as actor', async () => {
      const o = await signupOwner();
      const s = await activeStaff(o);
      const id = s.membershipId;
      expect((await call('PATCH', `/v1/staff/${id}`, o.accessToken, { display_name: 'Baraka K', role_preset: 'MANAGER' })).statusCode).toBe(204);
      expect((await post(`/v1/staff/${id}/suspend`, {}, o.accessToken)).statusCode).toBe(204);
      expect((await post(`/v1/staff/${id}/reactivate`, {}, o.accessToken)).statusCode).toBe(204);
      expect((await post(`/v1/staff/${id}/reset-pin`, {}, o.accessToken)).statusCode).toBe(200);
      expect((await call('DELETE', `/v1/staff/${id}`, o.accessToken)).statusCode).toBe(204);

      const staffRows = (await auditRows(o.businessId)).filter((r) => r.action.startsWith('staff.'));
      expect(staffRows.map((r) => r.action).sort()).toEqual(
        ['staff.created', 'staff.pin_reset', 'staff.reactivated', 'staff.removed', 'staff.suspended', 'staff.updated'].sort(),
      );
      for (const r of staffRows) {
        expect(r).toMatchObject({ actor_membership_id: o.membershipId, target_type: 'membership', target_id: id, ip: IP });
      }
      expect(staffRows.find((r) => r.action === 'staff.created')!.metadata).toEqual({
        role_preset: 'ATTENDANT',
        extra_permissions: [],
        reinvited: false,
      });
      expect(staffRows.find((r) => r.action === 'staff.updated')!.metadata).toEqual({
        changed: ['display_name', 'role_preset'],
        role_preset: 'MANAGER',
      });
      // Activation registered the staff phone, by the staff member.
      const activation = (await rowsFor(o.businessId, 'device.registered')).find((r) => r.target_id === s.deviceId);
      expect(activation?.actor_membership_id).toBe(id);
    });

    it('device changes record shared_changed (only on a real change), member_added, member_removed and revoked', async () => {
      const o = await signupOwner();
      const s = await activeStaff(o);
      const d = s.deviceId;
      expect((await call('PATCH', `/v1/devices/${d}`, o.accessToken, { is_shared: true })).statusCode).toBe(204);
      expect((await call('PATCH', `/v1/devices/${d}`, o.accessToken, { is_shared: true, name: 'Till 1' })).statusCode).toBe(204);
      expect((await post(`/v1/devices/${d}/members`, { membership_id: s.membershipId }, o.accessToken)).statusCode).toBe(204);
      expect((await call('DELETE', `/v1/devices/${d}/members/${s.membershipId}`, o.accessToken)).statusCode).toBe(204);
      expect((await call('DELETE', `/v1/devices/${d}`, o.accessToken)).statusCode).toBe(204);

      const rows = (await auditRows(o.businessId)).filter((r) => r.target_id === d && r.action !== 'device.registered');
      expect(rows.map((r) => r.action).sort()).toEqual(
        ['device.member_added', 'device.member_removed', 'device.revoked', 'device.shared_changed'].sort(),
      );
      for (const r of rows) expect(r).toMatchObject({ actor_membership_id: o.membershipId, target_type: 'device' });
      expect(rows.find((r) => r.action === 'device.shared_changed')!.metadata).toEqual({ is_shared: true });
      expect(rows.find((r) => r.action === 'device.member_added')!.metadata).toEqual({ membership_id: s.membershipId });
    });

    it('PIN lockout records pin.locked as a system event: timed at 5 failures, for good at 10', async () => {
      const o = await signupOwner();
      for (let i = 0; i < 5; i++) expect((await pinLogin(o, '0000')).statusCode).toBe(401);
      let rows = await rowsFor(o.businessId, 'pin.locked');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_membership_id: null,
        target_id: o.membershipId,
        metadata: { lock: 'timed', failed_count: 5 },
      });

      t.clock.advanceMinutes(16);
      for (let i = 0; i < 5; i++) expect((await pinLogin(o, '0000')).statusCode).toBe(401);
      // Locked for good: further tries are not even counted, so no more rows.
      expect((await pinLogin(o, '0000')).statusCode).toBe(423);
      rows = await rowsFor(o.businessId, 'pin.locked');
      expect(rows.map((r) => r.metadata)).toEqual([
        { lock: 'timed', failed_count: 5 },
        { lock: 'for_good', failed_count: 10 },
      ]);
    });

    it('refresh token reuse records refresh_token.reuse_detected as a system event', async () => {
      const o = await signupOwner();
      expect((await post('/v1/auth/refresh', { refresh_token: o.refreshToken })).statusCode).toBe(200);
      expect((await post('/v1/auth/refresh', { refresh_token: o.refreshToken })).statusCode).toBe(401);
      const rows = await rowsFor(o.businessId, 'refresh_token.reuse_detected');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_membership_id: null, target_id: o.membershipId, ip: IP });
      expect(rows[0].metadata).toMatchObject({ device_id: o.deviceId });
      expect(rows[0].metadata.revoked_count).toBeGreaterThanOrEqual(1);
      expect(rows[0].metadata.family_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('a rolled-back action leaves no audit row (and no change)', async () => {
      const o = await signupOwner();
      const s = await activeStaff(o);
      const audit = t.app.get(AuditService, { strict: false });
      const original = audit.record.bind(audit);
      // Fails right after the audit row is written, inside the same request.
      vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
        await original(entry);
        throw new Error('crash after the audit write');
      });
      expect((await post(`/v1/staff/${s.membershipId}/suspend`, {}, o.accessToken)).statusCode).toBe(500);
      expect(await rowsFor(o.businessId, 'staff.suspended')).toEqual([]);
      const status = await asAdmin(
        async (c) => (await c.query<{ status: string }>('SELECT status FROM membership WHERE id = $1', [s.membershipId])).rows[0].status,
      );
      expect(status).toBe('ACTIVE');

      // The same at the service level.
      await expect(
        tenants().run(o.businessId, async () => {
          await audit.record({ action: 'staff.updated', targetType: 'membership', targetId: s.membershipId });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await rowsFor(o.businessId, 'staff.updated')).toEqual([]);
    });

    it('AuditService refuses metadata keys that look like secrets or contact details', async () => {
      const o = await signupOwner();
      const audit = t.app.get(AuditService, { strict: false });
      for (const key of ['temp_pin', 'refresh_token', 'device_secret', 'phone', 'email', 'otp_code', 'password_hash']) {
        await expect(
          tenants().run(o.businessId, () =>
            audit.record({ action: 'staff.updated', targetType: 'membership', targetId: null, metadata: { [key]: 'x' } }),
          ),
        ).rejects.toThrow(/looks like a secret/);
      }
      expect(await rowsFor(o.businessId, 'staff.updated')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- password reset
  describe('password reset', () => {
    it('sets the new password, clears the lockout, revokes tokens in every business and audits each', async () => {
      const o = await signupOwner();
      // The same person also manages a second business, logged in there by PIN.
      const bizB = await createBusiness('Duka B');
      const pinHash = await t.app.get(PasswordHasher).hash(PIN);
      const { membershipB, deviceB } = await tenants().run(bizB, async () => {
        const m = await currentTx().membership.create({
          data: { businessId: bizB, personId: o.personId, displayName: 'Amina', rolePreset: 'MANAGER', status: 'ACTIVE', pinHash },
          select: { id: true },
        });
        const d = await t.app.get(DevicesService, { strict: false }).register({
          name: 'Tablet B',
          platform: 'android',
          registeredByMembershipId: m.id,
          now: t.clock.now(),
        });
        return { membershipB: m.id, deviceB: d };
      });
      const loginB = await post('/v1/auth/pin', { device_id: deviceB.deviceId, device_secret: deviceB.deviceSecret, pin: PIN });
      expect(loginB.statusCode).toBe(200);
      const refreshB = json<{ refresh_token: string }>(loginB).refresh_token;

      // Lock the password first.
      const passwordLogin = (password: string) =>
        post('/v1/auth/login', { email: o.email, password, device: { name: 'New phone', platform: 'ios' } });
      for (let i = 0; i < 5; i++) expect((await passwordLogin('wrong-password-1')).statusCode).toBe(401);
      expect((await passwordLogin(PASSWORD)).statusCode).toBe(401);

      expect((await post('/v1/auth/password/forgot', { email: o.email.toUpperCase() })).statusCode).toBe(202);
      const code = lastCode(mail.outbox, o.email, 'password reset');
      const reset = await post('/v1/auth/password/reset', { email: o.email, code, new_password: NEW_PASSWORD });
      expect(reset.statusCode, JSON.stringify(reset.json())).toBe(200);
      expect(reset.json()).toEqual({ status: 'PASSWORD_RESET' });

      // Every session in both businesses has ended.
      expect(visible(await post('/v1/auth/refresh', { refresh_token: o.refreshToken })).code).toBe('TOKEN_INVALID');
      expect(visible(await post('/v1/auth/refresh', { refresh_token: refreshB })).code).toBe('TOKEN_INVALID');
      // The old password is dead; the new one works at once (lockout cleared).
      expect(visible(await passwordLogin(PASSWORD)).code).toBe('INVALID_CREDENTIALS');
      const fresh = await passwordLogin(NEW_PASSWORD);
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json()).toMatchObject({ requires_selection: true });

      const rowA = await rowsFor(o.businessId, 'password.reset');
      const rowB = await rowsFor(bizB, 'password.reset');
      expect(rowA).toHaveLength(1);
      expect(rowB).toHaveLength(1);
      expect(rowA[0]).toMatchObject({ actor_membership_id: null, target_id: o.membershipId, ip: IP, metadata: { revoked_count: 1 } });
      expect(rowB[0]).toMatchObject({ target_id: membershipB, metadata: { revoked_count: 1 } });

      // The code works once only.
      const again = await post('/v1/auth/password/reset', { email: o.email, code, new_password: 'another-pass-99' });
      expect(visible(again).code).toBe('OTP_INVALID');
    });

    it('refuses a new password equal to the email, before checking the code', async () => {
      const o = await signupOwner();
      const res = await post('/v1/auth/password/reset', { email: o.email, code: '000000', new_password: o.email.toUpperCase() });
      expect(visible(res)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    });
  });

  // ---------------------------------------------------------------- 2. append-only
  it('2. audit_log is append-only for app_user and shows nothing without a tenant', async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    await asAppUser(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query("SELECT set_config('app.business_id', $1, true)", [a.businessId]);
        const visibleRows = await c.query<{ business_id: string }>('SELECT business_id FROM audit_log');
        expect(visibleRows.rows.length).toBeGreaterThan(0);
        expect(new Set(visibleRows.rows.map((r) => r.business_id))).toEqual(new Set([a.businessId]));
        await c.query('SAVEPOINT s');
        await expect(c.query("UPDATE audit_log SET action = 'staff.removed'")).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        await expect(c.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        // Writing another business's row is refused by the policy.
        await expect(
          c.query(
            `INSERT INTO audit_log (business_id, action, target_type, occurred_at) VALUES ($1, 'staff.removed', 'membership', now())`,
            [b.businessId],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await c.query('ROLLBACK');
      }
      const none = await c.query('SELECT 1 FROM audit_log');
      expect(none.rowCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------- 3. credentials never logged
  it('3. no credential ever appears in a log line, on success, failure or 500 paths', async () => {
    const o = await signupOwner();
    const s = await activeStaff(o);
    const seen = [PASSWORD, PIN, ...o.seen, ...s.seen];

    // Failure paths with the real credentials and with wrong ones.
    await pinLogin(o, '5555');
    await post('/v1/auth/pin', { device_id: o.deviceId, device_secret: `${o.deviceSecret}x`, pin: PIN });
    await post('/v1/auth/login', { email: o.email, password: 'not-the-password-1', device: { name: 'x', platform: 'ios' } });
    await post('/v1/auth/login', { selection_token: o.accessToken, membership_id: o.membershipId, device: { name: 'x', platform: 'ios' } });
    await post('/v1/auth/refresh', { refresh_token: o.refreshToken });
    await post('/v1/auth/refresh', { refresh_token: o.refreshToken });
    await post('/v1/auth/signup', { signup_token: o.seen[2], owner_name: 'x', business_name: 'x', business_type: 'RETAIL', password: PASSWORD, pin: PIN, device: { name: 'x', platform: 'ios' } });
    await post('/v1/auth/staff/activate', { setup_token: s.seen[1], code: s.seen[2], new_pin: '6071', device: { name: 'x', platform: 'ios' } });
    await call('GET', '/v1/auth/device-members', undefined, undefined, { 'x-device-id': o.deviceId, 'x-device-secret': o.deviceSecret });
    await call('GET', '/v1/me', o.accessToken);

    // Password reset, with a wrong code and then the right one.
    await post('/v1/auth/password/forgot', { email: o.email });
    const resetCode = lastCode(mail.outbox, o.email, 'password reset');
    seen.push(resetCode, NEW_PASSWORD);
    await post('/v1/auth/password/reset', { email: o.email, code: resetCode === '111111' ? '222222' : '111111', new_password: NEW_PASSWORD });
    await post('/v1/auth/password/reset', { email: o.email, code: resetCode, new_password: NEW_PASSWORD });

    // The 500 path: a handler that logs every credential and fails with them in its message.
    const boom = await post('/spike/careless', {
      password: PASSWORD,
      new_password: NEW_PASSWORD,
      pin: PIN,
      new_pin: '6071',
      temp_pin: s.seen[0],
      code: resetCode,
      phone_code: o.seen[0],
      email_code: o.seen[1],
      access_token: o.accessToken,
      refresh_token: o.refreshToken,
      device_secret: o.deviceSecret,
      signup_token: o.seen[2],
      setup_token: s.seen[1],
      selection_token: o.accessToken,
    });
    expect(boom.statusCode).toBe(500);
    expect(JSON.stringify(boom.json())).not.toContain(o.deviceSecret);

    const raw = t.rawLogs();
    // The careless line was written, with its values redacted.
    const careless = t.logs.find((l) => l.msg === 'careless handler');
    expect(careless, 'the careless handler must have logged').toBeDefined();
    expect(JSON.stringify(careless)).toContain('[REDACTED]');

    for (const secret of new Set(seen)) {
      // Short values (PINs, codes) could match unrelated digits such as a
      // response time, so look for them as a whole JSON value or word.
      const leaked =
        secret.length >= 12
          ? raw.includes(secret)
          : new RegExp(`["=:\\s]${secret}["\\s,}]`).test(raw);
      expect(leaked, `a credential of length ${secret.length} appears in the logs`).toBe(false);
    }
  });

  // ---------------------------------------------------------------- 4. enumeration
  describe('4. public routes answer the same for known and unknown phones and emails', () => {
    /** How many slow hashes (scrypt) a request does: equal work is part of looking the same. */
    async function scryptWork(fn: () => Promise<LightMyRequestResponse>) {
      const hasher = t.app.get(PasswordHasher);
      const spies = [vi.spyOn(hasher, 'hash'), vi.spyOn(hasher, 'verify'), vi.spyOn(hasher, 'dummyVerify')];
      const res = await fn();
      const count = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
      for (const spy of spies) spy.mockRestore();
      return { res, count };
    }

    it('signup/start and signup/verify', async () => {
      const o = await signupOwner();
      const known = await post('/v1/auth/signup/start', { phone: o.phone, email: o.email });
      const unknown = await post('/v1/auth/signup/start', { phone: newPhone(), email: newEmail() });
      expect(visible(known)).toEqual(visible(unknown));
      expect(known.json()).toEqual(unknown.json());

      const verifyKnown = await post('/v1/auth/signup/verify', { phone: o.phone, email: o.email, phone_code: '000000', email_code: '000000' });
      const verifyUnknown = await post('/v1/auth/signup/verify', { phone: newPhone(), email: newEmail(), phone_code: '000000', email_code: '000000' });
      expect(visible(verifyKnown)).toEqual(visible(verifyUnknown));
    });

    it('login: unknown email, wrong password and a locked account look the same and cost the same', async () => {
      const o = await signupOwner();
      const login = (email: string, password: string) => () =>
        post('/v1/auth/login', { email, password, device: { name: 'x', platform: 'ios' } });
      const unknown = await scryptWork(login(newEmail(), 'whatever-pass-1'));
      const wrong = await scryptWork(login(o.email, 'whatever-pass-1'));
      for (let i = 0; i < 4; i++) await login(o.email, 'whatever-pass-1')();
      const locked = await scryptWork(login(o.email, PASSWORD));
      expect(visible(wrong.res)).toEqual(visible(unknown.res));
      expect(visible(locked.res)).toEqual(visible(unknown.res));
      expect(wrong.count).toBe(unknown.count);
      expect(locked.count).toBe(unknown.count);
    });

    it('pin: unknown device, wrong secret and wrong PIN look the same and cost the same', async () => {
      const o = await signupOwner();
      const pin = (deviceId: string, secret: string, value: string) => () =>
        post('/v1/auth/pin', { device_id: deviceId, device_secret: secret, pin: value });
      const unknown = await scryptWork(pin(randomUUID(), o.deviceSecret, PIN));
      const wrongSecret = await scryptWork(pin(o.deviceId, `${o.deviceSecret.slice(0, -2)}AA`, PIN));
      const wrongPin = await scryptWork(pin(o.deviceId, o.deviceSecret, '0000'));
      expect(visible(wrongSecret.res)).toEqual(visible(unknown.res));
      expect(visible(wrongPin.res)).toEqual(visible(unknown.res));
      expect(wrongSecret.count).toBe(unknown.count);
      expect(wrongPin.count).toBe(unknown.count);
    });

    it('first-login and device-members', async () => {
      const o = await signupOwner();
      const phone = newPhone();
      const created = await post('/v1/staff', { phone, display_name: 'Baraka', role_preset: 'ATTENDANT' }, o.accessToken);
      expect(created.statusCode).toBe(201);
      const known = await post('/v1/auth/first-login', { phone, temp_pin: '000000' });
      const unknown = await post('/v1/auth/first-login', { phone: newPhone(), temp_pin: '000000' });
      expect(visible(known)).toEqual(visible(unknown));

      const members = (id: string, secret: string) =>
        call('GET', '/v1/auth/device-members', undefined, undefined, { 'x-device-id': id, 'x-device-secret': secret });
      const badSecret = await members(o.deviceId, 'not-the-secret');
      const unknownDevice = await members(randomUUID(), 'not-the-secret');
      expect(visible(badSecret)).toEqual(visible(unknownDevice));
      expect(badSecret.json()).toEqual(unknownDevice.json());
    });

    it('password/forgot: known, unknown and rate-limited emails all answer 202 with the same body', async () => {
      const o = await signupOwner();
      const known = await post('/v1/auth/password/forgot', { email: o.email });
      const limited = await post('/v1/auth/password/forgot', { email: o.email });
      const unknown = await post('/v1/auth/password/forgot', { email: newEmail() });
      expect(known.statusCode).toBe(202);
      for (const res of [limited, unknown]) {
        expect(visible(res)).toEqual(visible(known));
        expect(res.json()).toEqual(known.json());
      }
      // Only the known email got a code, and only once (the second was inside the 60-second gap).
      expect(mail.outbox.filter((m) => m.message.includes('password reset'))).toHaveLength(1);
    });

    it('password/reset: unknown email, wrong code and expired code look the same and cost the same', async () => {
      const o = await signupOwner();
      const reset = (email: string, code: string) => () =>
        post('/v1/auth/password/reset', { email, code, new_password: NEW_PASSWORD });
      const unknown = await scryptWork(reset(newEmail(), '000000'));
      expect((await post('/v1/auth/password/forgot', { email: o.email })).statusCode).toBe(202);
      const code = lastCode(mail.outbox, o.email, 'password reset');
      const wrong = await scryptWork(reset(o.email, code === '000000' ? '111111' : '000000'));
      t.clock.advanceMinutes(11);
      const expired = await scryptWork(reset(o.email, code));
      expect(visible(unknown.res)).toMatchObject({ status: 400, code: 'OTP_INVALID' });
      expect(visible(wrong.res)).toEqual(visible(unknown.res));
      expect(visible(expired.res)).toEqual(visible(unknown.res));
      expect(wrong.count).toBe(unknown.count);
      expect(expired.count).toBe(unknown.count);
      // Nothing changed: the old password still works.
      const login = await post('/v1/auth/login', { email: o.email, password: PASSWORD, device: { name: 'x', platform: 'ios' } });
      expect(login.statusCode).toBe(200);
    });
  });
});
