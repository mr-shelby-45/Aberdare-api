import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { TenantRunner } from '../src/database/tenant.js';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { StockIntegrityService } from '../src/modules/stock/stock-integrity.service.js';
import { StockService } from '../src/modules/stock/stock.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';

// Phase C2: stock.receive, stock.adjust and the stock reads
// (docs/phase-c-design.md sections 4, 5, 7 and 8). Numbers in test names
// refer to the C2 list in section 13. Everything goes through the real API:
// commands through POST /v1/sync/commands, reads through GET /v1/stock*.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const IP = '198.51.100.70';
let seq = 0;
const newPhone = () => `+2547${String(70_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `c2owner${++seq}@example.com`;

interface Member {
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
interface Pack {
  productId: string;
  piece: string;
  carton: string;
}
interface World {
  owner: Member;
  manager: Member;
  attendant: Member;
  loc: string;
  maize: Pack;
}

describe('C2: receive, adjust and stock reads', { timeout: 180_000 }, () => {
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
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      remoteAddress: IP,
    });
  const post = (url: string, payload: unknown, token?: string) => call('POST', url, token, payload);
  const json = <T>(res: LightMyRequestResponse) => res.json() as T;
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });

  function lastCode(outbox: { to: string; message: string }[], to: string): string {
    const msg = [...outbox].reverse().find((m) => m.to === to);
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${to}`);
    return code;
  }

  // ---------------------------------------------------------------- seeding
  async function signupOwner(businessName: string): Promise<Member> {
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

  async function activeStaff(owner: Member, rolePreset: 'MANAGER' | 'ATTENDANT', displayName: string): Promise<Member> {
    const phone = newPhone();
    const created = await post('/v1/staff', { phone, display_name: displayName, role_preset: rolePreset }, owner.token);
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
    return { businessId: owner.businessId, membershipId, token: json<{ access_token: string }>(res).access_token };
  }

  const command = (type: string, payload: object, occurredAt = t.clock.now().toISOString()) => ({
    command_id: randomUUID(),
    type,
    occurred_at: occurredAt,
    payload,
  });

  const send = async (token: string, commands: unknown[]) => {
    const res = await post('/v1/sync/commands', { commands }, token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<{ results: Result[] }>(res).results;
  };
  const sendOne = async (token: string, cmd: unknown) => (await send(token, [cmd]))[0];

  /** A product with a piece and a carton of 24, created by the owner. */
  async function newProduct(owner: Member, name = 'Maize flour 2kg'): Promise<Pack> {
    const pack: Pack = { productId: randomUUID(), piece: randomUUID(), carton: randomUUID() };
    const r = await sendOne(
      owner.token,
      command('product.create', {
        product_id: pack.productId,
        name,
        pack_types: [
          { pack_type_id: pack.piece, name: 'piece', units_per_pack: 1, sell_price: '180' },
          { pack_type_id: pack.carton, name: 'carton of 24', units_per_pack: 24, sell_price: '4200.00' },
        ],
      }),
    );
    expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    return pack;
  }

  async function world(businessName = 'Duka A'): Promise<World> {
    const owner = await signupOwner(businessName);
    const manager = await activeStaff(owner, 'MANAGER', 'Baraka');
    const attendant = await activeStaff(owner, 'ATTENDANT', 'Chebet');
    const locations = json<{ locations: { id: string }[] }>(await call('GET', '/v1/locations', owner.token));
    const maize = await newProduct(owner);
    return { owner, manager, attendant, loc: locations.locations[0].id, maize };
  }

  const receive = (location: string, lines: object[], extra: object = {}) => command('stock.receive', { location_id: location, lines, ...extra });
  const adjust = (location: string, packTypeId: string, change: number, reason: string, extra: object = {}) =>
    command('stock.adjust', { location_id: location, pack_type_id: packTypeId, quantity_change: change, reason, ...extra });

  // ---------------------------------------------------------------- database reads (as superuser, tests only)
  const balances = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ location_id: string; pack_type_id: string; quantity: number }>(
          'SELECT location_id, pack_type_id, quantity FROM stock_balance WHERE business_id = $1 ORDER BY pack_type_id, location_id',
          [businessId],
        )).rows,
    );
  const balanceOf = async (businessId: string, loc: string, pack: string) =>
    (await balances(businessId)).find((b) => b.location_id === loc && b.pack_type_id === pack)?.quantity ?? 0;
  const movements = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{
          movement_type: string;
          location_id: string;
          pack_type_id: string;
          quantity_change: number;
          quantity_after: number;
          occurred_at: Date;
          created_by_membership_id: string | null;
          sync_command_id: string | null;
          unit_cost: string | null;
          reason: string | null;
          note: string | null;
          reference: string | null;
        }>(
          `SELECT movement_type, location_id, pack_type_id, quantity_change, quantity_after, occurred_at, created_by_membership_id,
                  sync_command_id, unit_cost::text AS unit_cost, reason, note, reference
             FROM stock_movement WHERE business_id = $1 ORDER BY created_at, id`,
          [businessId],
        )).rows,
    );
  const ledgerSum = async (businessId: string, loc: string, pack: string) =>
    (await movements(businessId))
      .filter((m) => m.location_id === loc && m.pack_type_id === pack)
      .reduce((s, m) => s + m.quantity_change, 0);
  /** stock_balance rows in the order their change_log rows were written (the BIGSERIAL id). */
  const balanceLogOrder = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ pack_type_id: string; operation: string }>(
          `SELECT b.pack_type_id, l.operation FROM change_log l JOIN stock_balance b ON b.id = l.row_id
            WHERE l.business_id = $1 AND l.table_name = 'stock_balance' ORDER BY l.id`,
          [businessId],
        )).rows,
    );
  const syncCommandRowId = (businessId: string, commandId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM sync_command WHERE business_id = $1 AND command_id = $2', [businessId, commandId])).rows[0]?.id,
    );
  const auditRows = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ action: string; target_type: string; target_id: string; actor_membership_id: string | null; metadata: Record<string, unknown> }>(
          `SELECT action, target_type, target_id, actor_membership_id, metadata FROM audit_log
            WHERE business_id = $1 AND action LIKE 'stock.%' ORDER BY occurred_at, action`,
          [businessId],
        )).rows,
    );
  const integrity = (businessId: string) =>
    t.app.get(TenantRunner, { strict: false }).run(businessId, () => t.app.get(StockIntegrityService, { strict: false }).check());

  /** Sale mode (the spike's repository code; Phase E builds sale.create): takes the pool below zero if needed. */
  const sell = (w: World, loc: string, pack: string, qty: number) =>
    t.app
      .get(TenantRunner, { strict: false })
      .run(w.owner.businessId, () =>
        t.app.get(StockService, { strict: false }).decreaseForSale(loc, pack, qty, { occurredAt: t.clock.now(), createdByMembershipId: w.manager.membershipId, syncCommandId: null }),
      );

  async function newLocation(owner: Member, name: string): Promise<string> {
    const res = await post('/v1/locations', { name }, owner.token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    return json<{ id: string }>(res).id;
  }

  // ---------------------------------------------------------------- 1. receive
  it('1. receive writes one movement per line with type, quantity_after, occurred_at, creator and command, and returns quantity_after', async () => {
    const w = await world();
    const occurred = '2026-10-25T06:30:00.000Z';
    const cmd = command(
      'stock.receive',
      { location_id: w.loc, reference: 'INV-104', note: ' Morning delivery ', lines: [{ pack_type_id: w.maize.carton, quantity: 10 }, { pack_type_id: w.maize.piece, quantity: 5 }] },
      occurred,
    );
    const r = await sendOne(w.manager.token, cmd);
    expect(r).toEqual({
      command_id: cmd.command_id,
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: w.maize.carton, quantity_after: 10 }, { pack_type_id: w.maize.piece, quantity_after: 5 }] },
    });

    const syncId = await syncCommandRowId(w.owner.businessId, cmd.command_id);
    expect(syncId).toEqual(expect.any(String));
    const rows = await movements(w.owner.businessId);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ movement_type: 'RECEIVE', pack_type_id: w.maize.carton, quantity_change: 10, quantity_after: 10 }),
        expect.objectContaining({ movement_type: 'RECEIVE', pack_type_id: w.maize.piece, quantity_change: 5, quantity_after: 5 }),
      ]),
    );
    // Applied larger pack first (the lock order), although the piece line came second.
    expect(await balanceLogOrder(w.owner.businessId)).toEqual([
      { pack_type_id: w.maize.carton, operation: 'INSERT' },
      { pack_type_id: w.maize.piece, operation: 'INSERT' },
    ]);
    for (const m of rows) {
      expect(m.occurred_at.toISOString()).toBe(occurred);
      expect(m.created_by_membership_id).toBe(w.manager.membershipId);
      expect(m.sync_command_id).toBe(syncId);
      expect(m).toMatchObject({ reference: 'INV-104', note: 'Morning delivery', unit_cost: null, reason: null });
    }
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(10);
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(5);

    // A second delivery adds to the balance; quantity_after follows it.
    const again = await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 7 }]));
    expect(again.result).toEqual({ lines: [{ pack_type_id: w.maize.piece, quantity_after: 12 }] });
    expect(await integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2. all or nothing
  it('2. a delivery with several bad lines saves nothing and lists every bad line with its reason', async () => {
    const w = await world();
    // An archived product (its pack types count as archived) and an archived pack type.
    const beans = await newProduct(w.owner, 'Beans 1kg');
    expect((await sendOne(w.owner.token, command('product.update', { product_id: beans.productId, archived: true }))).status).toBe('ACCEPTED');
    const rice = await newProduct(w.owner, 'Rice 5kg');
    const archiveCarton = command('pack_type.upsert', {
      pack_type_id: rice.carton,
      product_id: rice.productId,
      name: 'carton of 24',
      units_per_pack: 24,
      sell_price: '4200.00',
      archived: true,
    });
    expect((await sendOne(w.owner.token, archiveCarton)).status).toBe('ACCEPTED');

    const cmd = receive(w.loc, [
      { pack_type_id: w.maize.piece, quantity: 5 }, // 1: fine
      { pack_type_id: w.maize.piece, quantity: 1 }, // 2: repeated pack type
      { pack_type_id: w.maize.carton, quantity: 0 }, // 3: quantity 0
      { pack_type_id: randomUUID(), quantity: 2 }, // 4: no such pack type
      { pack_type_id: beans.piece, quantity: 2 }, // 5: archived product
      { pack_type_id: rice.carton, quantity: 2 }, // 6: archived pack type
      { pack_type_id: rice.piece, quantity: 3 }, // 7: fine
    ]);
    const r = await sendOne(w.manager.token, cmd);
    expect(r).toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_LINES',
      result: {
        invalid_lines: [
          { line: 2, reason: 'DUPLICATE_LINE' },
          { line: 3, reason: 'QUANTITY_INVALID' },
          { line: 4, reason: 'PACK_TYPE_NOT_FOUND' },
          { line: 5, reason: 'PACK_TYPE_ARCHIVED' },
          { line: 6, reason: 'PACK_TYPE_ARCHIVED' },
        ],
      },
    });

    // Each bad quantity on its own: negative, fractional, over 1,000,000.
    for (const quantity of [-1, 1.5, 1_000_001, 0]) {
      const bad = await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity }]));
      expect(bad, String(quantity)).toMatchObject({ status: 'REJECTED', reason: 'INVALID_LINES', result: { invalid_lines: [{ line: 1, reason: 'QUANTITY_INVALID' }] } });
    }
    // Bad costs (the owner has costs.view): not money, negative, three decimals.
    for (const cost of ['abc', '-1', '1.234', '']) {
      const bad = await sendOne(w.owner.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 1, unit_cost: cost }]));
      expect(bad, cost).toMatchObject({ status: 'REJECTED', reason: 'INVALID_LINES', result: { invalid_lines: [{ line: 1, reason: 'COST_INVALID' }] } });
    }
    // Malformed commands: no lines, 51 lines, a line id that is not a UUID, a quantity that is a string.
    const fiftyOne = Array.from({ length: 51 }, () => ({ pack_type_id: randomUUID(), quantity: 1 }));
    for (const lines of [[], fiftyOne, [{ pack_type_id: 'not-a-uuid', quantity: 1 }], [{ pack_type_id: w.maize.piece, quantity: '5' }]]) {
      const bad = await sendOne(w.manager.token, receive(w.loc, lines));
      expect(bad).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    // An archived location and a missing one.
    const store = await newLocation(w.owner, 'Back store');
    expect((await call('PATCH', `/v1/locations/${store}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect(await sendOne(w.manager.token, receive(store, [{ pack_type_id: w.maize.piece, quantity: 1 }]))).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_ARCHIVED' });
    expect(await sendOne(w.manager.token, receive(randomUUID(), [{ pack_type_id: w.maize.piece, quantity: 1 }]))).toMatchObject({ status: 'REJECTED', reason: 'LOCATION_NOT_FOUND' });

    // Fifty good lines are accepted (the limit itself).
    const fifty = await Promise.all(Array.from({ length: 24 }, (_, i) => newProduct(w.owner, `Item ${String(i).padStart(2, '0')}`)));
    const lines = fifty.flatMap((p) => [{ pack_type_id: p.piece, quantity: 1 }, { pack_type_id: p.carton, quantity: 1 }]);
    lines.push({ pack_type_id: w.maize.piece, quantity: 1_000_000 }, { pack_type_id: w.maize.carton, quantity: 1 });
    expect(lines).toHaveLength(50);

    // Nothing of any rejected delivery was saved.
    expect(await movements(w.owner.businessId)).toEqual([]);
    expect(await balances(w.owner.businessId)).toEqual([]);
    expect(await auditRows(w.owner.businessId)).toEqual([]);

    expect((await sendOne(w.manager.token, receive(w.loc, lines))).status).toBe('ACCEPTED');
    expect(await movements(w.owner.businessId)).toHaveLength(50);
  });

  // ---------------------------------------------------------------- 3. tenant isolation
  it("3. another business's location or pack type gives the same answer as one that does not exist", async () => {
    const a = await world('Duka A');
    const b = await world('Duka B');
    const missingLoc = await sendOne(a.manager.token, receive(randomUUID(), [{ pack_type_id: a.maize.piece, quantity: 1 }]));
    const foreignLoc = await sendOne(a.manager.token, receive(b.loc, [{ pack_type_id: a.maize.piece, quantity: 1 }]));
    expect(foreignLoc).toEqual({ ...missingLoc, command_id: foreignLoc.command_id });
    expect(foreignLoc.reason).toBe('LOCATION_NOT_FOUND');

    const missingPack = await sendOne(a.manager.token, receive(a.loc, [{ pack_type_id: randomUUID(), quantity: 1 }]));
    const foreignPack = await sendOne(a.manager.token, receive(a.loc, [{ pack_type_id: b.maize.piece, quantity: 1 }]));
    expect(foreignPack).toEqual({ ...missingPack, command_id: foreignPack.command_id });
    expect(foreignPack.result).toEqual({ invalid_lines: [{ line: 1, reason: 'PACK_TYPE_NOT_FOUND' }] });

    const adjustMissingLoc = await sendOne(a.manager.token, adjust(randomUUID(), a.maize.piece, 1, 'FOUND'));
    const adjustForeignLoc = await sendOne(a.manager.token, adjust(b.loc, a.maize.piece, 1, 'FOUND'));
    expect(adjustForeignLoc).toEqual({ ...adjustMissingLoc, command_id: adjustForeignLoc.command_id });
    const adjustMissingPack = await sendOne(a.manager.token, adjust(a.loc, randomUUID(), 1, 'FOUND'));
    const adjustForeignPack = await sendOne(a.manager.token, adjust(a.loc, b.maize.piece, 1, 'FOUND'));
    expect(adjustForeignPack).toEqual({ ...adjustMissingPack, command_id: adjustForeignPack.command_id });
    expect(adjustForeignPack.reason).toBe('PACK_TYPE_NOT_FOUND');

    expect(await movements(a.owner.businessId)).toEqual([]);
    expect(await movements(b.owner.businessId)).toEqual([]);
    expect(await balances(b.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 4. permissions
  it('4. permissions: attendant denied, manager succeeds, unit_cost needs costs.view and never changes cost_price', async () => {
    const w = await world();
    const attendantResults = await send(w.attendant.token, [
      receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]),
      adjust(w.loc, w.maize.piece, 1, 'FOUND'),
    ]);
    expect(attendantResults.map((r) => [r.status, r.reason])).toEqual([
      ['REJECTED', 'PERMISSION_DENIED'],
      ['REJECTED', 'PERMISSION_DENIED'],
    ]);

    // The manager has no costs.view: a cost (even null) is refused, and the rest of the batch proceeds.
    const managerResults = await send(w.manager.token, [
      receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5, unit_cost: '120.50' }]),
      receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5, unit_cost: null }]),
      receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]),
    ]);
    expect(managerResults.map((r) => [r.status, r.reason])).toEqual([
      ['REJECTED', 'PERMISSION_DENIED'],
      ['REJECTED', 'PERMISSION_DENIED'],
      ['ACCEPTED', undefined],
    ]);

    // The owner has costs.view: the cost is stored on the movement only.
    const before = await asAdmin(async (c) => (await c.query<{ cost_price: string | null }>('SELECT cost_price::text AS cost_price FROM pack_type WHERE id = $1', [w.maize.piece])).rows[0]);
    const owner = await sendOne(w.owner.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 2, unit_cost: '120.5' }, { pack_type_id: w.maize.carton, quantity: 1 }]));
    expect(owner.status).toBe('ACCEPTED');
    const rows = await movements(w.owner.businessId);
    // The owner's two lines share one transaction (and created_at), so compare them as a set.
    const shape = (m: (typeof rows)[number]) => [m.created_by_membership_id, m.pack_type_id, m.quantity_change, m.unit_cost];
    expect(rows.map(shape)[0]).toEqual([w.manager.membershipId, w.maize.piece, 5, null]);
    expect(rows.slice(1).map(shape)).toHaveLength(2);
    expect(rows.slice(1).map(shape)).toEqual(
      expect.arrayContaining([
        [w.owner.membershipId, w.maize.carton, 1, null],
        [w.owner.membershipId, w.maize.piece, 2, '120.50'],
      ]),
    );
    const after = await asAdmin(async (c) => (await c.query<{ cost_price: string | null }>('SELECT cost_price::text AS cost_price FROM pack_type WHERE id = $1', [w.maize.piece])).rows[0]);
    expect(after).toEqual(before);
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(7);
  });

  // ---------------------------------------------------------------- 5. concurrency (run 5 times)
  it('5. 20 concurrent receives of 5 on one pool give exactly +100; the same command id 20 times applies once', async () => {
    const w = await world();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]))),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill('ACCEPTED'));
    // Every quantity_after from 5 to 100 exactly once: each receive saw the one before it.
    const afters = results.map((r) => (r.result as { lines: { quantity_after: number }[] }).lines[0].quantity_after).sort((x, y) => x - y);
    expect(afters).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 5));
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(100);
    expect(await ledgerSum(w.owner.businessId, w.loc, w.maize.piece)).toBe(100);

    const same = receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 3 }]);
    const copies = await Promise.all(Array.from({ length: 20 }, () => sendOne(w.manager.token, same)));
    for (const r of copies) {
      expect(r).toEqual({ command_id: same.command_id, status: 'ACCEPTED', result: { lines: [{ pack_type_id: w.maize.carton, quantity_after: 3 }] } });
    }
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(3);
    expect((await movements(w.owner.businessId)).filter((m) => m.pack_type_id === w.maize.carton)).toHaveLength(1);
    expect(await integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 6. adjust (the concurrency part runs 5 times)
  it('6. adjust: every reason with the right and the wrong sign; an attendant is denied', async () => {
    const w = await world();
    expect((await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 100 }]))).status).toBe('ACCEPTED');
    const cases: [string, number, string][] = [
      ['DAMAGED', -1, 'ACCEPTED'],
      ['DAMAGED', 1, 'REASON_SIGN_MISMATCH'],
      ['EXPIRED', -2, 'ACCEPTED'],
      ['EXPIRED', 2, 'REASON_SIGN_MISMATCH'],
      ['LOST', -3, 'ACCEPTED'],
      ['LOST', 3, 'REASON_SIGN_MISMATCH'],
      ['SUPPLIER_RETURN', -4, 'ACCEPTED'],
      ['SUPPLIER_RETURN', 4, 'REASON_SIGN_MISMATCH'],
      ['FOUND', 5, 'ACCEPTED'],
      ['FOUND', -5, 'REASON_SIGN_MISMATCH'],
      ['CORRECTION', 6, 'ACCEPTED'],
      ['CORRECTION', -6, 'ACCEPTED'],
      ['OTHER', 7, 'ACCEPTED'],
      ['OTHER', -7, 'ACCEPTED'],
    ];
    let expected = 100;
    for (const [reason, change, outcome] of cases) {
      const r = await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, change, reason, { note: 'shelf check' }));
      if (outcome === 'ACCEPTED') {
        expected += change;
        expect(r, `${reason} ${change}`).toMatchObject({ status: 'ACCEPTED', result: { quantity_after: expected } });
      } else {
        expect(r, `${reason} ${change}`).toMatchObject({ status: 'REJECTED', reason: outcome });
      }
    }
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(expected);
    const adjusts = (await movements(w.owner.businessId)).filter((m) => m.movement_type === 'ADJUST');
    expect(adjusts.map((m) => [m.reason, m.quantity_change])).toEqual(cases.filter((c) => c[2] === 'ACCEPTED').map((c) => [c[0], c[1]]));
    expect(adjusts.every((m) => m.note === 'shelf check' && m.created_by_membership_id === w.manager.membershipId && m.unit_cost === null)).toBe(true);

    // Malformed: zero, a reason outside the list, over 1,000,000.
    for (const bad of [adjust(w.loc, w.maize.piece, 0, 'OTHER'), adjust(w.loc, w.maize.piece, 1, 'STOLEN'), adjust(w.loc, w.maize.piece, -1_000_001, 'OTHER')]) {
      expect(await sendOne(w.manager.token, bad)).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    }
    // A strict decrease never goes below zero.
    expect(await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, -(expected + 1), 'LOST'))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    expect(await sendOne(w.attendant.token, adjust(w.loc, w.maize.piece, -1, 'DAMAGED'))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(expected);

    // Archived locations and pack types may be adjusted, so old stock can be cleaned up.
    const store = await newLocation(w.owner, 'Back store');
    expect((await sendOne(w.manager.token, receive(store, [{ pack_type_id: w.maize.carton, quantity: 4 }]))).status).toBe('ACCEPTED');
    expect((await call('PATCH', `/v1/locations/${store}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    expect((await sendOne(w.owner.token, command('product.update', { product_id: w.maize.productId, archived: true }))).status).toBe('ACCEPTED');
    expect(await sendOne(w.manager.token, adjust(store, w.maize.carton, -4, 'SUPPLIER_RETURN'))).toMatchObject({ status: 'ACCEPTED', result: { quantity_after: 0 } });
    expect(await integrity(w.owner.businessId)).toEqual([]);
  });

  it('6. balance 10 and 50 concurrent adjusts of -1 give exactly 10 ACCEPTED, 40 STOCK_INSUFFICIENT, final 0', async () => {
    const w = await world();
    expect((await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 10 }]))).status).toBe('ACCEPTED');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => sendOne(w.manager.token, adjust(w.loc, w.maize.carton, -1, 'DAMAGED'))),
    );
    const accepted = results.filter((r) => r.status === 'ACCEPTED');
    const refused = results.filter((r) => r.status === 'REJECTED' && r.reason === 'STOCK_INSUFFICIENT');
    expect([accepted.length, refused.length]).toEqual([10, 40]);
    expect(accepted.map((r) => (r.result as { quantity_after: number }).quantity_after).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(0);
    expect(await ledgerSum(w.owner.businessId, w.loc, w.maize.carton)).toBe(0);
    expect(await integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 7. negative balances
  it('7. from -3 a receive of 5 gives 2; an adjust of -1 from -3 is STOCK_INSUFFICIENT', async () => {
    const w = await world();
    await sell(w, w.loc, w.maize.piece, 3);
    await sell(w, w.loc, w.maize.carton, 3);
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(-3);

    expect(await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]))).toMatchObject({
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: w.maize.piece, quantity_after: 2 }] },
    });
    expect(await sendOne(w.manager.token, adjust(w.loc, w.maize.carton, -1, 'DAMAGED'))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(-3);
    // An increase from below zero is fine.
    expect(await sendOne(w.manager.token, adjust(w.loc, w.maize.carton, 1, 'FOUND'))).toMatchObject({ status: 'ACCEPTED', result: { quantity_after: -2 } });
    expect(await integrity(w.owner.businessId)).toEqual([]);
  });

  it('the balance cap: a receive that would take a pool above 2,000,000,000 is VALIDATION_FAILED and changes nothing', async () => {
    const w = await world();
    // Seed a balance near the cap as the superuser, with a matching movement so the ledger stays consistent.
    await asAdmin(async (c) => {
      await c.query(
        `INSERT INTO stock_balance (business_id, location_id, pack_type_id, quantity) VALUES ($1, $2, $3, 1999500000)`,
        [w.owner.businessId, w.loc, w.maize.piece],
      );
      await c.query(
        `INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at)
         VALUES ($1, $2, $3, 1999500000, 'RECEIVE', 1999500000, now())`,
        [w.owner.businessId, w.loc, w.maize.piece],
      );
    });
    const tooMuch = await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.carton, quantity: 1 }, { pack_type_id: w.maize.piece, quantity: 500_001 }]));
    expect(tooMuch).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(1_999_500_000);
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(0);
    expect(await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, 500_001, 'FOUND'))).toMatchObject({ status: 'REJECTED', reason: 'VALIDATION_FAILED' });
    // Exactly at the cap is allowed.
    expect(await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 500_000 }]))).toMatchObject({
      status: 'ACCEPTED',
      result: { lines: [{ pack_type_id: w.maize.piece, quantity_after: 2_000_000_000 }] },
    });
    expect(await integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 8. GET /v1/stock
  it('8. GET /stock hides zero rows, shows negative ones, filters, pages with a signed cursor and never mixes businesses', async () => {
    const w = await world('Duka A');
    const beans = await newProduct(w.owner, 'Beans 1kg');
    const store = await newLocation(w.owner, 'Back store');
    await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }, { pack_type_id: w.maize.carton, quantity: 2 }]));
    await sendOne(w.manager.token, adjust(w.loc, w.maize.carton, -2, 'DAMAGED')); // carton now 0
    await sendOne(w.manager.token, receive(store, [{ pack_type_id: w.maize.piece, quantity: 3 }]));
    await sell(w, w.loc, beans.piece, 2); // beans piece -2
    // A second business with a product of the same name.
    const b = await world('Duka B');
    await sendOne(b.manager.token, receive(b.loc, [{ pack_type_id: b.maize.piece, quantity: 99 }]));

    const list = async (query: string, token = w.attendant.token) => {
      const res = await call('GET', `/v1/stock${query}`, token);
      expect(res.statusCode, res.body).toBe(200);
      return json<{ balances: Record<string, unknown>[]; next_cursor: string | null }>(res);
    };

    const all = await list('');
    expect(all.next_cursor).toBeNull();
    // Product name order, then pack type id, then location id; zero hidden, negative shown.
    const key = (r: Record<string, unknown>) => [r.product_name, r.pack_type_id, r.location_id, r.quantity];
    const maizePieces = [w.loc, store].sort().map((l) => ['Maize flour 2kg', w.maize.piece, l, l === w.loc ? 5 : 3]);
    expect(all.balances.map(key)).toEqual([['Beans 1kg', beans.piece, w.loc, -2], ...maizePieces]);
    // Exactly these keys: no cost fields, no business id.
    expect(Object.keys(all.balances[0]).sort()).toEqual(
      ['location_id', 'location_name', 'pack_type_id', 'pack_type_name', 'product_id', 'product_name', 'quantity', 'units_per_pack', 'updated_at'].sort(),
    );
    expect(all.balances[0]).toMatchObject({ location_name: 'Main shop', product_id: beans.productId, pack_type_name: 'piece', units_per_pack: 1 });
    expect(all.balances.some((r) => r.quantity === 99)).toBe(false);

    const withZero = await list('?include_zero=true');
    expect(withZero.balances.map(key)).toContainEqual(['Maize flour 2kg', w.maize.carton, w.loc, 0]);
    expect(withZero.balances).toHaveLength(4);
    expect((await list(`?location_id=${store}`)).balances.map(key)).toEqual([['Maize flour 2kg', w.maize.piece, store, 3]]);
    expect((await list(`?product_id=${beans.productId}`)).balances.map(key)).toEqual([['Beans 1kg', beans.piece, w.loc, -2]]);
    // Another business's product id finds nothing.
    expect((await list(`?product_id=${b.maize.productId}`)).balances).toEqual([]);

    // Archived products are hidden unless include_archived.
    await sendOne(w.owner.token, command('product.update', { product_id: beans.productId, archived: true }));
    expect((await list('')).balances.map((r) => r.product_name)).toEqual(['Maize flour 2kg', 'Maize flour 2kg']);
    expect((await list('?include_archived=true')).balances).toHaveLength(3);

    // Paging: one row at a time gives the same rows in the same order.
    const paged: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(`?include_zero=true&include_archived=true&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.balances.length).toBeLessThanOrEqual(1);
      paged.push(...page.balances);
      cursor = page.next_cursor;
    } while (cursor);
    expect(paged.map(key)).toEqual((await list('?include_zero=true&include_archived=true')).balances.map(key));
    expect(paged).toHaveLength(4);

    // A tampered cursor, one used with other filters, one from the products list, and business_id: 422.
    const first = await list('?include_zero=true&limit=1');
    const c = first.next_cursor!;
    const tampered = `${c.slice(0, 5)}${c[5] === 'A' ? 'B' : 'A'}${c.slice(6)}`;
    for (const query of [`?include_zero=true&cursor=${encodeURIComponent(tampered)}`, `?cursor=${encodeURIComponent(c)}`, `?business_id=${b.owner.businessId}`, '?limit=0']) {
      expect(errorOf(await call('GET', `/v1/stock${query}`, w.attendant.token)), query).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    }
    const productsPage = json<{ next_cursor: string | null }>(await call('GET', '/v1/products?limit=1&include_archived=true', w.owner.token));
    expect(errorOf(await call('GET', `/v1/stock?cursor=${encodeURIComponent(productsPage.next_cursor!)}`, w.attendant.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });

    // Business B sees only its own row.
    expect((await list('', b.attendant.token)).balances.map(key)).toEqual([['Maize flour 2kg', b.maize.piece, b.loc, 99]]);
  });

  // ---------------------------------------------------------------- 9. GET /v1/stock/movements
  it('9. GET /stock/movements: newest first, filters, paging, unit_cost only with costs.view, creator name, isolation, suspended refused', async () => {
    const w = await world('Duka A');
    // Fixed once: seeding business B below moves the fake clock forward.
    const base = t.clock.now().getTime();
    const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();
    // Sent out of order: the list follows the phone's occurred_at.
    await sendOne(w.owner.token, command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.carton, quantity: 4, unit_cost: '3900' }] }, at(30)));
    await sendOne(w.manager.token, command('stock.receive', { location_id: w.loc, reference: 'INV-9', lines: [{ pack_type_id: w.maize.piece, quantity: 10 }] }, at(50)));
    await sendOne(w.manager.token, command('stock.adjust', { location_id: w.loc, pack_type_id: w.maize.piece, quantity_change: -1, reason: 'DAMAGED', note: 'torn bag' }, at(10)));
    const b = await world('Duka B');
    await sendOne(b.manager.token, receive(b.loc, [{ pack_type_id: b.maize.piece, quantity: 77 }]));

    type Row = Record<string, unknown> & { movement_type: string; quantity_change: number; created_by: { membership_id: string; display_name: string } | null };
    const list = async (query: string, token = w.attendant.token) => {
      const res = await call('GET', `/v1/stock/movements${query}`, token);
      expect(res.statusCode, res.body).toBe(200);
      return json<{ movements: Row[]; next_cursor: string | null }>(res);
    };

    const all = await list('');
    expect(all.movements.map((m) => [m.movement_type, m.quantity_change, m.occurred_at])).toEqual([
      ['ADJUST', -1, at(10)],
      ['RECEIVE', 4, at(30)],
      ['RECEIVE', 10, at(50)],
    ]);
    expect(all.movements[0]).toMatchObject({
      quantity_after: 9,
      reason: 'DAMAGED',
      note: 'torn bag',
      reference: null,
      expected_quantity: null,
      counted_quantity: null,
      location_id: w.loc,
      pack_type_id: w.maize.piece,
      product_name: 'Maize flour 2kg',
      pack_type_name: 'piece',
      created_by: { membership_id: w.manager.membershipId, display_name: 'Baraka' },
    });
    expect(all.movements[2]).toMatchObject({ reference: 'INV-9' });
    // No unit_cost key at all for the attendant (and the manager), not even null.
    expect(all.movements.every((m) => !('unit_cost' in m))).toBe(true);
    expect((await list('', w.manager.token)).movements.every((m) => !('unit_cost' in m))).toBe(true);
    const asOwner = await list('', w.owner.token);
    expect(asOwner.movements.map((m) => m.unit_cost)).toEqual([null, '3900.00', null]);
    expect(asOwner.movements[1].created_by).toEqual({ membership_id: w.owner.membershipId, display_name: 'Amina' });
    // Business B's movement never appears; B sees only its own.
    expect(all.movements.some((m) => m.quantity_change === 77)).toBe(false);
    expect((await list('', b.attendant.token)).movements.map((m) => m.quantity_change)).toEqual([77]);

    // Filters.
    expect((await list(`?pack_type_id=${w.maize.piece}`)).movements.map((m) => m.quantity_change)).toEqual([-1, 10]);
    expect((await list('?type=RECEIVE')).movements.map((m) => m.quantity_change)).toEqual([4, 10]);
    expect((await list(`?product_id=${w.maize.productId}&location_id=${w.loc}`)).movements).toHaveLength(3);
    expect((await list(`?from=${encodeURIComponent(at(40))}&to=${encodeURIComponent(at(10))}`)).movements.map((m) => m.quantity_change)).toEqual([4]);
    expect((await list(`?location_id=${b.loc}`)).movements).toEqual([]);

    // Paging: two at a time, then the rest.
    const p1 = await list('?limit=2');
    expect(p1.movements.map((m) => m.quantity_change)).toEqual([-1, 4]);
    const p2 = await list(`?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`);
    expect(p2).toEqual({ movements: [all.movements[2]], next_cursor: null });

    // Bad input: a cursor for other filters, a bad type, from after to, business_id.
    for (const query of [`?type=RECEIVE&cursor=${encodeURIComponent(p1.next_cursor!)}`, '?type=TELEPORT', `?from=${at(5)}&to=${at(10)}`, '?from=yesterday', `?business_id=${b.owner.businessId}`]) {
      expect(errorOf(await call('GET', `/v1/stock/movements${query}`, w.attendant.token)), query).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    }

    // A suspended member is refused.
    expect((await call('POST', `/v1/staff/${w.attendant.membershipId}/suspend`, w.owner.token)).statusCode).toBe(204);
    expect(errorOf(await call('GET', '/v1/stock/movements', w.attendant.token))).toEqual({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
    expect(errorOf(await call('GET', '/v1/stock', w.attendant.token))).toEqual({ status: 403, code: 'MEMBERSHIP_INACTIVE' });
  });

  // ---------------------------------------------------------------- 10. audit
  it('10. audit rows stock.received and stock.adjusted, once each, without notes, references or costs', async () => {
    const w = await world();
    await sendOne(w.owner.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 6, unit_cost: '177.25' }, { pack_type_id: w.maize.carton, quantity: 1 }], { reference: 'SECRET-REF-1', note: 'private note text' }));
    t.clock.advanceMinutes(1); // audit rows are ordered by their (fake clock) time
    await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, -2, 'EXPIRED', { note: 'another private note' }));
    // Rejected commands write no audit row.
    await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, -100, 'LOST'));
    await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: randomUUID(), quantity: 1 }]));

    const rows = await auditRows(w.owner.businessId);
    expect(rows).toEqual([
      {
        action: 'stock.received',
        target_type: 'location',
        target_id: w.loc,
        actor_membership_id: w.owner.membershipId,
        metadata: {
          location_id: w.loc,
          lines: [{ pack_type_id: w.maize.piece, quantity: 6 }, { pack_type_id: w.maize.carton, quantity: 1 }],
          with_cost: true,
        },
      },
      {
        action: 'stock.adjusted',
        target_type: 'pack_type',
        target_id: w.maize.piece,
        actor_membership_id: w.manager.membershipId,
        metadata: { location_id: w.loc, pack_type_id: w.maize.piece, quantity_change: -2, quantity_after: 4, reason: 'EXPIRED' },
      },
    ]);
    const text = JSON.stringify(rows);
    // The cost as a value ("177.25" or 177.25), not "177", which a random UUID can contain.
    for (const secret of ['private note', 'SECRET-REF', '177.25', '"unit_cost"', '"cost_price"', '"note"', '"reference"']) expect(text).not.toContain(secret);
  });

  it('10. a forced failure after the audit insert leaves no audit row, no stock change and no command row', async () => {
    const w = await world();
    const audit = t.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('forced failure after the audit insert');
    });
    const r = await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]));
    expect(r).toMatchObject({ status: 'FAILED', reason: 'INTERNAL_ERROR' });
    expect(await auditRows(w.owner.businessId)).toEqual([]);
    expect(await movements(w.owner.businessId)).toEqual([]);
    expect(await balances(w.owner.businessId)).toEqual([]);
    expect(await syncCommandRowId(w.owner.businessId, r.command_id!)).toBeUndefined();

    // The same for adjust.
    expect((await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]))).status).toBe('ACCEPTED');
    vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('forced failure after the audit insert');
    });
    expect(await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, -1, 'LOST'))).toMatchObject({ status: 'FAILED' });
    expect((await auditRows(w.owner.businessId)).map((a) => a.action)).toEqual(['stock.received']);
    expect(await balanceOf(w.owner.businessId, w.loc, w.maize.piece)).toBe(5);
    expect(await movements(w.owner.businessId)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 11. change_log
  it('11. balance changes through commands appear in change_log; rejected commands add nothing', async () => {
    const w = await world();
    const balanceLog = () =>
      asAdmin(
        async (c) =>
          (await c.query<{ operation: string; row_id: string }>(
            "SELECT operation, row_id FROM change_log WHERE business_id = $1 AND table_name = 'stock_balance' ORDER BY id",
            [w.owner.businessId],
          )).rows,
      );
    await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 5 }]));
    await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, -2, 'DAMAGED'));
    await sendOne(w.manager.token, adjust(w.loc, w.maize.piece, -50, 'DAMAGED')); // STOCK_INSUFFICIENT
    await sendOne(w.manager.token, receive(w.loc, [{ pack_type_id: w.maize.piece, quantity: 1 }, { pack_type_id: w.maize.carton, quantity: 0 }])); // INVALID_LINES
    const id = await asAdmin(
      async (c) => (await c.query<{ id: string }>('SELECT id FROM stock_balance WHERE business_id = $1', [w.owner.businessId])).rows[0].id,
    );
    expect(await balanceLog()).toEqual([
      { operation: 'INSERT', row_id: id },
      { operation: 'UPDATE', row_id: id },
    ]);
  });
});
