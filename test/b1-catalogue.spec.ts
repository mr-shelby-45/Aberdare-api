import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PasswordHasher } from '../src/common/auth/password-hasher.js';
import { IdentityLookup } from '../src/database/identity-lookup.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { DevicesService } from '../src/modules/devices/devices.service.js';
import { LocationsService } from '../src/modules/locations/locations.service.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, createBusiness, resetTables } from './helpers/db.js';
import { seedShop } from './helpers/shop.js';

// Phase B1: schema, triggers, locations (docs/phase-b-design.md sections 3,
// 6 and 12). Numbers in test names refer to the B1 list in section 12.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const IP = '198.51.100.50';
let seq = 0;
const newPhone = () => `+2547${String(50_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `b1owner${++seq}@example.com`;

interface Owner {
  phone: string;
  businessId: string;
  membershipId: string;
  token: string;
}

describe('B1: schema, triggers and locations', { timeout: 120_000 }, () => {
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
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      remoteAddress: IP,
    });
  const post = (url: string, payload: object, token?: string) => call('POST', url, token, payload);
  const json = <T>(res: LightMyRequestResponse) => res.json() as T;
  const errorOf = (res: LightMyRequestResponse) => {
    const body = res.json() as { error?: { code: string; message: string } };
    return { status: res.statusCode, code: body.error?.code, message: body.error?.message };
  };

  function lastCode(outbox: { to: string; message: string }[], to: string): string {
    const msg = [...outbox].reverse().find((m) => m.to === to);
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${to}`);
    return code;
  }

  // ---------------------------------------------------------------- seeding
  /** Signup up to the signup token, so a test can control the final step. */
  async function signupToken(): Promise<{ phone: string; email: string; token: string }> {
    const phone = newPhone();
    const email = newEmail();
    expect((await post('/v1/auth/signup/start', { phone, email })).statusCode).toBe(202);
    const verified = await post('/v1/auth/signup/verify', {
      phone,
      email,
      phone_code: lastCode(sms.outbox, phone),
      email_code: lastCode(mail.outbox, email),
    });
    expect(verified.statusCode, JSON.stringify(verified.json())).toBe(200);
    return { phone, email, token: json<{ signup_token: string }>(verified).signup_token };
  }

  const signupBody = (token: string, businessName: string) => ({
    signup_token: token,
    owner_name: 'Amina',
    business_name: businessName,
    business_type: 'RETAIL',
    password: PASSWORD,
    pin: PIN,
    device: { name: "Owner's phone", platform: 'android' },
  });

  /** A real owner signup through the API. */
  async function signupOwner(businessName = 'Duka A'): Promise<Owner> {
    const s = await signupToken();
    const res = await post('/v1/auth/signup', signupBody(s.token, businessName));
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const r = json<{ access_token: string; membership: { id: string; business_id: string } }>(res);
    t.clock.advanceMinutes(2);
    return { phone: s.phone, businessId: r.membership.business_id, membershipId: r.membership.id, token: r.access_token };
  }

  /** Invite, first login and activation through the API. */
  async function activeStaff(owner: Owner, rolePreset: 'MANAGER' | 'ATTENDANT') {
    const phone = newPhone();
    const created = await post('/v1/staff', { phone, display_name: 'Baraka', role_preset: rolePreset }, owner.token);
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const tempPin = json<{ temp_pin: string }>(created).temp_pin;
    const first = await post('/v1/auth/first-login', { phone, temp_pin: tempPin });
    const setupToken = json<{ setup_token: string }>(first).setup_token;
    const res = await post('/v1/auth/staff/activate', {
      setup_token: setupToken,
      code: lastCode(sms.outbox, phone),
      new_pin: '6071',
      device: { name: 'Staff phone', platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<{ access_token: string }>(res).access_token;
  }

  /**
   * An owner of a business created without signup (as businesses made before
   * Phase B were), so it has no default location.
   */
  async function ownerWithoutDefaultLocation(): Promise<Owner> {
    const businessId = await createBusiness('Old duka');
    const phone = newPhone();
    const { personId } = await t.app.get(IdentityLookup, { strict: false }).ensurePerson(phone, t.clock.now());
    const pinHash = await t.app.get(PasswordHasher).hash(PIN);
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
    const login = await post('/v1/auth/pin', { device_id: device.deviceId, device_secret: device.deviceSecret, pin: PIN });
    expect(login.statusCode).toBe(200);
    return { phone, businessId, membershipId, token: json<{ access_token: string }>(login).access_token };
  }

  /** A shop (location, product, piece and carton) plus a member to own barcodes. */
  async function shopWithMember(name = 'Shop A') {
    const shop = await seedShop(tenants(), name);
    const personId = await asAdmin(
      async (c) => (await c.query<{ id: string }>('INSERT INTO person (phone) VALUES ($1) RETURNING id', [newPhone()])).rows[0].id,
    );
    return tenants().run(shop.biz, async () => {
      const tx = currentTx();
      const m = await tx.membership.create({
        data: { businessId: shop.biz, personId, displayName: 'Owner', rolePreset: 'OWNER', status: 'ACTIVE' },
        select: { id: true },
      });
      const piece = await tx.packType.findUniqueOrThrow({ where: { id: shop.piece } });
      return { ...shop, productId: piece.productId, membershipId: m.id };
    });
  }

  const auditActions = (businessId: string) =>
    asAdmin(
      async (c) =>
        (
          await c.query<{ action: string; target_id: string; metadata: Record<string, unknown>; actor_membership_id: string | null }>(
            'SELECT action, target_id, metadata, actor_membership_id FROM audit_log WHERE business_id = $1 ORDER BY occurred_at, action',
            [businessId],
          )
        ).rows,
    );
  const locationLog = (businessId: string) =>
    asAdmin(
      async (c) =>
        (
          await c.query<{ row_id: string; operation: string }>(
            "SELECT row_id, operation FROM change_log WHERE business_id = $1 AND table_name = 'location' ORDER BY id",
            [businessId],
          )
        ).rows,
    );

  // ---------------------------------------------------------------- 1 to 3: the database
  // Test 1 (RLS coverage includes product_barcode) is in test/step4-migrations.spec.ts.

  it('2. a barcode cannot reference a pack type of another product or of another business', async () => {
    const a = await shopWithMember('Shop A');
    const b = await shopWithMember('Shop B');
    const otherProduct = await tenants().run(a.biz, async () => {
      const tx = currentTx();
      const p = await tx.product.create({ data: { businessId: a.biz, name: 'Sugar 1kg' }, select: { id: true } });
      const pack = await tx.packType.create({
        data: { businessId: a.biz, productId: p.id, name: 'piece', unitsPerPack: 1, sellPrice: '140.00' },
        select: { id: true },
      });
      return { productId: p.id, packTypeId: pack.id };
    });
    const addBarcode = (biz: string, data: { productId: string; packTypeId: string; membershipId: string }, barcode: string) =>
      tenants().run(biz, () =>
        currentTx().productBarcode.create({
          data: { businessId: biz, barcode, productId: data.productId, packTypeId: data.packTypeId, createdByMembershipId: data.membershipId },
          select: { id: true },
        }),
      );

    // The right pack type works.
    await addBarcode(a.biz, { productId: a.productId, packTypeId: a.carton, membershipId: a.membershipId }, '06161101560029');
    // Another product's pack type in the same business is refused by the composite key.
    await expect(
      addBarcode(a.biz, { productId: a.productId, packTypeId: otherProduct.packTypeId, membershipId: a.membershipId }, '6161101560036'),
    ).rejects.toThrow(/product_barcode_business_id_product_id_pack_type_id_fkey|Foreign key constraint/);
    // Business B's product and pack type, from inside business A, are refused too.
    await expect(
      addBarcode(a.biz, { productId: b.productId, packTypeId: b.piece, membershipId: a.membershipId }, '6161101560043'),
    ).rejects.toThrow(/fkey|Foreign key constraint/);
  });

  it('3. the database refuses duplicate units, duplicate names, a second base unit and negative prices', async () => {
    const shop = await shopWithMember();
    const pack = (data: { name: string; unitsPerPack: number; sellPrice: string; costPrice?: string }) =>
      tenants().run(shop.biz, () =>
        currentTx().packType.create({ data: { businessId: shop.biz, productId: shop.productId, ...data }, select: { id: true } }),
      );
    // seedShop made "piece" (1) and "carton of 24" (24).
    await expect(pack({ name: 'box of 24', unitsPerPack: 24, sellPrice: '1.00' })).rejects.toThrow(/Unique constraint/);
    await expect(pack({ name: 'carton of 24', unitsPerPack: 12, sellPrice: '1.00' })).rejects.toThrow(/Unique constraint/);
    await expect(pack({ name: 'single', unitsPerPack: 1, sellPrice: '1.00' })).rejects.toThrow(/Unique constraint/);
    await expect(pack({ name: 'bale', unitsPerPack: 12, sellPrice: '-1.00' })).rejects.toThrow(/pack_type_sell_price_not_negative/);
    await expect(pack({ name: 'bale', unitsPerPack: 12, sellPrice: '1.00', costPrice: '-0.01' })).rejects.toThrow(
      /pack_type_cost_price_not_negative/,
    );
    await expect(pack({ name: 'pallet', unitsPerPack: 10_001, sellPrice: '1.00' })).rejects.toThrow(/pack_type_units_per_pack_max/);
    // A valid one still works, and money round-trips exactly.
    const ok = await pack({ name: 'bale of 12', unitsPerPack: 12, sellPrice: '999999999999.99', costPrice: '0.10' });
    const stored = await tenants().run(shop.biz, () =>
      currentTx().packType.findUniqueOrThrow({ where: { id: ok.id }, select: { sellPrice: true, costPrice: true } }),
    );
    expect(stored.sellPrice.toFixed(2)).toBe('999999999999.99');
    expect(stored.costPrice?.toFixed(2)).toBe('0.10');
  });

  it('inside business A, deleting business B\'s barcode affects zero rows (moved from spike step 1)', async () => {
    const a = await shopWithMember('Shop A');
    const b = await shopWithMember('Shop B');
    const bBarcode = await tenants().run(b.biz, () =>
      currentTx().productBarcode.create({
        data: { businessId: b.biz, barcode: '06161101560029', productId: b.productId, packTypeId: b.piece, createdByMembershipId: b.membershipId },
        select: { id: true },
      }),
    );
    const deleted = await tenants().run(a.biz, () => currentTx().productBarcode.deleteMany({ where: { id: bBarcode.id } }));
    expect(deleted.count).toBe(0);
    expect(await tenants().run(b.biz, () => currentTx().productBarcode.count())).toBe(1);
  });

  // ---------------------------------------------------------------- 4. sync_command timestamps
  it('4. sync_command stores occurred_at from the phone and received_at from the server clock', async () => {
    const shop = await shopWithMember();
    // The app's own dispatcher and stock.receive handler (since C2), on the app's fake clock.
    const sync = t.app.get(SyncService, { strict: false });
    const serverNow = t.clock.now().toISOString();
    const commandId = randomUUID();
    const [result] = await sync.processCommands({ businessId: shop.biz, membershipId: shop.membershipId, permissions: new Set(['stock.receive']) }, [
      {
        command_id: commandId,
        occurred_at: '2026-10-22T07:30:00.000Z',
        type: 'stock.receive',
        payload: { location_id: shop.loc, lines: [{ pack_type_id: shop.piece, quantity: 3 }] },
      },
    ]);
    expect(result).toMatchObject({ status: 'ACCEPTED' });
    const row = await tenants().run(shop.biz, () =>
      currentTx().syncCommand.findUniqueOrThrow({
        where: { businessId_commandId: { businessId: shop.biz, commandId } },
        select: { occurredAt: true, receivedAt: true },
      }),
    );
    expect(row.occurredAt.toISOString()).toBe('2026-10-22T07:30:00.000Z');
    expect(row.receivedAt.toISOString()).toBe(serverNow);

    // A command without occurred_at is rejected and stores nothing.
    const [bad] = await sync.processCommands({ businessId: shop.biz, membershipId: shop.membershipId, permissions: new Set(['stock.receive']) }, [
      { command_id: randomUUID(), type: 'stock.receive', payload: { location_id: shop.loc, lines: [{ pack_type_id: shop.piece, quantity: 3 }] } },
    ]);
    expect(bad).toMatchObject({ status: 'REJECTED', code: 'VALIDATION_FAILED' });
    expect(await tenants().run(shop.biz, () => currentTx().syncCommand.count())).toBe(1);
  });

  // ---------------------------------------------------------------- 5. default location at signup
  it('5. signup creates the default location in the same transaction', async () => {
    const o = await signupOwner();
    const res = await call('GET', '/v1/locations', o.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locations: [{ id: expect.any(String), name: 'Main shop', is_default: true, archived: false }] });
    const audit = (await auditActions(o.businessId)).filter((r) => r.action === 'location.created');
    expect(audit).toEqual([
      { action: 'location.created', target_id: json<{ locations: { id: string }[] }>(res).locations[0].id, metadata: { is_default: true }, actor_membership_id: o.membershipId },
    ]);
  });

  it('5. a forced failure after the location insert leaves no business, person, membership, device or location', async () => {
    const s = await signupToken();
    const locations = t.app.get(LocationsService, { strict: false });
    const original = locations.createDefault.bind(locations);
    vi.spyOn(locations, 'createDefault').mockImplementationOnce(async (actor) => {
      await original(actor);
      throw new Error('crash after the location insert');
    });
    const failed = await post('/v1/auth/signup', signupBody(s.token, 'Duka X'));
    expect(failed.statusCode).toBe(500);

    const counts = await asAdmin(async (c) => {
      const n = async (sql: string, params: unknown[] = []) => Number((await c.query<{ n: string }>(sql, params)).rows[0].n);
      return {
        business: await n('SELECT count(*) AS n FROM business'),
        person: await n('SELECT count(*) AS n FROM person WHERE phone = $1', [s.phone]),
        membership: await n('SELECT count(*) AS n FROM membership'),
        device: await n('SELECT count(*) AS n FROM device'),
        location: await n('SELECT count(*) AS n FROM location'),
        auditOrLog: await n('SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM change_log) AS n'),
      };
    });
    expect(counts).toEqual({ business: 0, person: 0, membership: 0, device: 0, location: 0, auditOrLog: 0 });

    // The codes were not used up either: the same token completes signup now.
    const retry = await post('/v1/auth/signup', signupBody(s.token, 'Duka X'));
    expect(retry.statusCode, JSON.stringify(retry.json())).toBe(201);
  });

  // ---------------------------------------------------------------- 6. scope
  it('6. GET /locations returns only the caller\'s own locations, even with identical names', async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    expect((await post('/v1/locations', { name: 'Store' }, a.token)).statusCode).toBe(201);
    expect((await post('/v1/locations', { name: 'Store' }, b.token)).statusCode).toBe(201);
    const ids = async (o: Owner) =>
      json<{ locations: { id: string; name: string }[] }>(await call('GET', '/v1/locations?include_archived=true', o.token)).locations;
    const inA = await ids(a);
    const inB = await ids(b);
    expect(inA.map((l) => l.name)).toEqual(['Main shop', 'Store']);
    expect(inB.map((l) => l.name)).toEqual(['Main shop', 'Store']);
    expect(inA.filter((l) => inB.some((x) => x.id === l.id))).toEqual([]);

    // Another business's location id is the same 404 as one that does not exist.
    const theirs = await call('PATCH', `/v1/locations/${inB[1].id}`, a.token, { name: 'Mine now' });
    const nowhere = await call('PATCH', `/v1/locations/${randomUUID()}`, a.token, { name: 'Mine now' });
    expect(errorOf(theirs)).toEqual({ status: 404, code: 'LOCATION_NOT_FOUND', message: 'Location not found.' });
    expect(errorOf(nowhere)).toEqual(errorOf(theirs));
    expect((await ids(b))[1].name).toBe('Store');
  });

  // ---------------------------------------------------------------- 7. permissions and rules
  it('7. POST and PATCH /locations need locations.manage: owner yes, manager and attendant no', async () => {
    const o = await signupOwner();
    const manager = await activeStaff(o, 'MANAGER');
    const attendant = await activeStaff(o, 'ATTENDANT');
    const store = json<{ id: string }>(await post('/v1/locations', { name: '  Store  ' }, o.token));

    for (const token of [manager, attendant]) {
      expect(errorOf(await post('/v1/locations', { name: 'Kiosk' }, token))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
      expect(errorOf(await call('PATCH', `/v1/locations/${store.id}`, token, { name: 'Kiosk' }))).toMatchObject({
        status: 403,
        code: 'PERMISSION_DENIED',
      });
      // Every active member can read.
      expect((await call('GET', '/v1/locations', token)).statusCode).toBe(200);
    }

    // Rename (trimmed); bad names and empty updates are refused.
    const renamed = await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: ' Back store ' });
    expect(renamed.json()).toEqual({ id: store.id, name: 'Back store', is_default: false, archived: false });
    expect(errorOf(await post('/v1/locations', { name: '   ' }, o.token))).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await post('/v1/locations', { name: 'x'.repeat(61) }, o.token))).toMatchObject({ status: 422 });
    expect(errorOf(await call('PATCH', `/v1/locations/${store.id}`, o.token, {}))).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await post('/v1/locations', { name: 'Kiosk', business_id: randomUUID() }, o.token))).toMatchObject({ status: 422 });
  });

  it('7. the default location and the last active location cannot be archived; archive and restore work', async () => {
    const o = await signupOwner();
    const list = async (includeArchived = false) =>
      json<{ locations: { id: string; name: string; is_default: boolean; archived: boolean }[] }>(
        await call('GET', `/v1/locations${includeArchived ? '?include_archived=true' : ''}`, o.token),
      ).locations;
    const main = (await list())[0];
    expect(errorOf(await call('PATCH', `/v1/locations/${main.id}`, o.token, { archived: true }))).toMatchObject({
      status: 422,
      code: 'LOCATION_IS_DEFAULT',
    });

    const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));
    const archived = await call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: true });
    expect(archived.json()).toMatchObject({ archived: true });
    expect((await list()).map((l) => l.name)).toEqual(['Main shop']);
    expect((await list(true)).map((l) => [l.name, l.archived])).toEqual([
      ['Main shop', false],
      ['Store', true],
    ]);
    const restored = await call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: false });
    expect(restored.json()).toMatchObject({ archived: false });
    expect((await list()).map((l) => l.name)).toEqual(['Main shop', 'Store']);

    // A business without a default (created before Phase B) keeps its last active location.
    const old = await ownerWithoutDefaultLocation();
    const only = json<{ id: string }>(await post('/v1/locations', { name: 'Only shop' }, old.token));
    expect(errorOf(await call('PATCH', `/v1/locations/${only.id}`, old.token, { archived: true }))).toMatchObject({
      status: 422,
      code: 'LAST_ACTIVE_LOCATION',
    });
    const second = json<{ id: string }>(await post('/v1/locations', { name: 'Second shop' }, old.token));
    expect((await call('PATCH', `/v1/locations/${only.id}`, old.token, { archived: true })).statusCode).toBe(200);
    expect(errorOf(await call('PATCH', `/v1/locations/${second.id}`, old.token, { archived: true }))).toMatchObject({
      code: 'LAST_ACTIVE_LOCATION',
    });
  });

  // ---------------------------------------------------------------- 8. change_log and audit
  it('8. location changes write change_log and audit rows', async () => {
    const o = await signupOwner();
    const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));
    await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: 'Back store' });
    await call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: true });
    await call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: false });
    // A rename to the same name changes nothing and records nothing.
    await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: 'Back store' });

    const log = (await locationLog(o.businessId)).filter((r) => r.row_id === store.id);
    expect(log.map((r) => r.operation)).toEqual(['INSERT', 'UPDATE', 'UPDATE', 'UPDATE']);
    const audit = (await auditActions(o.businessId)).filter((r) => r.target_id === store.id);
    expect(audit.map((r) => r.action).sort()).toEqual(['location.archived', 'location.created', 'location.restored', 'location.updated']);
    for (const r of audit) expect(r.actor_membership_id).toBe(o.membershipId);
    expect(audit.find((r) => r.action === 'location.updated')!.metadata).toEqual({ name_before: 'Store', name_after: 'Back store' });
  });

  it('8. a rolled-back location change writes neither change_log nor audit rows', async () => {
    const o = await signupOwner();
    const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));
    const logBefore = (await locationLog(o.businessId)).length;
    const auditBefore = (await auditActions(o.businessId)).length;

    const audit = t.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('crash after the audit write');
    });
    expect((await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: 'Back store' })).statusCode).toBe(500);

    expect((await locationLog(o.businessId)).length).toBe(logBefore);
    expect((await auditActions(o.businessId)).length).toBe(auditBefore);
    const names = json<{ locations: { name: string }[] }>(await call('GET', '/v1/locations', o.token)).locations.map((l) => l.name);
    expect(names).toEqual(['Main shop', 'Store']);
  });
});
