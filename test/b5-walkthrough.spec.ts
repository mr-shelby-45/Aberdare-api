import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';

// Phase B5 test 4: the manual walkthrough of docs/phase-b-walkthrough.md
// (design section 13), step by step, with the same values as the document,
// so the document cannot silently go stale. The dev fixed codes are switched
// on exactly as the document says (the code 123456 for listed targets).

const CODE = '123456';
const OWNER = { phone: '0712000201', email: 'catalogue-owner@example.com' };
const MANAGER_PHONE = '0712000202';
const ATTENDANT_PHONE = '0712000203';
const SECOND = { phone: '0712000209', email: 'catalogue-second@example.com' };
const ALLOWLIST = ['+254712000201', '+254712000202', '+254712000203', '+254712000209', OWNER.email, SECOND.email].join(',');

// Ids the phone would generate (fixed in the document so it can be copied).
const MAIZE = '11111111-1111-4111-8111-111111111111';
const PIECE = '22222222-2222-4222-8222-222222222222';
const CARTON = '33333333-3333-4333-8333-333333333333';
const SUGAR = '44444444-4444-4444-8444-444444444444';
const SUGAR_PIECE = '55555555-5555-4555-8555-555555555555';
const B_PRODUCT = '66666666-6666-4666-8666-666666666666';
const B_PIECE = '77777777-7777-4777-8777-777777777777';
const PIECE_CODE = '6161101560029';
const CARTON_CODE = '16161101560026';

let commandSeq = 0;
const commandId = () => `aaaaaaaa-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`;

