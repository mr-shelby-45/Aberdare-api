import { JwtService } from '@nestjs/jwt';
import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PasswordHasher } from '../src/common/auth/password-hasher.js';
import { IdentityLookup } from '../src/database/identity-lookup.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { TEST_ENV, type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, createBusiness, resetTables } from './helpers/db.js';

// Phase A3: login, tokens, request pipeline (docs/phase-a-design.md sections
// 6 to 10 and 19). Numbers in test names refer to the A3 list in section 19.

const PIN = '1357';
const PASSWORD = 'mango-tree-42-river';
let phoneSeq = 0;
const newPhone = () => `+2547${String(20_000_000 + ++phoneSeq).slice(-8)}`;

interface Member {
  personId: string;
  membershipId: string;
  businessId: string;
  email?: string;
}
interface Device {
  deviceId: string;
  deviceSecret: string;
}

describe('A3: login, tokens and the request pipeline', { timeout: 60_000 }, () => {
  let t: TestApp;
  let pinHash: string;
  let passwordHash: string;

  beforeAll(async () => {
    t = await startTestApp();
    const hasher = t.app.get(PasswordHasher);
    // Hashed once and reused: scrypt costs ~430 ms per hash.
    pinHash = await hasher.hash(PIN);
    passwordHash = await hasher.hash(PASSWORD);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tenants = () => t.app.get(TenantRunner, { strict: false });

  // ---------------------------------------------------------------- seeding
  async function seedMember(
    businessId: string,
    opts: { rolePreset?: 'OWNER' | 'MANAGER' | 'ATTENDANT'; status?: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REMOVED'; withPassword?: boolean; personId?: string; extras?: string[] } = {},
  ): Promise<Member> {
    const personId =
      opts.personId ?? (await t.app.get(IdentityLookup, { strict: false }).ensurePerson(newPhone(), t.clock.now())).personId;
    let email: string | undefined;
    if (opts.withPassword) {
      email = `owner-${randomUUID().slice(0, 8)}@example.com`;
      await asAdmin((c) =>
        c.query('UPDATE person SET email = $2, password_hash = $3, email_verified_at = now(), phone_verified_at = now() WHERE id = $1', [personId, email, passwordHash]),
      );
    }
    const membership = await tenants().run(businessId, () =>
      currentTx().membership.create({
        data: {
          businessId,
          personId,
          displayName: `Member ${phoneSeq}`,
          rolePreset: opts.rolePreset ?? 'OWNER',
          status: opts.status ?? 'ACTIVE',
          pinHash,
          extraPermissions: opts.extras ?? [],
        },
        select: { id: true },
      }),
    );
    return { personId, membershipId: membership.id, businessId, email };
  }

  async function seedDevice(m: Member, opts: { shared?: boolean; link?: Member[] } = {}): Promise<Device> {
    return tenants().run(m.businessId, async () => {
      const d = await t.app.get(DevicesService, { strict: false }).register({
        name: 'Test phone',
        platform: 'android',
        registeredByMembershipId: m.membershipId,
        now: t.clock.now(),
      });
      if (opts.shared) {
        await currentTx().device.update({ where: { id: d.deviceId }, data: { isShared: true } });
        for (const linked of opts.link ?? [m]) {
          await currentTx().deviceMembership.create({ data: { businessId: m.businessId, deviceId: d.deviceId, membershipId: linked.membershipId } });
        }
      }
      return d;
    });
  }

  /** A fresh session without scrypt (for refresh tests). */
  async function issueSession(m: Member, d: Device) {
    return tenants().run(m.businessId, () =>
      t.app.get(TokenService, { strict: false }).issueSession({
        personId: m.personId,
        membershipId: m.membershipId,
        businessId: m.businessId,
        deviceId: d.deviceId,
      }),
    );
  }

  const setMembership = (m: Member, data: Record<string, unknown>) =>
    tenants().run(m.businessId, () => currentTx().membership.update({ where: { id: m.membershipId }, data, select: { id: true } }));
  const setDevice = (m: Member, d: Device, data: Record<string, unknown>) =>
    tenants().run(m.businessId, () => currentTx().device.update({ where: { id: d.deviceId }, data, select: { id: true } }));

  // ---------------------------------------------------------------- HTTP
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'POST', url, payload, headers, remoteAddress: '198.51.100.20' });
  const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

  const passwordLogin = (email: string, password: string, extra: object = {}) =>
    post('/v1/auth/login', { email, password, device: { name: 'New phone', platform: 'ios' }, ...extra });
  const pinLogin = (d: Device, pin = PIN, membershipId?: string) =>
    post('/v1/auth/pin', { device_id: d.deviceId, device_secret: d.deviceSecret, pin, ...(membershipId ? { membership_id: membershipId } : {}) });

  /** Status, code and message: what a client can see, minus request id and time. */
  const visible = (res: LightMyRequestResponse) => {
    const body = res.json() as { error?: { code: string; message: string } };
    return { status: res.statusCode, code: body.error?.code, message: body.error?.message };
  };
  const tokenOf = (res: LightMyRequestResponse) => (res.json() as { access_token: string }).access_token;

  // ---------------------------------------------------------------- tests
  describe('1. password login', () => {
    it('works, and creates a new device with its own secret', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz, { withPassword: true });
      const res = await passwordLogin(owner.email!, PASSWORD);
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['access_token', 'device_id', 'device_secret', 'membership', 'refresh_token']);
      expect((await get('/v1/me', body.access_token as string)).statusCode).toBe(200);
    });

    it('a wrong password and an unknown email give the same status, code and message', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz, { withPassword: true });
      const wrong = visible(await passwordLogin(owner.email!, 'not-the-password-1'));
      const unknown = visible(await passwordLogin('nobody-here@example.com', 'not-the-password-1'));
      expect(wrong).toEqual(unknown);
      expect(wrong).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    });

    it('an unknown email does comparable work (loose timing sanity check, not a proof)', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz, { withPassword: true });
      const time = async (email: string) => {
        const started = performance.now();
        await passwordLogin(email, 'not-the-password-1');
        return performance.now() - started;
      };
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 3; i++) {
        known.push(await time(owner.email!));
        unknown.push(await time(`nobody-${i}@example.com`));
      }
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];
      const ratio = median(unknown) / median(known);
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);
    });
  });

  it('2. five wrong passwords lock the person for 15 minutes; during the lock every answer is the same', async () => {
    const biz = await createBusiness('Duka A');
    const owner = await seedMember(biz, { withPassword: true });
    for (let i = 0; i < 5; i++) {
      expect((await passwordLogin(owner.email!, 'wrong-password-123')).statusCode).toBe(401);
    }
    const correctDuringLock = visible(await passwordLogin(owner.email!, PASSWORD));
    const wrongDuringLock = visible(await passwordLogin(owner.email!, 'wrong-password-123'));
    const unknownEmail = visible(await passwordLogin('nobody-here@example.com', 'wrong-password-123'));
    expect(correctDuringLock).toEqual(wrongDuringLock);
    expect(correctDuringLock).toEqual(unknownEmail);
    expect(correctDuringLock).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });

    t.clock.advanceMinutes(16);
    expect((await passwordLogin(owner.email!, PASSWORD)).statusCode).toBe(200);
  });

  describe('3. PIN login', () => {
    it('works with the device secret and PIN, and issues no new device secret', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz);
      const device = await seedDevice(owner);
      const res = await pinLogin(device);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json() as object).sort()).toEqual(['access_token', 'membership', 'refresh_token']);
    });

    it('a wrong secret, an unknown device, a wrong PIN and someone not on the shared device all give INVALID_CREDENTIALS', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz);
      const linked = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const notLinked = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const shared = await seedDevice(owner, { shared: true, link: [owner, linked] });

      const answers = [
        visible(await pinLogin({ ...shared, deviceSecret: 'wrong-secret' }, PIN, linked.membershipId)),
        visible(await pinLogin({ deviceId: randomUUID(), deviceSecret: shared.deviceSecret }, PIN, linked.membershipId)),
        visible(await pinLogin({ deviceId: 'not-a-uuid', deviceSecret: shared.deviceSecret }, PIN)),
        visible(await pinLogin(shared, '0000', linked.membershipId)),
        visible(await pinLogin(shared, PIN, notLinked.membershipId)),
        visible(await pinLogin(shared, PIN)), // shared device: membership_id is required
      ];
      for (const a of answers) expect(a).toEqual(answers[0]);
      expect(answers[0]).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
      expect((await pinLogin(shared, PIN, linked.membershipId)).statusCode).toBe(200);
    });

    it('a revoked device is refused', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz);
      const device = await seedDevice(owner);
      await setDevice(owner, device, { status: 'REVOKED' });
      expect(visible(await pinLogin(device))).toMatchObject({ status: 403, code: 'DEVICE_REVOKED' });
    });

    it('five wrong PINs lock for 15 minutes; the lock answers the same for any PIN', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      for (let i = 0; i < 5; i++) expect((await pinLogin(device, '0000')).statusCode).toBe(401);

      const right = await pinLogin(device, PIN);
      const wrong = await pinLogin(device, '0000');
      expect(visible(right)).toEqual(visible(wrong));
      expect(visible(right)).toMatchObject({ status: 423, code: 'ACCOUNT_LOCKED' });
      expect(Number(right.headers['retry-after'])).toBeGreaterThan(14 * 60);

      t.clock.advanceMinutes(16);
      expect((await pinLogin(device, PIN)).statusCode).toBe(200);
    });

    it('ten wrong PINs in a row lock until a reset; for an owner, a password login unlocks it', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz, { withPassword: true });
      const device = await seedDevice(owner);
      for (let i = 0; i < 5; i++) await pinLogin(device, '0000');
      t.clock.advanceMinutes(16);
      for (let i = 0; i < 5; i++) await pinLogin(device, '0000');

      t.clock.advanceMinutes(60 * 24);
      const locked = await pinLogin(device, PIN);
      expect(visible(locked)).toMatchObject({ status: 423, code: 'ACCOUNT_LOCKED' });
      expect(visible(locked).message).toContain('email and password');
      expect(locked.headers['retry-after']).toBeUndefined();

      expect((await passwordLogin(owner.email!, PASSWORD)).statusCode).toBe(200);
      expect((await pinLogin(device, PIN)).statusCode).toBe(200);
    });

    it('a staff PIN locked for good stays locked after a day (needs an owner reset in A4)', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      for (let i = 0; i < 5; i++) await pinLogin(device, '0000');
      t.clock.advanceMinutes(16);
      for (let i = 0; i < 5; i++) await pinLogin(device, '0000');
      t.clock.advanceMinutes(60 * 24);
      const locked = await pinLogin(device, PIN);
      expect(visible(locked)).toMatchObject({ status: 423, code: 'ACCOUNT_LOCKED' });
      expect(visible(locked).message).toContain('Ask the owner');
    });

    it('20 parallel wrong PINs: every attempt is either counted or refused by the lock (no lost updates)', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      const results = await Promise.all(Array.from({ length: 20 }, () => pinLogin(device, '0000')));
      const refusedByLock = results.filter((r) => r.statusCode === 423).length;
      const [row] = await asAdmin(async (c) =>
        (await c.query<{ n: number }>('SELECT pin_failed_count AS n FROM membership WHERE id = $1', [staff.membershipId])).rows,
      );
      // Which ones arrive after the lock is timing-dependent; the sum is not.
      expect(row.n + refusedByLock).toBe(20);
      expect(row.n).toBeGreaterThanOrEqual(5);
      expect(results.every((r) => r.statusCode === 401 || r.statusCode === 423)).toBe(true);
    });
  });

  describe('4. a suspended or removed membership, or a revoked device, is refused on the very next request', () => {
    for (const status of ['SUSPENDED', 'REMOVED'] as const) {
      it(`membership ${status}`, async () => {
        const biz = await createBusiness('Duka A');
        const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
        const token = tokenOf(await pinLogin(await seedDevice(staff)));
        expect((await get('/v1/me', token)).statusCode).toBe(200);
        await setMembership(staff, { status });
        expect(visible(await get('/v1/me', token))).toMatchObject({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
      });
    }

    it('device revoked', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      const token = tokenOf(await pinLogin(device));
      expect((await get('/v1/me', token)).statusCode).toBe(200);
      await setDevice(staff, device, { status: 'REVOKED' });
      expect(visible(await get('/v1/me', token))).toMatchObject({ status: 403, code: 'DEVICE_REVOKED' });
    });

    it('removed from the shared device it logged in on', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz);
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const shared = await seedDevice(owner, { shared: true, link: [owner, staff] });
      const token = tokenOf(await pinLogin(shared, PIN, staff.membershipId));
      expect((await get('/v1/me', token)).statusCode).toBe(200);
      await tenants().run(biz, () => currentTx().deviceMembership.deleteMany({ where: { membershipId: staff.membershipId } }));
      expect(visible(await get('/v1/me', token))).toMatchObject({ status: 403, code: 'DEVICE_REVOKED' });
    });
  });

  describe("5. a token for business A never reaches business B's data", () => {
    async function twoBusinesses() {
      const bizA = await createBusiness('Duka A');
      const bizB = await createBusiness('Duka B');
      const a = await seedMember(bizA);
      const b = await seedMember(bizB);
      const tokenA = tokenOf(await pinLogin(await seedDevice(a)));
      const tokenB = tokenOf(await pinLogin(await seedDevice(b)));
      return { bizA, bizB, a, b, tokenA, tokenB };
    }

    it('reads and writes stay in the token business, whatever the query or headers say', async () => {
      const { bizA, bizB, tokenA, tokenB } = await twoBusinesses();
      const create = (token: string, name: string) =>
        t.app.inject({ method: 'POST', url: '/spike/protected/products', payload: { name }, headers: { authorization: `Bearer ${token}` } });
      expect((await create(tokenA, 'A sugar')).json()).toEqual({ name: 'A sugar', business_id: bizA });
      expect((await create(tokenB, 'B rice')).json()).toEqual({ name: 'B rice', business_id: bizB });

      for (const [url, headers] of [
        ['/spike/protected/products', {}],
        [`/spike/protected/products?business_id=${bizB}`, {}],
        ['/spike/protected/products', { 'x-business-id': bizB, 'business-id': bizB }],
      ] as const) {
        expect((await get(url, tokenA, headers)).json(), url).toEqual([{ name: 'A sugar', business_id: bizA }]);
      }
    });

    it('a business_id in the body is rejected', async () => {
      const { bizB, tokenA } = await twoBusinesses();
      const res = await t.app.inject({
        method: 'POST',
        url: '/spike/protected/products',
        payload: { name: 'sneaky', business_id: bizB },
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(visible(res)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    });

    it('a correctly signed token mixing business A with a membership of B is refused', async () => {
      const { bizA, a, b } = await twoBusinesses();
      const iat = Math.floor(t.clock.now().getTime() / 1000);
      const forged = await new JwtService().signAsync(
        { sub: b.personId, mid: b.membershipId, bid: bizA, did: randomUUID(), iat, exp: iat + 900 },
        { secret: TEST_ENV.JWT_SECRET, algorithm: 'HS256', audience: 'access' },
      );
      expect(visible(await get('/v1/me', forged))).toMatchObject({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
      expect(a.businessId).toBe(bizA);
    });

    it('two businesses using real tokens at the same time each see only their own', async () => {
      const { bizA, bizB, tokenA, tokenB } = await twoBusinesses();
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => get('/spike/protected/anyone', i % 2 ? tokenB : tokenA)),
      );
      results.forEach((res, i) => {
        expect((res.json() as { business_id: string }).business_id).toBe(i % 2 ? bizB : bizA);
      });
    });
  });

  describe('6. @RequirePermission is enforced inside the tenant transaction, live', () => {
    it('an attendant is refused a manager route; an extra permission grants it; removing it refuses again', async () => {
      const biz = await createBusiness('Duka A');
      const attendant = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const token = tokenOf(await pinLogin(await seedDevice(attendant)));

      expect((await get('/spike/protected/anyone', token)).statusCode).toBe(200);
      expect(visible(await get('/spike/protected/adjust', token))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

      await setMembership(attendant, { extraPermissions: ['stock.adjust'] });
      expect((await get('/spike/protected/adjust', token)).statusCode).toBe(200);

      await setMembership(attendant, { extraPermissions: [] });
      expect(visible(await get('/spike/protected/adjust', token))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    });

    it('owner-only routes need the owner; stock.convert is never granted to an attendant', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz);
      const manager = await seedMember(biz, { rolePreset: 'MANAGER' });
      const attendant = await seedMember(biz, { rolePreset: 'ATTENDANT', extras: ['stock.convert', 'not.a.permission'] });
      const tokens = {
        owner: tokenOf(await pinLogin(await seedDevice(owner))),
        manager: tokenOf(await pinLogin(await seedDevice(manager))),
        attendant: tokenOf(await pinLogin(await seedDevice(attendant))),
      };
      expect((await get('/spike/protected/staff', tokens.owner)).statusCode).toBe(200);
      expect(visible(await get('/spike/protected/staff', tokens.manager))).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect((await get('/spike/protected/convert', tokens.manager)).statusCode).toBe(200);
      expect(visible(await get('/spike/protected/convert', tokens.attendant))).toMatchObject({ code: 'PERMISSION_DENIED' });

      const me = (await get('/v1/me', tokens.attendant)).json() as { permissions: string[] };
      expect(me.permissions).toEqual(['orders.manage', 'payments.confirm', 'sales.create', 'stock.view']);
    });
  });

  describe('7. refresh rotation', () => {
    it('rotates; the old token fails; reusing a used token revokes the whole family', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const first = await issueSession(staff, await seedDevice(staff));

      const second = await post('/v1/auth/refresh', { refresh_token: first.refreshToken });
      expect(second.statusCode).toBe(200);
      const next = second.json() as { access_token: string; refresh_token: string };
      expect((await get('/v1/me', next.access_token)).statusCode).toBe(200);

      // Reuse of the old token: refused, and the new one dies with its family.
      expect(visible(await post('/v1/auth/refresh', { refresh_token: first.refreshToken }))).toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
      expect(visible(await post('/v1/auth/refresh', { refresh_token: next.refresh_token }))).toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    });

    it('an unknown token is refused; an expired one says so; a suspended membership cannot refresh', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      expect(visible(await post('/v1/auth/refresh', { refresh_token: 'never-issued' }))).toMatchObject({ code: 'TOKEN_INVALID' });

      const old = await issueSession(staff, device);
      t.clock.advanceMinutes(31 * 24 * 60);
      expect(visible(await post('/v1/auth/refresh', { refresh_token: old.refreshToken }))).toMatchObject({ code: 'TOKEN_EXPIRED' });

      const live = await issueSession(staff, device);
      await setMembership(staff, { status: 'SUSPENDED' });
      expect(visible(await post('/v1/auth/refresh', { refresh_token: live.refreshToken }))).toMatchObject({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
    });

    it('two concurrent refreshes with the same token: exactly one succeeds (20 runs in a row)', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      for (let run = 0; run < 20; run++) {
        const session = await issueSession(staff, device);
        const results = await Promise.all([
          post('/v1/auth/refresh', { refresh_token: session.refreshToken }),
          post('/v1/auth/refresh', { refresh_token: session.refreshToken }),
        ]);
        const statuses = results.map((r) => r.statusCode).sort((x, y) => x - y);
        expect(statuses, `run ${run}`).toEqual([200, 401]);
      }
    });

    it('20 concurrent refreshes with the same token: exactly one succeeds', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const session = await issueSession(staff, await seedDevice(staff));
      const results = await Promise.all(
        Array.from({ length: 20 }, () => post('/v1/auth/refresh', { refresh_token: session.refreshToken })),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 401)).toHaveLength(19);
    });
  });

  describe('8. logout and expiry', () => {
    it('logout revokes the refresh token; the device stays registered', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const device = await seedDevice(staff);
      const login = (await pinLogin(device)).json() as { access_token: string; refresh_token: string };
      const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${login.access_token}` } });
      expect(out.statusCode).toBe(204);
      expect(visible(await post('/v1/auth/refresh', { refresh_token: login.refresh_token }))).toMatchObject({ code: 'TOKEN_INVALID' });
      expect((await pinLogin(device)).statusCode).toBe(200);
    });

    it('an expired access token gives TOKEN_EXPIRED; no or a malformed token gives TOKEN_INVALID', async () => {
      const biz = await createBusiness('Duka A');
      const staff = await seedMember(biz, { rolePreset: 'ATTENDANT' });
      const token = tokenOf(await pinLogin(await seedDevice(staff)));
      t.clock.advanceMinutes(16);
      expect(visible(await get('/v1/me', token))).toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
      expect(visible(await get('/v1/me'))).toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
      expect(visible(await get('/v1/me', 'not.a.jwt'))).toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    });

    it('a token made for another purpose (signup, selection) is not an access token', async () => {
      const biz = await createBusiness('Duka A');
      const owner = await seedMember(biz, { withPassword: true });
      const other = await createBusiness('Duka B');
      await seedMember(other, { personId: owner.personId, rolePreset: 'MANAGER' });
      const selection = (await passwordLogin(owner.email!, PASSWORD)).json() as { selection_token: string };
      expect(visible(await get('/v1/me', selection.selection_token))).toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    });
  });

  describe('9. several memberships', () => {
    async function ownerInTwo() {
      const bizA = await createBusiness('Duka A');
      const bizB = await createBusiness('Duka B');
      const owner = await seedMember(bizA, { withPassword: true });
      const inB = await seedMember(bizB, { personId: owner.personId, rolePreset: 'MANAGER' });
      return { owner, inB, bizB };
    }

    it('requires a selection, then logs in to the chosen business', async () => {
      const { owner, inB, bizB } = await ownerInTwo();
      const first = await passwordLogin(owner.email!, PASSWORD);
      const body = first.json() as { requires_selection: boolean; selection_token: string; memberships: { id: string; business_name: string }[] };
      expect(body.requires_selection).toBe(true);
      expect(body.memberships.map((m) => m.business_name)).toEqual(['Duka A', 'Duka B']);

      const second = await post('/v1/auth/login', { selection_token: body.selection_token, membership_id: inB.membershipId, device: { name: 'Phone', platform: 'android' } });
      expect(second.statusCode).toBe(200);
      const me = (await get('/v1/me', tokenOf(second))).json() as { business: { id: string }; membership: { role_preset: string } };
      expect(me).toMatchObject({ business: { id: bizB }, membership: { role_preset: 'MANAGER' } });
    });

    it('a bad, expired or mismatched selection is refused', async () => {
      const { owner } = await ownerInTwo();
      const { selection_token } = (await passwordLogin(owner.email!, PASSWORD)).json() as { selection_token: string };
      const choose = (token: string, membershipId: string) =>
        post('/v1/auth/login', { selection_token: token, membership_id: membershipId, device: { name: 'Phone', platform: 'android' } });

      expect(visible(await choose(selection_token, randomUUID()))).toMatchObject({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
      expect(visible(await choose(selection_token.slice(0, -2) + 'xx', owner.membershipId))).toMatchObject({ code: 'TOKEN_INVALID' });
      t.clock.advanceMinutes(6);
      expect(visible(await choose(selection_token, owner.membershipId))).toMatchObject({ code: 'TOKEN_EXPIRED' });
    });
  });

  it('GET /v1/me returns membership, business, device and live permissions', async () => {
    const biz = await createBusiness('Duka A');
    const manager = await seedMember(biz, { rolePreset: 'MANAGER' });
    const device = await seedDevice(manager);
    const me = (await get('/v1/me', tokenOf(await pinLogin(device)))).json() as Record<string, unknown>;
    expect(me).toEqual({
      membership: { id: manager.membershipId, display_name: expect.any(String), role_preset: 'MANAGER', status: 'ACTIVE' },
      business: { id: biz, name: 'Duka A', type: 'RETAIL' },
      device: { id: device.deviceId, name: 'Test phone', is_shared: false },
      permissions: [
        'field.settle', // field.settle and stock.transfer since Phase T1
        'orders.manage', 'payments.approve', 'payments.confirm', 'products.edit', 'reports.view',
        'sales.create', 'sales.void', 'stock.adjust', 'stock.convert', 'stock.count', 'stock.receive', 'stock.transfer', 'stock.view',
      ],
    });
  });
});
