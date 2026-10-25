import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';

// Phase B4: search and listing (docs/phase-b-design.md sections 6, 12 and 14).
// Numbers in test names refer to the B4 list in section 12.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const IP = '198.51.100.80';
let seq = 0;
const newPhone = () => `+2547${String(80_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `b4owner${++seq}@example.com`;

interface Owner {
  businessId: string;
  membershipId: string;
  token: string;
}
interface ProductJson {
  id: string;
  name: string;
  sku: string | null;
  archived: boolean;
  pack_types: { id: string; name: string; sell_price: string; cost_price?: string | null }[];
  barcodes: { barcode: string; pack_type_id: string }[];
}
interface Page {
  products: ProductJson[];
  next_cursor?: string | null;
}

describe('B4: search and listing', { timeout: 180_000 }, () => {
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

  const tenants = () => t.app.get(TenantRunner, { strict: false });

  // ---------------------------------------------------------------- HTTP
  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
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
    const body = res.json() as { error?: { code: string; message: string } };
    return { status: res.statusCode, code: body.error?.code, message: body.error?.message };
  };
  const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();
  const get = (token: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    call('GET', `/v1/products${Object.keys(params).length ? `?${qs(params)}` : ''}`, token, undefined, headers);
  const names = (res: LightMyRequestResponse) => {
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<Page>(res).products.map((p) => p.name);
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

  const command = (type: string, payload: object) => ({ command_id: randomUUID(), type, occurred_at: t.clock.now().toISOString(), payload });
  const sendOne = async (token: string, cmd: unknown) => {
    const res = await post('/v1/sync/commands', { commands: [cmd] }, token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return (res.json() as { results: { status: string; reason?: string }[] }).results[0];
  };

  /** A product through the real command, with a piece (cost price 150) and optional SKU and barcode. */
  async function product(o: Owner, name: string, extra: { sku?: string; barcode?: string } = {}) {
    const productId = randomUUID();
    const piece = randomUUID();
    const r = await sendOne(
      o.token,
      command('product.create', {
        product_id: productId,
        name,
        ...(extra.sku ? { sku: extra.sku } : {}),
        pack_types: [{ pack_type_id: piece, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' }],
        barcodes: extra.barcode ? [{ barcode: extra.barcode, pack_type_id: piece }] : [],
      }),
    );
    expect(r, name).toMatchObject({ status: 'ACCEPTED' });
    return productId;
  }

  const archive = async (o: Owner, productId: string) =>
    expect(await sendOne(o.token, command('product.update', { product_id: productId, archived: true }))).toMatchObject({ status: 'ACCEPTED' });

  /** Many products at once with one SQL statement, as app_user inside the tenant transaction (no pack types). */
  const bulkProducts = (businessId: string, count: number, nameSql: string) =>
    tenants().run(businessId, () =>
      currentTx().$executeRawUnsafe(
        `INSERT INTO product (business_id, name, updated_at) SELECT $1::uuid, ${nameSql}, now() FROM generate_series(1, $2::int) g`,
        businessId,
        count,
      ),
    );

  // ---------------------------------------------------------------- 1. order
  it('1. search order: exact barcode, then exact SKU, then names starting with q, then other substring matches', async () => {
    const o = await signupOwner();
    const byBarcode = await product(o, 'Zz unrelated', { barcode: 'MF22' });
    const bySku = await product(o, 'Yy unrelated', { sku: 'MF22' });
    const starts = await product(o, 'MF22 flour');
    const containsB = await product(o, 'Big MF22 pack');
    const containsA = await product(o, 'Aaa MF22');
    await product(o, 'Nothing to see');
    const res = await get(o.token, { q: 'MF22' });
    expect(json<Page>(res).products.map((p) => p.id)).toEqual([byBarcode, bySku, starts, containsA, containsB]);
    expect(json<Page>(res)).not.toHaveProperty('next_cursor');
    // A product matching several ways appears once, in its best place.
    const both = await product(o, 'MF22 combo', { sku: 'MF23' });
    const res2 = await get(o.token, { q: 'MF23' });
    expect(json<Page>(res2).products.map((p) => p.id)).toEqual([both]);
  });

  // ---------------------------------------------------------------- 2. matching
  it('2. matching is case-insensitive substring; %, _ and \\ match literally; a 1-character query is refused', async () => {
    const o = await signupOwner();
    for (const n of ['MAIZE flour', 'White maize', 'Mazeltov', '50% off soap', '500 grams rice', 'a_b tea', 'axb tea', 'back\\slash oil', 'backxslash oil']) {
      await product(o, n);
    }
    expect(names(await get(o.token, { q: 'maize' })).sort()).toEqual(['MAIZE flour', 'White maize']);
    expect(names(await get(o.token, { q: '0%' }))).toEqual(['50% off soap']);
    expect(names(await get(o.token, { q: '%%' }))).toEqual([]);
    expect(names(await get(o.token, { q: 'a_b' }))).toEqual(['a_b tea']);
    expect(names(await get(o.token, { q: 'k\\s' }))).toEqual(['back\\slash oil']);
    expect(errorOf(await get(o.token, { q: 'm' }))).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await get(o.token, { q: '  m  ' }))).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    // Non-ASCII letters fold too (the column and the text use the same lower()).
    await product(o, 'Café Élan');
    expect(names(await get(o.token, { q: 'café élan' }))).toEqual(['Café Élan']);
    expect(names(await get(o.token, { q: 'ÉLAN' }))).toEqual(['Café Élan']);
  });

  it('2. the search follows a rename at once (name_lower is kept by Postgres, not by app code)', async () => {
    const o = await signupOwner();
    const id = await product(o, 'Unga wa Dola');
    expect(names(await get(o.token, { q: 'dola' }))).toEqual(['Unga wa Dola']);
    expect(await sendOne(o.token, command('product.update', { product_id: id, name: 'Jogoo maize meal' }))).toMatchObject({ status: 'ACCEPTED' });
    expect(names(await get(o.token, { q: 'dola' }))).toEqual([]);
    expect(names(await get(o.token, { q: 'JOGOO' }))).toEqual(['Jogoo maize meal']);
    // Nothing can write the column directly, not even app_user's own UPDATE.
    await expect(
      tenants().run(o.businessId, () => currentTx().$executeRaw`UPDATE product SET name_lower = 'dola' WHERE id = ${id}::uuid`),
    ).rejects.toThrow(/name_lower.*can only be updated to DEFAULT|generated column/);
  });

  // ---------------------------------------------------------------- 3. archived
  it('3. archived products are hidden by default and appear with include_archived, in search and listing', async () => {
    const o = await signupOwner();
    await product(o, 'Maize active');
    const old = await product(o, 'Maize archived');
    await archive(o, old);
    expect(names(await get(o.token, { q: 'maize' }))).toEqual(['Maize active']);
    expect(names(await get(o.token, { q: 'maize', include_archived: 'true' }))).toEqual(['Maize active', 'Maize archived']);
    expect(names(await get(o.token))).toEqual(['Maize active']);
    const all = json<Page>(await get(o.token, { include_archived: 'true' })).products;
    expect(all.map((p) => [p.name, p.archived])).toEqual([
      ['Maize active', false],
      ['Maize archived', true],
    ]);
    expect(errorOf(await get(o.token, { include_archived: 'yes' }))).toMatchObject({ status: 422 });
  });

  // ---------------------------------------------------------------- 4. cost price
  it('4. the cost_price key is absent without costs.view and present with it, on list, search, by-id and by-barcode', async () => {
    const o = await signupOwner();
    const attendant = await activeStaff(o, 'ATTENDANT');
    const id = await product(o, 'Maize flour', { barcode: '036000291452' });
    const reads = (token: string) => [get(token), get(token, { q: 'maize' }), call('GET', `/v1/products/${id}`, token), call('GET', '/v1/products/by-barcode/036000291452', token)];
    const packsOf = (res: LightMyRequestResponse) => {
      expect(res.statusCode).toBe(200);
      const body = res.json() as Page | ProductJson | { product: ProductJson };
      const p = 'products' in body ? body.products[0] : 'product' in body ? body.product : body;
      return p.pack_types;
    };
    for (const res of await Promise.all(reads(o.token))) {
      expect(packsOf(res)[0]).toHaveProperty('cost_price', '150.00');
    }
    for (const res of await Promise.all(reads(attendant))) {
      expect(packsOf(res)[0]).not.toHaveProperty('cost_price');
      expect(res.body).not.toContain('150.00');
    }
  });

  // ---------------------------------------------------------------- 5. scope
  it('5. with identical data in two businesses, every read returns only the caller\'s own rows', async () => {
    const a = await signupOwner('Duka A');
    const b = await signupOwner('Duka B');
    const aId = await product(a, 'Maize flour', { sku: 'MF-2', barcode: '036000291452' });
    const bId = await product(b, 'Maize flour', { sku: 'MF-2', barcode: '036000291452' });

    for (const [owner, own, other] of [
      [a, aId, bId],
      [b, bId, aId],
    ] as const) {
      expect(json<Page>(await get(owner.token)).products.map((p) => p.id)).toEqual([own]);
      for (const q of ['maize', 'MF-2', '036000291452', '0036000291452']) {
        expect(json<Page>(await get(owner.token, { q })).products.map((p) => p.id), q).toEqual([own]);
      }
      expect(json<{ product: ProductJson }>(await call('GET', '/v1/products/by-barcode/036000291452', owner.token)).product.id).toBe(own);
      const theirs = errorOf(await call('GET', `/v1/products/${other}`, owner.token));
      expect(theirs).toEqual({ status: 404, code: 'PRODUCT_NOT_FOUND', message: expect.any(String) });
      expect(errorOf(await call('GET', `/v1/products/${randomUUID()}`, owner.token))).toEqual(theirs);
      expect(errorOf(await call('GET', '/v1/products/not-a-uuid', owner.token))).toEqual(theirs);
    }
    // A business_id query parameter is refused (decided in B4); a header changes nothing.
    expect(errorOf(await get(a.token, { business_id: b.businessId }))).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await get(a.token, { q: 'maize', business_id: b.businessId }))).toMatchObject({ status: 422 });
    const plain = await get(a.token, { q: 'maize' });
    const withHeader = await get(a.token, { q: 'maize' }, { 'x-business-id': b.businessId, business_id: b.businessId });
    expect(withHeader.statusCode).toBe(200);
    expect(withHeader.json()).toEqual(plain.json());
  });

  // ---------------------------------------------------------------- 6. paging
  it('6. paging: pages do not overlap and cover the whole set; limit is capped at 50; the cursor is opaque and checked', async () => {
    const o = await signupOwner();
    await bulkProducts(o.businessId, 45, `'Item ' || lpad(g::text, 3, '0')`);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    const sizes: number[] = [];
    do {
      const res = await get(o.token, { limit: '20', ...(cursor ? { cursor } : {}) });
      const page = json<Page>(res);
      sizes.push(page.products.length);
      seen.push(...page.products.map((p) => p.name));
      cursor = page.next_cursor;
      // An item added behind the cursor during paging causes no duplicate.
      if (sizes.length === 1) await bulkProducts(o.businessId, 1, `'Item 000 late'`);
    } while (cursor);
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(Array.from({ length: 45 }, (_, i) => `Item ${String(i + 1).padStart(3, '0')}`));

    await bulkProducts(o.businessId, 20, `'Extra ' || g`);
    expect(json<Page>(await get(o.token, { limit: '500' })).products).toHaveLength(50);
    expect(json<Page>(await get(o.token)).products).toHaveLength(20);

    const first = json<Page>(await get(o.token, { limit: '2' }));
    const good = first.next_cursor!;
    expect(good).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Buffer.from(good.split('.')[0], 'base64url').toString()).not.toContain(o.businessId);
    // Tampering: a changed body, a changed signature, garbage, or the wrong include_archived.
    const [body, mac] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, n: 'A', i: randomUUID(), a: false })).toString('base64url');
    for (const bad of [`${forged}.${mac}`, `${body}.${mac.slice(0, -2)}AA`, 'garbage', `${body}`, `${body}.${mac}.x`]) {
      expect(errorOf(await get(o.token, { cursor: bad })), bad).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    }
    expect(errorOf(await get(o.token, { cursor: good, include_archived: 'true' }))).toMatchObject({ status: 422 });
    expect(errorOf(await get(o.token, { cursor: good, q: 'item' }))).toMatchObject({ status: 422 });
    for (const limit of ['0', '-1', 'abc', '1.5']) {
      expect(errorOf(await get(o.token, { limit })), limit).toMatchObject({ status: 422 });
    }
    expect((await get(o.token, { cursor: good })).statusCode).toBe(200);
  });

  // ---------------------------------------------------------------- 7. hostile input
  it('7. hostile input returns normally, with no error leak', async () => {
    const o = await signupOwner();
    await product(o, "O'Brien's tea");
    expect(names(await get(o.token, { q: "o'brien" }))).toEqual(["O'Brien's tea"]);
    for (const q of ["'; DROP TABLE product; --", '"; SELECT 1; --', '-- comment', ') OR 1=1 --', 'x'.repeat(100), '%_%_\\\\']) {
      const res = await get(o.token, { q });
      expect(res.statusCode, q).toBe(200);
      expect(json<Page>(res).products).toEqual([]);
    }
    for (const q of ['x'.repeat(101), 'ab\u0000cd', 'ab\ncd']) {
      const res = await get(o.token, { q });
      expect(errorOf(res), JSON.stringify(q)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
      expect(res.body).not.toMatch(/SELECT|ILIKE|syntax|postgres|prisma/i);
    }
    // The table is still there.
    expect(names(await get(o.token))).toEqual(["O'Brien's tea"]);
  });

  // ---------------------------------------------------------------- 8. speed
  it('8. with 20,000 products in one business, a name search returns in under 200 ms', async () => {
    const o = await signupOwner();
    // Seeded on a plain app_user connection (still RLS and the change_log
    // trigger), because 20,000 trigger-logged inserts take longer than
    // Prisma's 5-second interactive transaction limit allows.
    await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [o.businessId]);
      await c.query(
        `INSERT INTO product (business_id, name, updated_at)
         SELECT $1::uuid, CASE WHEN g % 200 = 0 THEN 'Maize flour ' || g || 'kg' ELSE 'Item ' || md5(g::text) END, now()
           FROM generate_series(1, 20000) g`,
        [o.businessId],
      );
      await c.query('COMMIT');
    });
    await asAdmin((c) => c.query('ANALYZE product'));
    const warmStarted = performance.now();
    await get(o.token, { q: 'maize' }); // warm up
    const warmUp = performance.now() - warmStarted;
    const inOrder: number[] = [];
    let found = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const res = await get(o.token, { q: 'maize', limit: '50' });
      inOrder.push(performance.now() - started);
      found = json<Page>(res).products.length;
    }
    const times = [...inOrder].sort((x, y) => x - y);
    const median = times[2];

    // For docs/phase-b-results.md: the plan as app_user under RLS.
    const plan = await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [o.businessId]);
      const r = await c.query<{ 'QUERY PLAN': string }>(
        "EXPLAIN (ANALYZE, COSTS OFF) SELECT id FROM product WHERE archived_at IS NULL AND name_lower LIKE lower('%maize%') ESCAPE '\\' ORDER BY name, id LIMIT 50",
      );
      await c.query('ROLLBACK');
      return r.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    // Written before the assertions, so a failing run leaves its evidence too.
    if (process.env.B4_REPORT_FILE) {
      const ms = (xs: number[]) => xs.map((x) => x.toFixed(1)).join(', ');
      writeFileSync(
        process.env.B4_REPORT_FILE,
        `warm-up: ${warmUp.toFixed(1)} ms\nsearch times in order (ms): ${ms(inOrder)}\nsorted: ${ms(times)}\nmedian: ${median.toFixed(1)} ms\n\n${plan}\n`,
      );
    }
    expect(found).toBe(50);
    expect(median).toBeLessThan(200);
    expect(plan).not.toContain('product_name_trgm_idx'); // the finding recorded in the design (section 6)
  });
});
