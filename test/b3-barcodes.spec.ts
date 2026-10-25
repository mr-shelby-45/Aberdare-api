import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';

// Phase B3: barcodes and lookup (docs/phase-b-design.md sections 4, 5, 6 and
// 12). Numbers in test names refer to the B3 list in section 12.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const IP = '198.51.100.70';
// A 12-digit UPC-A code and its 13-digit (EAN-13) form.
const UPC = '036000291452';
const EAN = '0036000291452';
let seq = 0;
const newPhone = () => `+2547${String(70_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `b3owner${++seq}@example.com`;

interface Owner {
  businessId: string;
  membershipId: string;
  token: string;
}
interface Result {
  command_id: string | null;
  status: string;
  reason?: string;
}
interface Lookup {
  pack_type_id: string;
  product: {
    id: string;
    name: string;
    archived: boolean;
    pack_types: { id: string; name: string; sell_price: string; cost_price?: string | null }[];
    barcodes: { barcode: string; pack_type_id: string }[];
  };
}

describe('B3: barcodes and lookup', { timeout: 120_000 }, () => {
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

  // ---------------------------------------------------------------- HTTP
  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      remoteAddress: IP,
    });
  const post = (url: string, payload: unknown, token?: string) => call('POST', url, token, payload);
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
    const tempPin = json<{ temp_pin: string }>(created).temp_pin;
    const first = await post('/v1/auth/first-login', { phone, temp_pin: tempPin });
    const res = await post('/v1/auth/staff/activate', {
      setup_token: json<{ setup_token: string }>(first).setup_token,
      code: lastCode(sms.outbox, phone),
      new_pin: '6071',
      device: { name: 'Staff phone', platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<{ access_token: string }>(res).access_token;
  }

  const command = (type: string, payload: object) => ({
    command_id: randomUUID(),
    type,
    occurred_at: t.clock.now().toISOString(),
    payload,
  });
  const sendOne = async (token: string, cmd: unknown) => {
    const res = await post('/v1/sync/commands', { commands: [cmd] }, token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<{ results: Result[] }>(res).results[0];
  };

  /** Creates a product with a piece (with a cost price) and a carton of 24, and no barcodes. */
  async function product(o: Owner, name = 'Maize flour 2kg') {
    const productId = randomUUID();
    const piece = randomUUID();
    const carton = randomUUID();
    const r = await sendOne(
      o.token,
      command('product.create', {
        product_id: productId,
        name,
        pack_types: [
          { pack_type_id: piece, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' },
          { pack_type_id: carton, name: 'carton of 24', units_per_pack: 24, sell_price: '4200' },
        ],
      }),
    );
    expect(r, name).toMatchObject({ status: 'ACCEPTED' });
    return { productId, piece, carton };
  }

  const add = (o: Owner, barcode: string, productId: string, packTypeId: string) =>
    sendOne(o.token, command('barcode.add', { barcode, product_id: productId, pack_type_id: packTypeId }));
  const remove = (o: Owner, barcode: string) => sendOne(o.token, command('barcode.remove', { barcode }));
  const lookup = (token: string, code: string) => call('GET', `/v1/products/by-barcode/${encodeURIComponent(code)}`, token);

  const storedCodes = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ barcode: string }>('SELECT barcode FROM product_barcode WHERE business_id = $1 ORDER BY barcode', [businessId])).rows.map(
          (r) => r.barcode,
        ),
    );
  const auditRows = (businessId: string, action: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ target_id: string; actor_membership_id: string; metadata: Record<string, unknown> }>(
          'SELECT target_id, actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action = $2 ORDER BY occurred_at',
          [businessId, action],
        )).rows,
    );

  // ---------------------------------------------------------------- 1. normalisation
  it('1. a 12-digit code is stored as 13 digits and found by both forms; leading zeros survive; check digits are not validated', async () => {
    const o = await signupOwner();
    const p = await product(o);
    expect(await add(o, UPC, p.productId, p.carton)).toMatchObject({ status: 'ACCEPTED' });
    expect(await storedCodes(o.businessId)).toEqual([EAN]);
    for (const code of [UPC, EAN, `  ${EAN}  `]) {
      const res = await lookup(o.token, code);
      expect(res.statusCode, code).toBe(200);
      expect(json<Lookup>(res)).toMatchObject({ pack_type_id: p.carton, product: { id: p.productId } });
    }
    // Leading zeros are kept as they are, and a wrong check digit is accepted.
    expect(await add(o, '00012345', p.productId, p.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(o, '0036000291453', p.productId, p.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect(await storedCodes(o.businessId)).toEqual(['00012345', EAN, '0036000291453'].sort());
    expect(json<Lookup>(await lookup(o.token, '00012345')).pack_type_id).toBe(p.piece);
    // Case is not changed: a different case is a different code.
    expect(await add(o, 'ABC-123', p.productId, p.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect((await lookup(o.token, 'abc-123')).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- 2. invalid codes
  it('2. invalid characters, fewer than 4 or more than 48 characters, and inner spaces are rejected', async () => {
    const o = await signupOwner();
    const p = await product(o);
    for (const bad of ['abc', 'x'.repeat(49), '6161 1015', 'ab#cd', 'kód12', '', '    ']) {
      expect(await add(o, bad, p.productId, p.piece), JSON.stringify(bad)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
      expect(await remove(o, bad), JSON.stringify(bad)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    expect(await add(o, 'x'.repeat(48), p.productId, p.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(o, 'a.b_c-1', p.productId, p.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect(await storedCodes(o.businessId)).toHaveLength(2);
  });

  // ---------------------------------------------------------------- 3. add rules
  it('3. barcode.add: the same code on the same pack type is an accepted no-op; on another pack type or product it is BARCODE_TAKEN', async () => {
    const o = await signupOwner();
    const p = await product(o);
    const q = await product(o, 'Sugar 1kg');
    expect(await add(o, UPC, p.productId, p.carton)).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(o, EAN, p.productId, p.carton)).toEqual(expect.objectContaining({ status: 'ACCEPTED' }));
    expect(await add(o, UPC, p.productId, p.piece)).toMatchObject({ status: 'REJECTED', reason: 'BARCODE_TAKEN' });
    expect(await add(o, UPC, q.productId, q.piece)).toMatchObject({ status: 'REJECTED', reason: 'BARCODE_TAKEN' });
    expect(await storedCodes(o.businessId)).toEqual([EAN]);
    // The no-op wrote no second audit row.
    expect(await auditRows(o.businessId, 'barcode.added')).toEqual([
      { target_id: p.productId, actor_membership_id: o.membershipId, metadata: { barcode: EAN, pack_type_id: p.carton } },
    ]);

    // References: a missing product, and a pack type of another product.
    expect(await add(o, '11112222', randomUUID(), p.piece)).toMatchObject({ status: 'REJECTED', reason: 'PRODUCT_NOT_FOUND' });
    expect(await add(o, '11112222', p.productId, q.piece)).toMatchObject({ status: 'REJECTED', reason: 'PACK_TYPE_NOT_FOUND' });
    expect(await add(o, '11112222', p.productId, randomUUID())).toMatchObject({ status: 'REJECTED', reason: 'PACK_TYPE_NOT_FOUND' });

    // Allowed on an archived product (decided in B3): its barcodes stay with it anyway.
    expect(await sendOne(o.token, command('product.update', { product_id: q.productId, archived: true }))).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(o, '33334444', q.productId, q.carton)).toMatchObject({ status: 'ACCEPTED' });
  });

  it('3. 20 concurrent adds of one code to 20 different products give exactly one ACCEPTED', async () => {
    const o = await signupOwner();
    const products = [];
    for (let i = 0; i < 20; i++) products.push(await product(o, `Product ${i}`));
    const results = await Promise.all(products.map((p) => add(o, UPC, p.productId, p.piece)));
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'BARCODE_TAKEN')).toHaveLength(19);
    expect(await storedCodes(o.businessId)).toEqual([EAN]);
    expect(await auditRows(o.businessId, 'barcode.added')).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 4. remove
  it('4. barcode.remove removes the code, it can be added again, a missing code is an accepted no-op, and the delete is logged', async () => {
    const o = await signupOwner();
    const p = await product(o);
    const q = await product(o, 'Sugar 1kg');
    expect(await add(o, UPC, p.productId, p.carton)).toMatchObject({ status: 'ACCEPTED' });
    expect(await remove(o, UPC)).toMatchObject({ status: 'ACCEPTED' });
    expect(await storedCodes(o.businessId)).toEqual([]);
    expect((await lookup(o.token, EAN)).statusCode).toBe(404);
    expect(await remove(o, UPC)).toMatchObject({ status: 'ACCEPTED' });
    // Free again, for any product.
    expect(await add(o, EAN, q.productId, q.piece)).toMatchObject({ status: 'ACCEPTED' });

    const log = await asAdmin(
      async (c) =>
        (await c.query<{ operation: string; row_key: string | null }>(
          "SELECT operation, row_key FROM change_log WHERE business_id = $1 AND table_name = 'product_barcode' ORDER BY id",
          [o.businessId],
        )).rows,
    );
    expect(log).toEqual([
      { operation: 'INSERT', row_key: EAN },
      { operation: 'DELETE', row_key: EAN },
      { operation: 'INSERT', row_key: EAN },
    ]);
    // Exactly one barcode.removed: the second remove was a no-op.
    expect(await auditRows(o.businessId, 'barcode.removed')).toEqual([
      { target_id: p.productId, actor_membership_id: o.membershipId, metadata: { barcode: EAN, pack_type_id: p.carton } },
    ]);
  });

  // ---------------------------------------------------------------- 5. two businesses
  it('5. the same code in two businesses is allowed, and each sees only its own', async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    const pa = await product(a, 'A flour');
    const pb = await product(b, 'B flour');
    expect(await add(a, UPC, pa.productId, pa.carton)).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(b, UPC, pb.productId, pb.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect(json<Lookup>(await lookup(a.token, UPC))).toMatchObject({ pack_type_id: pa.carton, product: { id: pa.productId, name: 'A flour' } });
    expect(json<Lookup>(await lookup(b.token, UPC))).toMatchObject({ pack_type_id: pb.piece, product: { id: pb.productId, name: 'B flour' } });
    // Removing in B leaves A's untouched.
    expect(await remove(b, UPC)).toMatchObject({ status: 'ACCEPTED' });
    expect(await storedCodes(a.businessId)).toEqual([EAN]);
    expect((await lookup(b.token, UPC)).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- 6. by-barcode
  it('6. by-barcode returns the product and the exact pack type; 404 for unknown, other-business and malformed codes; archived: true', async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    const pa = await product(a);
    const pb = await product(b, 'Only in B');
    expect(await add(a, UPC, pa.productId, pa.carton)).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(a, '11112222', pa.productId, pa.piece)).toMatchObject({ status: 'ACCEPTED' });
    expect(await add(b, '55556666', pb.productId, pb.piece)).toMatchObject({ status: 'ACCEPTED' });

    const found = json<Lookup>(await lookup(a.token, UPC));
    expect(found.pack_type_id).toBe(pa.carton);
    expect(found.product).toEqual({
      id: pa.productId,
      name: 'Maize flour 2kg',
      sku: null,
      archived: false,
      pack_types: [
        { id: pa.piece, name: 'piece', units_per_pack: 1, sell_price: '180.00', cost_price: '150.00', archived: false },
        { id: pa.carton, name: 'carton of 24', units_per_pack: 24, sell_price: '4200.00', cost_price: null, archived: false },
      ],
      barcodes: [
        { barcode: EAN, pack_type_id: pa.carton },
        { barcode: '11112222', pack_type_id: pa.piece },
      ],
    });

    const unknown = errorOf(await lookup(a.token, '99998888'));
    expect(unknown).toEqual({ status: 404, code: 'BARCODE_NOT_FOUND', message: expect.any(String) });
    expect(errorOf(await lookup(a.token, '55556666'))).toEqual(unknown);
    expect(errorOf(await lookup(a.token, 'ab#cd'))).toEqual(unknown);
    expect(errorOf(await lookup(a.token, 'x'.repeat(60)))).toEqual(unknown);

    expect(await sendOne(a.token, command('product.update', { product_id: pa.productId, archived: true }))).toMatchObject({ status: 'ACCEPTED' });
    expect(json<Lookup>(await lookup(a.token, UPC)).product.archived).toBe(true);

    // The code never reaches a log line (the route pattern is logged, not the URL).
    expect(t.rawLogs()).not.toContain('99998888');
    expect(t.rawLogs()).not.toContain('55556666');
  });

  // ---------------------------------------------------------------- 7. who can read
  it('7. any active member can read; the cost_price key is absent without costs.view and present with it', async () => {
    const o = await signupOwner();
    const attendant = await activeStaff(o, 'ATTENDANT');
    const manager = await activeStaff(o, 'MANAGER');
    const p = await product(o);
    expect(await add(o, UPC, p.productId, p.piece)).toMatchObject({ status: 'ACCEPTED' });

    const owner = json<Lookup>(await lookup(o.token, UPC));
    expect(owner.product.pack_types.map((x) => x.cost_price)).toEqual(['150.00', null]);
    for (const token of [attendant, manager]) {
      const res = await lookup(token, UPC);
      expect(res.statusCode).toBe(200);
      const body = json<Lookup>(res);
      for (const pack of body.product.pack_types) expect(Object.keys(pack)).not.toContain('cost_price');
      expect(JSON.stringify(body)).not.toContain('150.00');
    }
    // Barcode commands need products.edit: an attendant is refused.
    expect(await sendOne(attendant, command('barcode.add', { barcode: '11112222', product_id: p.productId, pack_type_id: p.piece }))).toMatchObject({
      status: 'REJECTED',
      reason: 'PERMISSION_DENIED',
    });
    expect(await sendOne(attendant, command('barcode.remove', { barcode: UPC }))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    expect(await storedCodes(o.businessId)).toEqual([EAN]);
    // Reads need a token.
    expect((await lookup('', UPC)).statusCode).toBe(401);
  });
});
