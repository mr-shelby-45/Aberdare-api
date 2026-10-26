import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container.js';
import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { OWN_TRANSACTIONS } from '../src/common/auth/own-transactions.decorator.js';
import { TenantRunner } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ProductsService } from '../src/modules/products/products.service.js';
import { StockRepository } from '../src/modules/stock/stock.repository.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';

// Phase B2: the command endpoint and the catalogue commands
// (docs/phase-b-design.md sections 4, 5, 8 and 12). Numbers in test names
// refer to the B2 list in section 12.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const IP = '198.51.100.60';
let seq = 0;
const newPhone = () => `+2547${String(60_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `b2owner${++seq}@example.com`;

interface Owner {
  businessId: string;
  membershipId: string;
  token: string;
}
interface Result {
  command_id: string | null;
  status: string;
  reason?: string;
  message?: string;
  result?: unknown;
}

describe('B2: command endpoint and catalogue commands', { timeout: 120_000 }, () => {
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

  // ---------------------------------------------------------------- HTTP
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({
      method,
      url,
      payload: payload as object,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      remoteAddress: IP,
    });
  const post = (url: string, payload: unknown, token?: string) => call('POST', url, token, payload);
  const json = <T>(res: LightMyRequestResponse) => res.json() as T;
  const errorOf = (res: LightMyRequestResponse) => {
    const body = res.json() as { error?: { code: string } };
    return { status: res.statusCode, code: body.error?.code };
  };

  function lastCode(outbox: { to: string; message: string }[], to: string): string {
    const msg = [...outbox].reverse().find((m) => m.to === to);
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${to}`);
    return code;
  }

  // ---------------------------------------------------------------- seeding
  async function signupOwner(businessName = 'Duka A'): Promise<Owner> {
    const phone = newPhone();
    const email = newEmail();
    expect((await post('/v1/auth/signup/start', { phone, email })).statusCode).toBe(202);
    const verified = await post('/v1/auth/signup/verify', {
      phone,
      email,
      phone_code: lastCode(sms.outbox, phone),
      email_code: lastCode(mail.outbox, email),
    });
    const res = await post('/v1/auth/signup', {
      signup_token: json<{ signup_token: string }>(verified).signup_token,
      owner_name: 'Amina',
      business_name: businessName,
      business_type: 'RETAIL',
      password: PASSWORD,
      pin: PIN,
      device: { name: "Owner's phone", platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const r = json<{ access_token: string; membership: { id: string; business_id: string } }>(res);
    t.clock.advanceMinutes(2);
    return { businessId: r.membership.business_id, membershipId: r.membership.id, token: r.access_token };
  }

  async function activeStaff(owner: Owner, rolePreset: 'MANAGER' | 'ATTENDANT') {
    const phone = newPhone();
    const created = await post('/v1/staff', { phone, display_name: 'Baraka', role_preset: rolePreset }, owner.token);
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const { membership_id: membershipId, temp_pin: tempPin } = json<{ membership_id: string; temp_pin: string }>(created);
    const first = await post('/v1/auth/first-login', { phone, temp_pin: tempPin });
    const res = await post('/v1/auth/staff/activate', {
      setup_token: json<{ setup_token: string }>(first).setup_token,
      code: lastCode(sms.outbox, phone),
      new_pin: '6071',
      device: { name: 'Staff phone', platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return { membershipId, token: json<{ access_token: string }>(res).access_token };
  }

  // ---------------------------------------------------------------- commands
  const command = (type: string, payload: object, extra: object = {}) => ({
    command_id: randomUUID(),
    type,
    occurred_at: t.clock.now().toISOString(),
    payload,
    ...extra,
  });

  /** A product with a piece and a carton of 24; ids are returned for later commands. */
  function newProduct(overrides: Partial<{ name: string; sku: string | null; barcodes: { barcode: string; pack: 'piece' | 'carton' }[]; costPrice: string }> = {}) {
    const productId = randomUUID();
    const piece = randomUUID();
    const carton = randomUUID();
    const payload = {
      product_id: productId,
      name: overrides.name ?? 'Maize flour 2kg',
      ...(overrides.sku !== undefined ? { sku: overrides.sku } : {}),
      pack_types: [
        { pack_type_id: piece, name: 'piece', units_per_pack: 1, sell_price: '180', ...(overrides.costPrice ? { cost_price: overrides.costPrice } : {}) },
        { pack_type_id: carton, name: 'carton of 24', units_per_pack: 24, sell_price: '4200.00' },
      ],
      barcodes: (overrides.barcodes ?? []).map((b) => ({ barcode: b.barcode, pack_type_id: b.pack === 'piece' ? piece : carton })),
    };
    return { productId, piece, carton, payload, cmd: command('product.create', payload) };
  }

  const send = async (token: string, commands: unknown[]) => {
    const res = await post('/v1/sync/commands', { commands }, token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<{ results: Result[] }>(res).results;
  };
  const sendOne = async (token: string, cmd: unknown) => (await send(token, [cmd]))[0];

  // ---------------------------------------------------------------- database reads (as superuser, tests only)
  const productRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ id: string; name: string; sku: string | null; archived: boolean }>(
          'SELECT id, name, sku, archived_at IS NOT NULL AS archived FROM product WHERE business_id = $1 ORDER BY name, id',
          [businessId],
        )).rows,
    );
  const packRows = (productId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ id: string; name: string; units_per_pack: number; sell_price: string; cost_price: string | null; archived: boolean }>(
          `SELECT id, name, units_per_pack, sell_price::text AS sell_price, cost_price::text AS cost_price,
                  archived_at IS NOT NULL AS archived
             FROM pack_type WHERE product_id = $1 ORDER BY units_per_pack`,
          [productId],
        )).rows,
    );
  const auditRows = (businessId: string, prefix: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ action: string; target_id: string; actor_membership_id: string | null; metadata: Record<string, unknown> }>(
          `SELECT action, target_id, actor_membership_id, metadata FROM audit_log
            WHERE business_id = $1 AND action LIKE $2 ORDER BY occurred_at, action`,
          [businessId, `${prefix}%`],
        )).rows,
    );
  const commandRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ command_id: string; occurred_at: Date; received_at: Date; status: string }>(
          'SELECT command_id, occurred_at, received_at, status FROM sync_command WHERE business_id = $1',
          [businessId],
        )).rows,
    );

  // ---------------------------------------------------------------- 1. the endpoint
  describe('1. the endpoint', () => {
    it('needs a token, and refuses bad batches as a whole', async () => {
      const o = await signupOwner();
      expect(errorOf(await post('/v1/sync/commands', { commands: [newProduct().cmd] }))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
      expect(errorOf(await post('/v1/sync/commands', { commands: [] }, o.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      expect(errorOf(await post('/v1/sync/commands', { commands: 'x' }, o.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      expect(errorOf(await post('/v1/sync/commands', { commands: [newProduct().cmd], business_id: o.businessId }, o.token))).toEqual({
        status: 422,
        code: 'VALIDATION_FAILED',
      });
      const many = Array.from({ length: 101 }, () => newProduct().cmd);
      expect(errorOf(await post('/v1/sync/commands', { commands: many }, o.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
      const huge = { commands: [command('product.create', { product_id: randomUUID(), name: 'x'.repeat(1_100_000) })] };
      expect(errorOf(await post('/v1/sync/commands', huge, o.token))).toEqual({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
      // Nothing was processed.
      expect(await commandRows(o.businessId)).toEqual([]);
      expect(await productRows(o.businessId)).toEqual([]);
    });

    it('rejects a bad command id or an unknown type cleanly, and answers in request order', async () => {
      const o = await signupOwner();
      const a = newProduct({ name: 'Apple juice' });
      const z = newProduct({ name: 'Zebra biscuits' });
      const results = await send(o.token, [
        z.cmd,
        { ...newProduct().cmd, command_id: 'not-a-uuid' },
        command('product.teleport', {}),
        a.cmd,
      ]);
      expect(results).toEqual([
        { command_id: z.cmd.command_id, status: 'ACCEPTED' },
        { command_id: null, status: 'REJECTED', reason: 'VALIDATION_FAILED', message: expect.any(String) },
        { command_id: expect.any(String), status: 'REJECTED', reason: 'UNKNOWN_COMMAND_TYPE', message: expect.any(String) },
        { command_id: a.cmd.command_id, status: 'ACCEPTED' },
      ]);
      // The phone sees reason and result, never the internal names.
      expect(JSON.stringify(results)).not.toMatch(/"code"|"data"|"failure"/);
    });

    it("refuses a suspended member's batch before any command runs", async () => {
      const o = await signupOwner();
      const manager = await activeStaff(o, 'MANAGER');
      expect((await post(`/v1/staff/${manager.membershipId}/suspend`, {}, o.token)).statusCode).toBe(204);
      const res = await post('/v1/sync/commands', { commands: [newProduct().cmd] }, manager.token);
      expect(errorOf(res)).toEqual({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
      expect(await commandRows(o.businessId)).toEqual([]);
      expect(await productRows(o.businessId)).toEqual([]);
    });

    it('the @OwnTransactions marker is used by POST /v1/sync/commands only', () => {
      const reflector = new Reflector();
      const marked: string[] = [];
      for (const mod of t.app.get(ModulesContainer).values()) {
        for (const wrapper of mod.controllers.values()) {
          const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
          if (!controller) continue;
          const base = reflector.get<string>('path', controller);
          for (const name of Object.getOwnPropertyNames(controller.prototype)) {
            const handler = (controller.prototype as Record<string, unknown>)[name];
            if (name === 'constructor' || typeof handler !== 'function') continue;
            const fn = handler as (...args: unknown[]) => unknown;
            if (reflector.getAllAndOverride<boolean>(OWN_TRANSACTIONS, [fn, controller])) {
              marked.push(`${base}/${reflector.get<string>('path', fn)}`);
            }
          }
        }
      }
      expect(marked).toEqual(['v1/sync/commands']);
    });
  });

  // ---------------------------------------------------------------- 2. one transaction per command
  it('2. each command has its own transaction: command 3 rejected, the rest accepted', async () => {
    const o = await signupOwner();
    const ok = [1, 2, 4, 5].map((n) => newProduct({ name: `Product ${n}` }));
    const bad = newProduct({ name: 'Product 3' });
    bad.payload.pack_types[1].units_per_pack = 1; // a second base unit
    const results = await send(o.token, [ok[0].cmd, ok[1].cmd, command('product.create', bad.payload), ok[2].cmd, ok[3].cmd]);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['ACCEPTED', undefined],
      ['ACCEPTED', undefined],
      ['REJECTED', 'BASE_UNIT_DUPLICATE'],
      ['ACCEPTED', undefined],
      ['ACCEPTED', undefined],
    ]);
    expect((await productRows(o.businessId)).map((p) => p.name)).toEqual(['Product 1', 'Product 2', 'Product 4', 'Product 5']);
  });

  it('2. an unexpected crash in one command is FAILED, logged without its payload, and does not affect the others', async () => {
    const o = await signupOwner();
    const products = t.app.get(ProductsService, { strict: false });
    const original = products.createProduct.bind(products);
    let calls = 0;
    vi.spyOn(products, 'createProduct').mockImplementation(async (dto, actor) => {
      calls += 1;
      if (calls === 2) throw new Error('database went away');
      return original(dto, actor);
    });
    const [p1, p2, p3] = [newProduct({ name: 'Secret recipe flour', sku: 'SKU-ONE' }), newProduct({ name: 'Crash me tea', sku: 'SKU-CRASH' }), newProduct({ name: 'Third' })];
    const results = await send(o.token, [p1.cmd, p2.cmd, p3.cmd]);
    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'FAILED', 'ACCEPTED']);
    expect(results[1]).toEqual({ command_id: p2.cmd.command_id, status: 'FAILED', reason: 'INTERNAL_ERROR', message: expect.any(String) });
    // Nothing of the failed command was stored, so a retry processes it again.
    expect((await commandRows(o.businessId)).map((c) => c.command_id).sort()).toEqual([p1.cmd.command_id, p3.cmd.command_id].sort());
    const retried = await sendOne(o.token, p2.cmd);
    expect(retried.status).toBe('ACCEPTED');

    const line = t.logs.find((l) => l.msg === 'sync command failed');
    expect(line).toMatchObject({ commandId: p2.cmd.command_id, commandType: 'product.create', errorName: 'Error' });
    expect(t.rawLogs()).not.toMatch(/Crash me tea|SKU-CRASH|4200|database went away/);
  });

  // ---------------------------------------------------------------- 3. permissions
  it('3. an attendant gets REJECTED / PERMISSION_DENIED for product.create; a manager succeeds', async () => {
    const o = await signupOwner();
    const attendant = await activeStaff(o, 'ATTENDANT');
    const manager = await activeStaff(o, 'MANAGER');
    expect(await sendOne(attendant.token, newProduct().cmd)).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    expect(await sendOne(manager.token, newProduct().cmd)).toMatchObject({ status: 'ACCEPTED' });
    expect(await productRows(o.businessId)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 4. atomic create
  it('4. product.create is atomic: a barcode conflict leaves no product and no pack types', async () => {
    const o = await signupOwner();
    expect(await sendOne(o.token, newProduct({ name: 'First', barcodes: [{ barcode: '036000291452', pack: 'piece' }] }).cmd)).toMatchObject({
      status: 'ACCEPTED',
    });
    const second = newProduct({ name: 'Second', barcodes: [{ barcode: '6161101560036', pack: 'piece' }, { barcode: '0036000291452', pack: 'carton' }] });
    expect(await sendOne(o.token, second.cmd)).toMatchObject({ status: 'REJECTED', reason: 'BARCODE_TAKEN' });
    expect((await productRows(o.businessId)).map((p) => p.name)).toEqual(['First']);
    expect(await packRows(second.productId)).toEqual([]);
    const codes = await asAdmin(async (c) => (await c.query<{ barcode: string }>('SELECT barcode FROM product_barcode ORDER BY 1')).rows);
    // The 12-digit code was stored as 13 digits; the free code of the rejected product was not stored.
    expect(codes.map((r) => r.barcode)).toEqual(['0036000291452']);
  });

  // ---------------------------------------------------------------- 5. idempotent
  it('5. the same command id twice, and 20 at once, creates one product and returns the same result', async () => {
    const o = await signupOwner();
    const p = newProduct();
    const first = await sendOne(o.token, p.cmd);
    const again = await sendOne(o.token, p.cmd);
    expect(again).toEqual(first);

    const q = newProduct({ name: 'Sugar 1kg' });
    const results = await Promise.all(Array.from({ length: 20 }, () => sendOne(o.token, q.cmd)));
    for (const r of results) expect(r).toEqual({ command_id: q.cmd.command_id, status: 'ACCEPTED' });
    expect((await productRows(o.businessId)).map((r) => r.name)).toEqual(['Maize flour 2kg', 'Sugar 1kg']);
    expect(await commandRows(o.businessId)).toHaveLength(2);
  });

  // ---------------------------------------------------------------- 6. SKU
  it('6. 20 concurrent creates with one SKU give exactly one ACCEPTED; another business may use it', async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => sendOne(a.token, newProduct({ name: `Unga ${i}`, sku: 'UNGA-2KG' }).cmd)));
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'SKU_TAKEN')).toHaveLength(19);
    expect(await productRows(a.businessId)).toHaveLength(1);
    expect(await sendOne(b.token, newProduct({ sku: 'UNGA-2KG' }).cmd)).toMatchObject({ status: 'ACCEPTED' });
  });

  // ---------------------------------------------------------------- 7. money
  it('7. money: only valid strings are accepted, values round-trip exactly with two decimals', async () => {
    const o = await signupOwner();
    for (const [price, stored] of [
      ['0.10', '0.10'],
      ['180', '180.00'],
      ['999999999999.99', '999999999999.99'],
      ['007.5', '7.50'],
    ]) {
      const p = newProduct({ name: `Priced ${price}` });
      p.payload.pack_types[0].sell_price = price;
      expect(await sendOne(o.token, command('product.create', p.payload)), price).toMatchObject({ status: 'ACCEPTED' });
      expect((await packRows(p.productId))[0].sell_price).toBe(stored);
    }
    for (const price of [180, '-1', '0.125', '.5', '1e3', '1234567890123', '', ' 5', '5.', 'NaN', null]) {
      const p = newProduct();
      (p.payload.pack_types[0] as { sell_price: unknown }).sell_price = price;
      expect(await sendOne(o.token, command('product.create', p.payload)), String(price)).toMatchObject({
        status: 'REJECTED',
        reason: 'VALIDATION_FAILED',
      });
    }
  });

  // ---------------------------------------------------------------- 8. cost price
  it('8. cost_price needs costs.view: rejected without it, accepted with the extra permission', async () => {
    const o = await signupOwner();
    const manager = await activeStaff(o, 'MANAGER');
    expect(await sendOne(manager.token, newProduct({ costPrice: '150.00' }).cmd)).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    // Clearing a cost price is changing it too.
    const p = newProduct();
    expect(await sendOne(manager.token, p.cmd)).toMatchObject({ status: 'ACCEPTED' });
    const clear = command('pack_type.upsert', { pack_type_id: p.piece, product_id: p.productId, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: null });
    expect(await sendOne(manager.token, clear)).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });

    expect((await call('PATCH', `/v1/staff/${manager.membershipId}`, o.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    const withCost = newProduct({ name: 'With cost', costPrice: '150' });
    expect(await sendOne(manager.token, withCost.cmd)).toMatchObject({ status: 'ACCEPTED' });
    expect((await packRows(withCost.productId))[0].cost_price).toBe('150.00');
    expect(await sendOne(manager.token, command('pack_type.upsert', { ...clear.payload, pack_type_id: withCost.piece, product_id: withCost.productId }))).toMatchObject({
      status: 'ACCEPTED',
    });
    expect((await packRows(withCost.productId))[0].cost_price).toBeNull();
  });

  // ---------------------------------------------------------------- 9. pack rules
  it('9. pack rules on create: zero, seven, duplicate units, duplicate name and a second base unit', async () => {
    const o = await signupOwner();
    const reasonFor = async (mutate: (p: ReturnType<typeof newProduct>['payload']) => void) => {
      const p = newProduct();
      mutate(p.payload);
      return (await sendOne(o.token, command('product.create', p.payload))).reason;
    };
    expect(await reasonFor((p) => (p.pack_types = []))).toBe('VALIDATION_FAILED');
    expect(
      await reasonFor((p) => {
        p.pack_types = Array.from({ length: 7 }, (_, i) => ({ pack_type_id: randomUUID(), name: `pack ${i}`, units_per_pack: i + 1, sell_price: '1' }));
      }),
    ).toBe('PACK_LIMIT_REACHED');
    expect(await reasonFor((p) => (p.pack_types[1].units_per_pack = 1))).toBe('BASE_UNIT_DUPLICATE');
    expect(await reasonFor((p) => p.pack_types.push({ pack_type_id: randomUUID(), name: 'box', units_per_pack: 24, sell_price: '1' }))).toBe('PACK_UNITS_DUPLICATE');
    expect(await reasonFor((p) => p.pack_types.push({ pack_type_id: randomUUID(), name: 'piece', units_per_pack: 6, sell_price: '1' }))).toBe('PACK_NAME_DUPLICATE');
    expect(await productRows(o.businessId)).toEqual([]);
  });

  it('9. pack rules on upsert: the database backstops, LAST_ACTIVE_PACK, and the limit counts active pack types only', async () => {
    const o = await signupOwner();
    const p = newProduct();
    expect(await sendOne(o.token, p.cmd)).toMatchObject({ status: 'ACCEPTED' });
    const upsert = (fields: Partial<{ pack_type_id: string; name: string; units_per_pack: number; archived: boolean }>) =>
      sendOne(
        o.token,
        command('pack_type.upsert', { pack_type_id: randomUUID(), product_id: p.productId, name: 'new pack', units_per_pack: 6, sell_price: '10', ...fields }),
      );
    // These reach the database constraints (the service does not pre-check against stored rows).
    expect((await upsert({ name: 'single', units_per_pack: 1 })).reason).toBe('BASE_UNIT_DUPLICATE');
    expect((await upsert({ name: 'box', units_per_pack: 24 })).reason).toBe('PACK_UNITS_DUPLICATE');
    expect((await upsert({ name: 'carton of 24', units_per_pack: 12 })).reason).toBe('PACK_NAME_DUPLICATE');

    // Fill up to 6 active pack types; the 7th is refused.
    const extra = [];
    for (const units of [6, 12, 48, 96]) {
      const id = randomUUID();
      extra.push(id);
      expect(await upsert({ pack_type_id: id, name: `pack of ${units}`, units_per_pack: units })).toMatchObject({ status: 'ACCEPTED' });
    }
    expect((await upsert({ name: 'pack of 3', units_per_pack: 3 })).reason).toBe('PACK_LIMIT_REACHED');
    // Archived pack types do not count.
    expect(await upsert({ pack_type_id: extra[0], name: 'pack of 6', units_per_pack: 6, archived: true })).toMatchObject({ status: 'ACCEPTED' });
    expect(await upsert({ name: 'pack of 3', units_per_pack: 3 })).toMatchObject({ status: 'ACCEPTED' });
    // Restoring the archived one would make 7 active.
    expect((await upsert({ pack_type_id: extra[0], name: 'pack of 6', units_per_pack: 6, archived: false })).reason).toBe('PACK_LIMIT_REACHED');

    // A product with one active pack type cannot archive it.
    const single = newProduct({ name: 'Single pack' });
    single.payload.pack_types = [single.payload.pack_types[0]];
    expect(await sendOne(o.token, command('product.create', single.payload))).toMatchObject({ status: 'ACCEPTED' });
    const archiveLast = command('pack_type.upsert', { pack_type_id: single.piece, product_id: single.productId, name: 'piece', units_per_pack: 1, sell_price: '180', archived: true });
    expect(await sendOne(o.token, archiveLast)).toMatchObject({ status: 'REJECTED', reason: 'LAST_ACTIVE_PACK' });
  });

  // ---------------------------------------------------------------- 10. product.update
  it('10. product.update changes only the fields sent; empty is rejected; archive and restore; archived barcodes stay reserved', async () => {
    const o = await signupOwner();
    const p = newProduct({ sku: 'MF-2', barcodes: [{ barcode: '036000291452', pack: 'piece' }] });
    expect(await sendOne(o.token, p.cmd)).toMatchObject({ status: 'ACCEPTED' });
    const update = (fields: object) => sendOne(o.token, command('product.update', { product_id: p.productId, ...fields }));

    expect(await update({})).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await update({ name: null })).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await update({ name: '  Maize flour 2 kg ' })).toMatchObject({ status: 'ACCEPTED' });
    expect((await productRows(o.businessId))[0]).toEqual({ id: p.productId, name: 'Maize flour 2 kg', sku: 'MF-2', archived: false });
    expect(await update({ sku: null })).toMatchObject({ status: 'ACCEPTED' });
    expect((await productRows(o.businessId))[0].sku).toBeNull();

    expect(await update({ archived: true })).toMatchObject({ status: 'ACCEPTED' });
    expect((await productRows(o.businessId))[0]).toMatchObject({ name: 'Maize flour 2 kg', archived: true });
    expect(await sendOne(o.token, newProduct({ name: 'Copycat', barcodes: [{ barcode: '0036000291452', pack: 'carton' }] }).cmd)).toMatchObject({
      status: 'REJECTED',
      reason: 'BARCODE_TAKEN',
    });
    expect(await update({ archived: false })).toMatchObject({ status: 'ACCEPTED' });
    expect((await productRows(o.businessId))[0].archived).toBe(false);
    expect(await update({ name: 'x'.repeat(121) })).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
  });

  // ---------------------------------------------------------------- 11. units lock
  it('11. units_per_pack can change before any stock movement and is locked after one', async () => {
    const o = await signupOwner();
    const p = newProduct();
    expect(await sendOne(o.token, p.cmd)).toMatchObject({ status: 'ACCEPTED' });
    const carton = (units: number, sell = '4200.00') =>
      command('pack_type.upsert', { pack_type_id: p.carton, product_id: p.productId, name: 'carton', units_per_pack: units, sell_price: sell });
    expect(await sendOne(o.token, carton(12))).toMatchObject({ status: 'ACCEPTED' });

    // A movement fixture through the stock repository (stock commands are Phase C).
    const locationId = await asAdmin(
      async (c) => (await c.query<{ id: string }>('SELECT id FROM location WHERE business_id = $1', [o.businessId])).rows[0].id,
    );
    const stock = new StockService(new StockRepository());
    await t.app.get(TenantRunner, { strict: false }).run(o.businessId, () => stock.receive(locationId, p.carton, 3, { occurredAt: t.clock.now(), createdByMembershipId: o.membershipId, syncCommandId: null }));

    expect(await sendOne(o.token, carton(24))).toMatchObject({ status: 'REJECTED', reason: 'UNITS_LOCKED' });
    // Everything else can still change.
    expect(await sendOne(o.token, carton(12, '2100.00'))).toMatchObject({ status: 'ACCEPTED' });
    expect((await packRows(p.productId)).find((x) => x.id === p.carton)).toMatchObject({ units_per_pack: 12, sell_price: '2100.00' });
  });

  // ---------------------------------------------------------------- 12. other businesses
  it("12. another business's product or pack type gets the same answer as one that does not exist", async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    const bp = newProduct({ name: 'B product' });
    expect(await sendOne(b.token, bp.cmd)).toMatchObject({ status: 'ACCEPTED' });

    const strip = (r: Result) => ({ status: r.status, reason: r.reason, message: r.message });
    const updateTheirs = await sendOne(a.token, command('product.update', { product_id: bp.productId, name: 'Hacked' }));
    const updateNowhere = await sendOne(a.token, command('product.update', { product_id: randomUUID(), name: 'Hacked' }));
    expect(strip(updateTheirs)).toMatchObject({ status: 'REJECTED', reason: 'PRODUCT_NOT_FOUND' });
    expect(strip(updateTheirs)).toEqual(strip(updateNowhere));

    const packOnTheirs = (productId: string) =>
      command('pack_type.upsert', { pack_type_id: randomUUID(), product_id: productId, name: 'bale', units_per_pack: 6, sell_price: '1' });
    expect(strip(await sendOne(a.token, packOnTheirs(bp.productId)))).toEqual(strip(await sendOne(a.token, packOnTheirs(randomUUID()))));

    // A barcode on B's pack type, from a product.create in A.
    const ap = newProduct({ name: 'A product' });
    const theirsPack = { ...ap.payload, barcodes: [{ barcode: '036000291452', pack_type_id: bp.piece }] };
    const nowherePack = { ...ap.payload, barcodes: [{ barcode: '036000291452', pack_type_id: randomUUID() }] };
    const r1 = await sendOne(a.token, command('product.create', theirsPack));
    const r2 = await sendOne(a.token, command('product.create', nowherePack));
    expect(strip(r1)).toMatchObject({ reason: 'PACK_TYPE_NOT_FOUND' });
    expect(strip(r1)).toEqual(strip(r2));

    // Accepted risk (decided in B2): upserting a pack type id that exists in another
    // business answers ALREADY_EXISTS and changes nothing there.
    const own = newProduct({ name: 'A own' });
    expect(await sendOne(a.token, own.cmd)).toMatchObject({ status: 'ACCEPTED' });
    const steal = command('pack_type.upsert', { pack_type_id: bp.carton, product_id: own.productId, name: 'stolen', units_per_pack: 6, sell_price: '1' });
    expect(await sendOne(a.token, steal)).toMatchObject({ status: 'REJECTED', reason: 'ALREADY_EXISTS' });
    expect((await packRows(bp.productId)).map((x) => x.name)).toEqual(['piece', 'carton of 24']);
    expect((await productRows(b.businessId)).map((x) => x.name)).toEqual(['B product']);
  });

  // ---------------------------------------------------------------- 13. payload and time rules
  it('13. business_id in a payload is rejected; occurred_at more than 24 hours ahead is rejected; both times are stored', async () => {
    const o = await signupOwner();
    const p = newProduct();
    expect(await sendOne(o.token, command('product.create', { ...p.payload, business_id: o.businessId }))).toMatchObject({
      reason: 'VALIDATION_FAILED',
    });
    const nested = newProduct();
    (nested.payload.pack_types[0] as Record<string, unknown>).business_id = o.businessId;
    expect(await sendOne(o.token, command('product.create', nested.payload))).toMatchObject({ reason: 'VALIDATION_FAILED' });

    const now = t.clock.now().getTime();
    const ahead = newProduct({ name: 'Future' });
    const future = command('product.create', ahead.payload, { occurred_at: new Date(now + 25 * 3_600_000).toISOString() });
    expect(await sendOne(o.token, future)).toMatchObject({ status: 'REJECTED', reason: 'OCCURRED_AT_INVALID' });
    const soon = command('product.create', newProduct({ name: 'Slightly ahead' }).payload, { occurred_at: new Date(now + 23 * 3_600_000).toISOString() });
    expect(await sendOne(o.token, soon)).toMatchObject({ status: 'ACCEPTED' });
    const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();
    const old = command('product.create', newProduct({ name: 'Offline for days' }).payload, { occurred_at: threeDaysAgo });
    expect(await sendOne(o.token, old)).toMatchObject({ status: 'ACCEPTED' });

    const row = (await commandRows(o.businessId)).find((c) => c.command_id === old.command_id)!;
    expect(row.occurred_at.toISOString()).toBe(threeDaysAgo);
    expect(row.received_at.toISOString()).toBe(new Date(now).toISOString());
    expect(await productRows(o.businessId)).toHaveLength(2);
  });

  // ---------------------------------------------------------------- 14. audit
  it('14. audit rows record the changes, with before and after values, by the acting member', async () => {
    const o = await signupOwner();
    const manager = await activeStaff(o, 'MANAGER');
    const p = newProduct({ sku: 'MF-2', costPrice: '150', barcodes: [{ barcode: '036000291452', pack: 'carton' }] });
    expect(await sendOne(o.token, p.cmd)).toMatchObject({ status: 'ACCEPTED' });
    expect(await sendOne(manager.token, command('product.update', { product_id: p.productId, name: 'Maize 2kg', archived: true }))).toMatchObject({
      status: 'ACCEPTED',
    });
    expect(await sendOne(manager.token, command('product.update', { product_id: p.productId, archived: false }))).toMatchObject({ status: 'ACCEPTED' });
    const change = command('pack_type.upsert', {
      pack_type_id: p.carton,
      product_id: p.productId,
      name: 'carton of 12',
      units_per_pack: 12,
      sell_price: '2100',
    });
    expect(await sendOne(manager.token, change)).toMatchObject({ status: 'ACCEPTED' });

    const created = await auditRows(o.businessId, 'product.created');
    expect(created).toEqual([{ action: 'product.created', target_id: p.productId, actor_membership_id: o.membershipId, metadata: { name: 'Maize flour 2kg', sku: 'MF-2' } }]);
    const packs = await auditRows(o.businessId, 'pack_type.created');
    expect(packs.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { product_id: p.productId, name: 'piece', units_per_pack: 1, sell_price: '180.00', cost_price: '150.00' },
        { product_id: p.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4200.00', cost_price: null },
      ]),
    );
    expect((await auditRows(o.businessId, 'barcode.added')).map((r) => r.metadata)).toEqual([{ barcode: '0036000291452', pack_type_id: p.carton }]);
    const updated = await auditRows(o.businessId, 'product.updated');
    expect(updated).toEqual([
      { action: 'product.updated', target_id: p.productId, actor_membership_id: manager.membershipId, metadata: { changed: ['name'], name_before: 'Maize flour 2kg', name_after: 'Maize 2kg' } },
    ]);
    expect((await auditRows(o.businessId, 'product.archived')).map((r) => r.actor_membership_id)).toEqual([manager.membershipId]);
    expect(await auditRows(o.businessId, 'product.restored')).toHaveLength(1);
    expect((await auditRows(o.businessId, 'pack_type.updated')).map((r) => r.metadata)).toEqual([
      {
        product_id: p.productId,
        name_before: 'carton of 24',
        name_after: 'carton of 12',
        units_per_pack_before: 24,
        units_per_pack_after: 12,
        sell_price_before: '4200.00',
        sell_price_after: '2100.00',
      },
    ]);
  });

  it('14. a forced failure after the audit insert leaves no audit row and no data change', async () => {
    const o = await signupOwner();
    const p = newProduct();
    expect(await sendOne(o.token, p.cmd)).toMatchObject({ status: 'ACCEPTED' });
    const audit = t.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('crash after the audit write');
    });
    const rename = command('product.update', { product_id: p.productId, name: 'Never saved' });
    expect(await sendOne(o.token, rename)).toMatchObject({ status: 'FAILED' });
    expect(await auditRows(o.businessId, 'product.updated')).toEqual([]);
    expect((await productRows(o.businessId))[0].name).toBe('Maize flour 2kg');
    expect((await commandRows(o.businessId)).some((c) => c.command_id === rename.command_id)).toBe(false);
  });

  it('AuditService allows exactly the keys barcode and barcodes; code-like keys are still refused', async () => {
    const o = await signupOwner();
    const audit = t.app.get(AuditService, { strict: false });
    const tenants = t.app.get(TenantRunner, { strict: false });
    const record = (key: string) =>
      tenants.run(o.businessId, () => audit.record({ action: 'product.updated', targetType: 'product', targetId: null, metadata: { [key]: 'x' } }));
    await expect(record('barcode')).resolves.toBeUndefined();
    await expect(record('barcodes')).resolves.toBeUndefined();
    for (const key of ['code', 'otp_code', 'barcode_secret', 'Barcode']) {
      await expect(record(key), key).rejects.toThrow(/looks like a secret/);
    }
  });
});