describe('B5 test 4: the Phase B walkthrough runs end to end', { timeout: 120_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ AUTH_DEV_FIXED_CODES: 'true', AUTH_DEV_CODE_ALLOWLIST: ALLOWLIST });
    await resetTables();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: '198.51.100.99' });
  const ok = <T>(res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, JSON.stringify(res.json())).toBe(status);
    return res.json() as T;
  };
  const commands = async (token: string, type: string, payload: object) => {
    const body = ok<{ results: { status: string; reason?: string }[] }>(
      await call('POST', '/v1/sync/commands', token, { commands: [{ command_id: commandId(), type, occurred_at: t.clock.now().toISOString(), payload }] }),
    );
    return body.results[0];
  };

  async function signup(who: { phone: string; email: string }, businessName: string) {
    ok(await call('POST', '/v1/auth/signup/start', undefined, who), 202);
    const verified = ok<{ signup_token: string }>(
      await call('POST', '/v1/auth/signup/verify', undefined, { ...who, phone_code: CODE, email_code: CODE }),
    );
    const done = ok<{ access_token: string }>(
      await call('POST', '/v1/auth/signup', undefined, {
        signup_token: verified.signup_token,
        owner_name: 'Amina',
        business_name: businessName,
        business_type: 'RETAIL',
        password: 'baobab-sunrise-73',
        pin: '1357',
        device: { name: 'Amina phone', platform: 'android' },
      }),
      201,
    );
    return done.access_token;
  }

  async function staff(ownerToken: string, phone: string, name: string, role: 'MANAGER' | 'ATTENDANT') {
    const created = ok<{ temp_pin: string }>(await call('POST', '/v1/staff', ownerToken, { phone, display_name: name, role_preset: role }), 201);
    const first = ok<{ setup_token: string }>(await call('POST', '/v1/auth/first-login', undefined, { phone, temp_pin: created.temp_pin }));
    const active = ok<{ access_token: string }>(
      await call('POST', '/v1/auth/staff/activate', undefined, {
        setup_token: first.setup_token,
        code: CODE,
        new_pin: '2468',
        device: { name: `${name} phone`, platform: 'android' },
      }),
    );
    return active.access_token;
  }

  it('runs the ten steps of docs/phase-b-walkthrough.md', async () => {
    // 1. The owner signs up and sees the default "Main shop".
    const owner = await signup(OWNER, 'Duka la Amina');
    expect(ok<{ locations: unknown[] }>(await call('GET', '/v1/locations', owner)).locations).toEqual([
      { id: expect.any(String), name: 'Main shop', is_default: true, archived: false },
    ]);

    // 2. The owner adds a manager and an attendant (Phase A).
    const manager = await staff(owner, MANAGER_PHONE, 'Wanjiru', 'MANAGER');
    t.clock.advanceMinutes(2);
    const attendant = await staff(owner, ATTENDANT_PHONE, 'Baraka', 'ATTENDANT');

    // 3. The attendant tries product.create and is rejected.
    const maize = {
      product_id: MAIZE,
      name: 'Maize flour 2kg',
      pack_types: [
        { pack_type_id: PIECE, name: 'piece', units_per_pack: 1, sell_price: '180' },
        { pack_type_id: CARTON, name: 'carton of 24', units_per_pack: 24, sell_price: '4200' },
      ],
      barcodes: [
        { barcode: PIECE_CODE, pack_type_id: PIECE },
        { barcode: CARTON_CODE, pack_type_id: CARTON },
      ],
    };
    expect(await commands(attendant, 'product.create', maize)).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });

    // 4. The manager creates it.
    expect(await commands(manager, 'product.create', maize)).toMatchObject({ status: 'ACCEPTED' });

    // 5. Scanning the carton barcode gives the carton pack type.
    expect(ok<{ pack_type_id: string }>(await call('GET', `/v1/products/by-barcode/${CARTON_CODE}`, attendant)).pack_type_id).toBe(CARTON);

    // 6. "maize" is found, without any cost price.
    const found = ok<{ products: { id: string; pack_types: object[] }[] }>(await call('GET', '/v1/products?q=maize', manager));
    expect(found.products.map((p) => p.id)).toEqual([MAIZE]);
    for (const pack of found.products[0].pack_types) expect(pack).not.toHaveProperty('cost_price');

    // 7. The owner sets a cost price and sees it.
    expect(
      await commands(owner, 'pack_type.upsert', { pack_type_id: PIECE, product_id: MAIZE, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' }),
    ).toMatchObject({ status: 'ACCEPTED' });
    const withCost = ok<{ pack_types: { id: string; cost_price?: string | null }[] }>(await call('GET', `/v1/products/${MAIZE}`, owner));
    expect(withCost.pack_types.find((p) => p.id === PIECE)?.cost_price).toBe('150.00');

    // 8. The carton barcode cannot go on another product.
    const sugar = {
      product_id: SUGAR,
      name: 'Sugar 1kg',
      pack_types: [{ pack_type_id: SUGAR_PIECE, name: 'piece', units_per_pack: 1, sell_price: '140' }],
      barcodes: [],
    };
    expect(await commands(manager, 'product.create', sugar)).toMatchObject({ status: 'ACCEPTED' });
    expect(await commands(manager, 'barcode.add', { barcode: CARTON_CODE, product_id: SUGAR, pack_type_id: SUGAR_PIECE })).toMatchObject({
      status: 'REJECTED',
      reason: 'BARCODE_TAKEN',
    });

    // 9. Archived, it disappears from search, and its barcode stays reserved.
    expect(await commands(manager, 'product.update', { product_id: MAIZE, archived: true })).toMatchObject({ status: 'ACCEPTED' });
    expect(ok<{ products: unknown[] }>(await call('GET', '/v1/products?q=maize', manager)).products).toEqual([]);
    expect(await commands(manager, 'barcode.add', { barcode: CARTON_CODE, product_id: SUGAR, pack_type_id: SUGAR_PIECE })).toMatchObject({
      status: 'REJECTED',
      reason: 'BARCODE_TAKEN',
    });

    // 10. A second business finds nothing, and registers the same barcode without conflict.
    t.clock.advanceMinutes(2);
    const second = await signup(SECOND, 'Duka B');
    expect(ok<{ products: unknown[] }>(await call('GET', '/v1/products?q=maize', second)).products).toEqual([]);
    expect(
      await commands(second, 'product.create', {
        product_id: B_PRODUCT,
        name: 'Maize flour 2kg',
        pack_types: [{ pack_type_id: B_PIECE, name: 'carton', units_per_pack: 24, sell_price: '4000' }],
        barcodes: [{ barcode: CARTON_CODE, pack_type_id: B_PIECE }],
      }),
    ).toMatchObject({ status: 'ACCEPTED' });
    expect(ok<{ pack_type_id: string }>(await call('GET', `/v1/products/by-barcode/${CARTON_CODE}`, second)).pack_type_id).toBe(B_PIECE);
    expect(ok<{ pack_type_id: string }>(await call('GET', `/v1/products/by-barcode/${CARTON_CODE}`, owner)).pack_type_id).toBe(CARTON);
  });
});
