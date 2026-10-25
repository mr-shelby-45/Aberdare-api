import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CodeHasher } from '../src/common/auth/code-hasher.js';
import { PasswordHasher } from '../src/common/auth/password-hasher.js';
import { IdentityLookup } from '../src/database/identity-lookup.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { tempPinHashInput } from '../src/modules/staff/temp-pin.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, createBusiness, resetTables } from './helpers/db.js';

// Phase A4: staff and devices (docs/phase-a-design.md sections 6, 9, 10, 11, 19).
// Numbers in test names refer to the A4 list in section 19.

const PIN = '1357';
let phoneSeq = 0;
const newPhone = () => `+2547${String(30_000_000 + ++phoneSeq).slice(-8)}`;
const HASH_LIKE = /\b[0-9a-f]{64}\b|scrypt\$/;

interface Owner {
  businessId: string;
  membershipId: string;
  token: string;
}

describe('A4: staff and devices', { timeout: 60_000 }, () => {
  let t: TestApp;
  let sms: FakeSmsSender;
  let pinHash: string;

  beforeAll(async () => {
    t = await startTestApp();
    sms = t.app.get(SmsSender) as FakeSmsSender;
    pinHash = await t.app.get(PasswordHasher).hash(PIN);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    sms.outbox.length = 0;
  });

  const tenants = () => t.app.get(TenantRunner, { strict: false });

  // ---------------------------------------------------------------- HTTP
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object, headers: Record<string, string> = {}) =>
    t.app.inject({
      method,
      url,
      payload,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      remoteAddress: '198.51.100.30',
    });
  const visible = (res: LightMyRequestResponse) => {
    const body = res.json() as { error?: { code: string; message: string } };
    return { status: res.statusCode, code: body.error?.code, message: body.error?.message };
  };
  const json = <T>(res: LightMyRequestResponse) => res.json() as T;

  // ---------------------------------------------------------------- seeding
  /** A business with an owner logged in on a personal phone. */
  async function ownerOf(name = 'Duka A'): Promise<Owner> {
    const businessId = await createBusiness(name);
    const { personId } = await t.app.get(IdentityLookup, { strict: false }).ensurePerson(newPhone(), t.clock.now());
    const { membershipId, device } = await tenants().run(businessId, async () => {
      const m = await currentTx().membership.create({
        data: { businessId, personId, displayName: 'Amina', rolePreset: 'OWNER', status: 'ACTIVE', pinHash },
        select: { id: true },
      });
      const d = await t.app.get(DevicesService, { strict: false }).register({
        name: "Owner's phone",
        platform: 'android',
        registeredByMembershipId: m.id,
        now: t.clock.now(),
      });
      return { membershipId: m.id, device: d };
    });
    const login = await call('POST', '/v1/auth/pin', undefined, { device_id: device.deviceId, device_secret: device.deviceSecret, pin: PIN });
    expect(login.statusCode).toBe(200);
    return { businessId, membershipId, token: json<{ access_token: string }>(login).access_token };
  }

  /** Invites through the API; returns the membership id and the temp PIN shown once. */
  async function invite(owner: Owner, body: Partial<{ phone: string; display_name: string; role_preset: string; extra_permissions: string[] }> = {}) {
    const phone = body.phone ?? newPhone();
    const res = await call('POST', '/v1/staff', owner.token, {
      phone,
      display_name: body.display_name ?? 'Baraka',
      role_preset: body.role_preset ?? 'ATTENDANT',
      ...(body.extra_permissions ? { extra_permissions: body.extra_permissions } : {}),
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const r = json<{ membership_id: string; temp_pin: string; temp_pin_expires_at: string }>(res);
    return { phone, membershipId: r.membership_id, tempPin: r.temp_pin, expiresAt: r.temp_pin_expires_at };
  }

  const firstLogin = (phone: string, tempPin: string) => call('POST', '/v1/auth/first-login', undefined, { phone, temp_pin: tempPin });

  function lastSmsCode(to: string): string {
    const msg = [...sms.outbox].reverse().find((m) => m.to === to);
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no SMS to ${to}`);
    return code;
  }

  const activate = (setupToken: string, code: string, newPin = '2468') =>
    call('POST', '/v1/auth/staff/activate', undefined, { setup_token: setupToken, code, new_pin: newPin, device: { name: 'Staff phone', platform: 'android' } });

  /** Invite, first login and activation: an ACTIVE staff member with tokens and a device. */
  async function activeStaff(owner: Owner, body: Parameters<typeof invite>[1] = {}) {
    const inv = await invite(owner, body);
    const setup = json<{ setup_token: string }>(await firstLogin(inv.phone, inv.tempPin)).setup_token;
    const res = await activate(setup, lastSmsCode(inv.phone));
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const s = json<{ access_token: string; refresh_token: string; device_id: string; device_secret: string }>(res);
    return { ...inv, token: s.access_token, refreshToken: s.refresh_token, deviceId: s.device_id, deviceSecret: s.device_secret };
  }

  const membershipRow = (id: string) =>
    asAdmin(async (c) =>
      (
        await c.query<{ status: string; temp_pin_hash: string | null; temp_pin_failed_count: number; pin_hash: string | null; role_preset: string }>(
          'SELECT status, temp_pin_hash, temp_pin_failed_count, pin_hash, role_preset FROM membership WHERE id = $1',
          [id],
        )
      ).rows[0],
    );

  // ---------------------------------------------------------------- tests
  it('1. creating staff shows the temp PIN once, stores it hashed, and GET /staff never returns a hash or secret', async () => {
    const owner = await ownerOf();
    const inv = await invite(owner, { phone: '0712 000 111', display_name: 'Baraka' });
    expect(inv.tempPin).toMatch(/^\d{6}$/);

    const row = await membershipRow(inv.membershipId);
    expect(row).toMatchObject({ status: 'INVITED', pin_hash: null });
    expect(row.temp_pin_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.temp_pin_hash).not.toContain(inv.tempPin);

    const list = await call('GET', '/v1/staff', owner.token);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(HASH_LIKE);
    expect(list.body).not.toContain(inv.tempPin);
    expect(list.body).not.toContain('+254712000111');
    const staff = json<{ staff: Record<string, unknown>[] }>(list).staff;
    expect(staff.find((s) => s.id === inv.membershipId)).toEqual({
      id: inv.membershipId,
      display_name: 'Baraka',
      role_preset: 'ATTENDANT',
      status: 'INVITED',
      extra_permissions: [],
      phone: '**********111',
      created_at: expect.any(String),
    });
    expect(t.rawLogs()).not.toContain(inv.tempPin);
  });

  describe('2. first login', () => {
    it('works with the right phone and temp PIN, and sends an SMS code', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const res = await firstLogin(inv.phone, inv.tempPin);
      expect(res.statusCode).toBe(200);
      expect(json<{ setup_token: string }>(res).setup_token).toEqual(expect.any(String));
      expect(lastSmsCode(inv.phone)).toMatch(/^\d{6}$/);
    });

    it('a wrong PIN, an unknown phone and an expired PIN all give the same answer', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const wrong = visible(await firstLogin(inv.phone, inv.tempPin === '000000' ? '111111' : '000000'));
      const unknown = visible(await firstLogin(newPhone(), inv.tempPin));
      t.clock.advanceMinutes(3 * 24 * 60 + 1);
      const expired = visible(await firstLogin(inv.phone, inv.tempPin));
      expect(wrong).toEqual(unknown);
      expect(wrong).toEqual(expired);
      expect(wrong).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    });

    it('the fifth wrong try kills the temp PIN', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const wrongPin = inv.tempPin === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expect((await firstLogin(inv.phone, wrongPin)).statusCode).toBe(401);
      expect(visible(await firstLogin(inv.phone, inv.tempPin))).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
      expect(await membershipRow(inv.membershipId)).toMatchObject({ temp_pin_hash: null, temp_pin_failed_count: 5 });
    });

    it('a temp PIN cannot be used again after activation', async () => {
      const owner = await ownerOf();
      const staff = await activeStaff(owner);
      expect(visible(await firstLogin(staff.phone, staff.tempPin))).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    });

    it('a wrong guess counts against every live invite for that phone, in every business', async () => {
      const a = await ownerOf('Duka A');
      const b = await ownerOf('Duka B');
      const phone = newPhone();
      const inA = await invite(a, { phone });
      const inB = await invite(b, { phone });
      const wrongPin = [inA.tempPin, inB.tempPin].includes('000000') ? '999999' : '000000';
      await firstLogin(phone, wrongPin);
      expect((await membershipRow(inA.membershipId)).temp_pin_failed_count).toBe(1);
      expect((await membershipRow(inB.membershipId)).temp_pin_failed_count).toBe(1);
    });
  });

  it('3. two invited memberships with the same temp PIN give AMBIGUOUS_INVITE', async () => {
    const a = await ownerOf('Duka A');
    const b = await ownerOf('Duka B');
    const phone = newPhone();
    const inA = await invite(a, { phone });
    const inB = await invite(b, { phone });
    // Force the (otherwise unlikely) clash: give B's invite the same 6 digits.
    const sameHash = t.app.get(CodeHasher).hash(tempPinHashInput(inB.membershipId, inA.tempPin));
    await asAdmin((c) => c.query('UPDATE membership SET temp_pin_hash = $2 WHERE id = $1', [inB.membershipId, sameHash]));

    const res = await firstLogin(phone, inA.tempPin);
    expect(visible(res)).toMatchObject({ status: 409, code: 'AMBIGUOUS_INVITE' });
    expect(sms.outbox).toHaveLength(0);
  });

  describe('4. activation', () => {
    it('needs the right SMS code; then sets the phone verified, the PIN, ACTIVE and a device', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const setup = json<{ setup_token: string }>(await firstLogin(inv.phone, inv.tempPin)).setup_token;
      const code = lastSmsCode(inv.phone);

      expect(visible(await activate(setup, code === '000000' ? '111111' : '000000'))).toMatchObject({ status: 400, code: 'OTP_INVALID' });
      const ok = await activate(setup, code);
      expect(ok.statusCode).toBe(200);
      const s = json<{ device_id: string; device_secret: string; membership: { role_preset: string } }>(ok);
      expect(s.membership.role_preset).toBe('ATTENDANT');

      const db = await asAdmin(async (c) => ({
        membership: (await c.query("SELECT status, temp_pin_hash, pin_hash LIKE 'scrypt$%' AS scrypt FROM membership WHERE id = $1", [inv.membershipId])).rows[0],
        person: (await c.query('SELECT phone_verified_at IS NOT NULL AS verified FROM person WHERE phone = $1', [inv.phone])).rows[0],
        device: (await c.query('SELECT registered_by_membership_id AS by, status FROM device WHERE id = $1', [s.device_id])).rows[0],
        code: (await c.query("SELECT consumed_at IS NOT NULL AS consumed FROM otp_challenge WHERE target = $1 AND purpose = 'STAFF_ACTIVATE'", [inv.phone])).rows[0],
      }));
      expect(db).toEqual({
        membership: { status: 'ACTIVE', temp_pin_hash: null, scrypt: true },
        person: { verified: true },
        device: { by: inv.membershipId, status: 'ACTIVE' },
        code: { consumed: true },
      });

      // The new PIN works on the new device.
      const pin = await call('POST', '/v1/auth/pin', undefined, { device_id: s.device_id, device_secret: s.device_secret, pin: '2468' });
      expect(pin.statusCode).toBe(200);
    });

    it('a replayed setup token is refused after activation, and changes nothing', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const setup = json<{ setup_token: string }>(await firstLogin(inv.phone, inv.tempPin)).setup_token;
      const code = lastSmsCode(inv.phone);
      expect((await activate(setup, code)).statusCode).toBe(200);
      const before = await membershipRow(inv.membershipId);

      // Activation consumed the code, so the replay is refused at the code
      // check, before it can reach the invite claim.
      expect(visible(await activate(setup, code, '9999'))).toMatchObject({ status: 400, code: 'OTP_INVALID' });
      expect(await membershipRow(inv.membershipId)).toEqual(before);
      const devices = await asAdmin(async (c) =>
        Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM device WHERE registered_by_membership_id = $1', [inv.membershipId])).rows[0].n),
      );
      expect(devices).toBe(1);
    });

    it('two concurrent activations with the same setup token: exactly one succeeds', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const setup = json<{ setup_token: string }>(await firstLogin(inv.phone, inv.tempPin)).setup_token;
      const code = lastSmsCode(inv.phone);
      // Hold both requests at the PIN hash (after the code check, before the
      // claim) until both have arrived, so they always meet at the atomic
      // invite claim. With slow hashing they overlapped by luck; with the fast
      // test hasher one could finish first, and the other was then refused at
      // the code check (400) without testing the claim race at all.
      const hasher = t.app.get(PasswordHasher);
      const original = hasher.hash.bind(hasher);
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      const spy = vi.spyOn(hasher, 'hash').mockImplementation(async (secret) => {
        if (++arrived === 2) release();
        await bothArrived;
        return original(secret);
      });
      const results = await Promise.all([activate(setup, code), activate(setup, code)]);
      spy.mockRestore();
      expect(arrived).toBe(2);
      expect(results.map((r) => r.statusCode).sort((x, y) => x - y)).toEqual([200, 401]);
      const devices = await asAdmin(async (c) =>
        Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM device WHERE registered_by_membership_id = $1', [inv.membershipId])).rows[0].n),
      );
      expect(devices).toBe(1);
    });
  });

  describe('5. reset-pin, suspend and reactivate', () => {
    it('reset-pin revokes tokens and the person\'s phones, and needs a fresh first login', async () => {
      const owner = await ownerOf();
      const staff = await activeStaff(owner);
      expect((await call('GET', '/v1/me', staff.token)).statusCode).toBe(200);

      const reset = await call('POST', `/v1/staff/${staff.membershipId}/reset-pin`, owner.token);
      expect(reset.statusCode).toBe(200);
      const newTemp = json<{ temp_pin: string }>(reset).temp_pin;

      expect(visible(await call('GET', '/v1/me', staff.token))).toMatchObject({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
      expect(visible(await call('POST', '/v1/auth/refresh', undefined, { refresh_token: staff.refreshToken }))).toMatchObject({ code: 'TOKEN_INVALID' });
      expect(visible(await call('POST', '/v1/auth/pin', undefined, { device_id: staff.deviceId, device_secret: staff.deviceSecret, pin: '2468' }))).toMatchObject({ status: 403, code: 'DEVICE_REVOKED' });
      expect((await membershipRow(staff.membershipId)).status).toBe('INVITED');

      t.clock.advance(61_000); // SMS cooldown
      const setup = json<{ setup_token: string }>(await firstLogin(staff.phone, newTemp)).setup_token;
      expect((await activate(setup, lastSmsCode(staff.phone), '9753')).statusCode).toBe(200);
    });

    it('suspend ends access on the next request; reactivate restores it', async () => {
      const owner = await ownerOf();
      const staff = await activeStaff(owner);
      expect((await call('POST', `/v1/staff/${staff.membershipId}/suspend`, owner.token)).statusCode).toBe(204);
      expect(visible(await call('GET', '/v1/me', staff.token))).toMatchObject({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
      expect(visible(await call('POST', '/v1/auth/refresh', undefined, { refresh_token: staff.refreshToken }))).toMatchObject({ code: 'TOKEN_INVALID' });

      expect((await call('POST', `/v1/staff/${staff.membershipId}/reactivate`, owner.token)).statusCode).toBe(204);
      const pin = await call('POST', '/v1/auth/pin', undefined, { device_id: staff.deviceId, device_secret: staff.deviceSecret, pin: '2468' });
      expect(pin.statusCode).toBe(200);
    });

    it('remove sets REMOVED (no hard delete); the person can be invited again with the same membership', async () => {
      const owner = await ownerOf();
      const staff = await activeStaff(owner);
      expect((await call('DELETE', `/v1/staff/${staff.membershipId}`, owner.token)).statusCode).toBe(204);
      expect((await membershipRow(staff.membershipId)).status).toBe('REMOVED');
      expect(visible(await call('GET', '/v1/me', staff.token))).toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });

      const again = await invite(owner, { phone: staff.phone, role_preset: 'MANAGER' });
      expect(again.membershipId).toBe(staff.membershipId);
      expect(await membershipRow(staff.membershipId)).toMatchObject({ status: 'INVITED', role_preset: 'MANAGER' });
    });

    it('an existing member cannot be invited twice', async () => {
      const owner = await ownerOf();
      const inv = await invite(owner);
      const res = await call('POST', '/v1/staff', owner.token, { phone: inv.phone, display_name: 'Again', role_preset: 'ATTENDANT' });
      expect(visible(res)).toMatchObject({ status: 409, code: 'MEMBER_EXISTS' });
    });
  });

  describe('6. owner protections and the stock.convert rule', () => {
    it('the owner cannot be suspended, removed, demoted or reset, even by someone with staff.manage', async () => {
      const owner = await ownerOf();
      // The owner grants staff.manage to a manager.
      const manager = await activeStaff(owner, { role_preset: 'MANAGER' });
      const grant = await call('PATCH', `/v1/staff/${manager.membershipId}`, owner.token, { extra_permissions: ['staff.manage'] });
      expect(grant.statusCode).toBe(204);

      for (const [method, url, payload] of [
        ['POST', `/v1/staff/${owner.membershipId}/suspend`, undefined],
        ['DELETE', `/v1/staff/${owner.membershipId}`, undefined],
        ['POST', `/v1/staff/${owner.membershipId}/reset-pin`, undefined],
        ['PATCH', `/v1/staff/${owner.membershipId}`, { role_preset: 'MANAGER' }],
      ] as const) {
        expect(visible(await call(method, url, manager.token, payload)), `${method} ${url}`).toMatchObject({ status: 403, code: 'OWNER_PROTECTED' });
      }
      expect((await membershipRow(owner.membershipId))).toMatchObject({ status: 'ACTIVE', role_preset: 'OWNER' });
    });

    it('stock.convert cannot be given to an attendant, on create or by demotion', async () => {
      const owner = await ownerOf();
      const created = await call('POST', '/v1/staff', owner.token, { phone: newPhone(), display_name: 'X', role_preset: 'ATTENDANT', extra_permissions: ['stock.convert'] });
      expect(visible(created)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });

      const manager = await invite(owner, { role_preset: 'MANAGER', extra_permissions: ['stock.convert'] });
      const demote = await call('PATCH', `/v1/staff/${manager.membershipId}`, owner.token, { role_preset: 'ATTENDANT' });
      expect(visible(demote)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
      expect((await membershipRow(manager.membershipId)).role_preset).toBe('MANAGER');

      const unknown = await call('POST', '/v1/staff', owner.token, { phone: newPhone(), display_name: 'Y', role_preset: 'MANAGER', extra_permissions: ['make.coffee'] });
      expect(visible(unknown)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    });

    it('nobody changes their own access, and only the owner grants owner-only permissions', async () => {
      const owner = await ownerOf();
      const manager = await activeStaff(owner, { role_preset: 'MANAGER' });
      await call('PATCH', `/v1/staff/${manager.membershipId}`, owner.token, { extra_permissions: ['staff.manage'] });
      const attendant = await invite(owner);

      // The manager cannot give themselves more...
      expect(visible(await call('PATCH', `/v1/staff/${manager.membershipId}`, manager.token, { extra_permissions: ['staff.manage', 'costs.view'] })))
        .toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
      // ...cannot hand out owner-only permissions...
      expect(visible(await call('PATCH', `/v1/staff/${attendant.membershipId}`, manager.token, { extra_permissions: ['devices.manage'] })))
        .toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
      // ...but can grant ordinary ones.
      expect((await call('PATCH', `/v1/staff/${attendant.membershipId}`, manager.token, { extra_permissions: ['stock.receive'] })).statusCode).toBe(204);
      // The owner cannot change their own access either.
      expect(visible(await call('POST', `/v1/staff/${owner.membershipId}/suspend`, owner.token))).toMatchObject({ status: 403 });
    });
  });

  it('7. an attendant without staff.manage or devices.manage is refused the staff and device endpoints', async () => {
    const owner = await ownerOf();
    const attendant = await activeStaff(owner);
    for (const [method, url] of [
      ['GET', '/v1/staff'],
      ['POST', '/v1/staff'],
      ['GET', '/v1/devices'],
      ['DELETE', `/v1/devices/${randomUUID()}`],
    ] as const) {
      const res = await call(method, url, attendant.token, method === 'POST' ? { phone: newPhone(), display_name: 'Z', role_preset: 'ATTENDANT' } : undefined);
      expect(visible(res), `${method} ${url}`).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    }
  });

  describe('8. shared devices', () => {
    async function sharedTablet() {
      const owner = await ownerOf();
      const a = await activeStaff(owner, { display_name: 'Baraka' });
      const b = await activeStaff(owner, { display_name: 'Chebet' });
      const tablet = await tenants().run(owner.businessId, () =>
        t.app.get(DevicesService, { strict: false }).register({ name: 'Counter tablet', platform: 'android', registeredByMembershipId: owner.membershipId, now: t.clock.now() }),
      );
      expect((await call('PATCH', `/v1/devices/${tablet.deviceId}`, owner.token, { is_shared: true })).statusCode).toBe(204);
      for (const m of [owner.membershipId, a.membershipId, b.membershipId]) {
        expect((await call('POST', `/v1/devices/${tablet.deviceId}/members`, owner.token, { membership_id: m })).statusCode).toBe(204);
      }
      return { owner, a, b, tablet };
    }
    const members = (deviceId: string, secret: string) =>
      call('GET', '/v1/auth/device-members', undefined, undefined, { 'x-device-id': deviceId, 'x-device-secret': secret });

    it('lists display names and ids only, for that device only', async () => {
      const { owner, a, b, tablet } = await sharedTablet();
      await ownerOf('Duka B'); // another business with its own people
      const res = await members(tablet.deviceId, tablet.deviceSecret);
      expect(res.statusCode).toBe(200);
      expect(json<{ members: unknown[] }>(res).members).toEqual([
        { membership_id: owner.membershipId, display_name: 'Amina' },
        { membership_id: a.membershipId, display_name: 'Baraka' },
        { membership_id: b.membershipId, display_name: 'Chebet' },
      ]);
      expect(res.body).not.toMatch(HASH_LIKE);
    });

    it('a bad credential gets the same 200 with an empty list', async () => {
      const { tablet } = await sharedTablet();
      for (const [id, secret] of [
        [tablet.deviceId, 'wrong-secret'],
        [randomUUID(), tablet.deviceSecret],
        ['not-a-uuid', tablet.deviceSecret],
      ]) {
        const res = await members(id, secret);
        expect({ status: res.statusCode, body: res.json() }).toEqual({ status: 200, body: { members: [] } });
      }
      const none = await call('GET', '/v1/auth/device-members');
      expect({ status: none.statusCode, body: none.json() }).toEqual({ status: 200, body: { members: [] } });
    });

    it('PIN login works for linked members; turning shared off removes links and ends their sessions there', async () => {
      const { owner, a, tablet } = await sharedTablet();
      const login = await call('POST', '/v1/auth/pin', undefined, { device_id: tablet.deviceId, device_secret: tablet.deviceSecret, pin: '2468', membership_id: a.membershipId });
      expect(login.statusCode).toBe(200);
      const aToken = json<{ access_token: string }>(login).access_token;

      expect((await call('PATCH', `/v1/devices/${tablet.deviceId}`, owner.token, { is_shared: false })).statusCode).toBe(204);
      expect(visible(await call('GET', '/v1/me', aToken))).toMatchObject({ status: 403, code: 'DEVICE_REVOKED' });
      expect(json<{ members: unknown[] }>(await members(tablet.deviceId, tablet.deviceSecret)).members).toEqual([]);
    });

    it('revoking a device ends every session on it', async () => {
      const { owner, a, tablet } = await sharedTablet();
      const login = json<{ access_token: string; refresh_token: string }>(
        await call('POST', '/v1/auth/pin', undefined, { device_id: tablet.deviceId, device_secret: tablet.deviceSecret, pin: '2468', membership_id: a.membershipId }),
      );
      expect((await call('DELETE', `/v1/devices/${tablet.deviceId}`, owner.token)).statusCode).toBe(204);
      expect(visible(await call('GET', '/v1/me', login.access_token))).toMatchObject({ code: 'DEVICE_REVOKED' });
      expect(visible(await call('POST', '/v1/auth/refresh', undefined, { refresh_token: login.refresh_token }))).toMatchObject({ code: 'TOKEN_INVALID' });
      const list = json<{ devices: { id: string; status: string }[] }>(await call('GET', '/v1/devices', owner.token)).devices;
      expect(list.find((d) => d.id === tablet.deviceId)?.status).toBe('REVOKED');
    });

    it('only active members can be added, and only to a shared device', async () => {
      const owner = await ownerOf();
      const invited = await invite(owner);
      const personal = await tenants().run(owner.businessId, () =>
        t.app.get(DevicesService, { strict: false }).register({ name: 'Phone', platform: 'ios', registeredByMembershipId: owner.membershipId, now: t.clock.now() }),
      );
      expect(visible(await call('POST', `/v1/devices/${personal.deviceId}/members`, owner.token, { membership_id: owner.membershipId }))).toMatchObject({ status: 422 });
      await call('PATCH', `/v1/devices/${personal.deviceId}`, owner.token, { is_shared: true });
      expect(visible(await call('POST', `/v1/devices/${personal.deviceId}/members`, owner.token, { membership_id: invited.membershipId }))).toMatchObject({ status: 422 });
    });
  });

  it("9. staff, device and token queries from business A never touch business B", async () => {
    const a = await ownerOf('Duka A');
    const b = await ownerOf('Duka B');
    const staffB = await activeStaff(b);
    const deviceB = staffB.deviceId;

    const staffSeenByA = json<{ staff: { id: string }[] }>(await call('GET', '/v1/staff', a.token)).staff.map((s) => s.id);
    expect(staffSeenByA).toEqual([a.membershipId]);
    const devicesSeenByA = json<{ devices: { id: string }[] }>(await call('GET', '/v1/devices', a.token)).devices.map((d) => d.id);
    expect(devicesSeenByA).not.toContain(deviceB);

    for (const [method, url, payload] of [
      ['POST', `/v1/staff/${staffB.membershipId}/suspend`, undefined],
      ['POST', `/v1/staff/${staffB.membershipId}/reset-pin`, undefined],
      ['PATCH', `/v1/staff/${staffB.membershipId}`, { display_name: 'hacked' }],
      ['DELETE', `/v1/staff/${staffB.membershipId}`, undefined],
      ['DELETE', `/v1/devices/${deviceB}`, undefined],
      ['PATCH', `/v1/devices/${deviceB}`, { name: 'hacked' }],
    ] as const) {
      expect(visible(await call(method, url, a.token, payload)), `${method} ${url}`).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    expect((await call('GET', '/v1/me', staffB.token)).statusCode).toBe(200);
    expect(await membershipRow(staffB.membershipId)).toMatchObject({ status: 'ACTIVE' });
  });
});
