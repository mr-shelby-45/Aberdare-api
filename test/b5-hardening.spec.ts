import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EmailSender } from '../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../src/integrations/sms/sms.sender.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ProductsService } from '../src/modules/products/products.service.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, asMigrator, resetTables } from './helpers/db.js';

// Phase B5: hardening (docs/phase-b-design.md sections 3, 8 and 12). Numbers
// in test names refer to the B5 list in section 12. The grants inventory at
// the end was added in B5 with Ian's approval.

const PIN = '9384';
const PASSWORD = 'baobab-sunrise-73';
const IP = '198.51.100.90';
let seq = 0;
const newPhone = () => `+2547${String(90_000_000 + ++seq).slice(-8)}`;
const newEmail = () => `b5owner${++seq}@example.com`;

interface Owner {
  businessId: string;
  membershipId: string;
  token: string;
  refreshToken: string;
}
interface Result {
  command_id: string | null;
  status: string;
  reason?: string;
}
interface LogRow {
  table_name: string;
  operation: string;
  row_id: string;
  row_key: string | null;
}

describe('B5: hardening', { timeout: 120_000 }, () => {
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
    const r = json<{ access_token: string; refresh_token: string; membership: { id: string; business_id: string } }>(res);
    t.clock.advanceMinutes(2);
    return { businessId: r.membership.business_id, membershipId: r.membership.id, token: r.access_token, refreshToken: r.refresh_token };
  }

  const command = (type: string, payload: object) => ({ command_id: randomUUID(), type, occurred_at: t.clock.now().toISOString(), payload });
  const send = async (token: string, commands: unknown[]) => {
    const res = await post('/v1/sync/commands', { commands }, token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return json<{ results: Result[] }>(res).results;
  };
  const sendOne = async (token: string, cmd: unknown) => (await send(token, [cmd]))[0];

  function newProduct(name = 'Maize flour 2kg') {
    const productId = randomUUID();
    const piece = randomUUID();
    const carton = randomUUID();
    return {
      productId,
      piece,
      carton,
      create: command('product.create', {
        product_id: productId,
        name,
        pack_types: [
          { pack_type_id: piece, name: 'piece', units_per_pack: 1, sell_price: '180' },
          { pack_type_id: carton, name: 'carton of 24', units_per_pack: 24, sell_price: '4200' },
        ],
        barcodes: [],
      }),
    };
  }

  const changeLog = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<LogRow>('SELECT table_name, operation, row_id, row_key FROM change_log WHERE business_id = $1 ORDER BY id', [businessId])).rows,
    );
  const auditActions = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ action: string; actor_membership_id: string | null }>(
          'SELECT action, actor_membership_id FROM audit_log WHERE business_id = $1 ORDER BY occurred_at, action',
          [businessId],
        )).rows,
    );

  /** Makes the next audit write succeed and then crash the command or request. */
  function crashAfterNextAudit() {
    const audit = t.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementationOnce(async (entry) => {
      await original(entry);
      throw new Error('crash after the audit write');
    });
  }

  // ---------------------------------------------------------------- 1. change_log coverage
  describe('1. change_log coverage', () => {
    it('inserts and updates are logged for product, pack_type, location and product_barcode, the barcode with its code', async () => {
      const o = await signupOwner();
      const before = (await changeLog(o.businessId)).length; // signup's default location
      const p = newProduct();
      expect(await sendOne(o.token, p.create)).toMatchObject({ status: 'ACCEPTED' });
      expect(await sendOne(o.token, command('product.update', { product_id: p.productId, name: 'Maize flour 2 kg' }))).toMatchObject({
        status: 'ACCEPTED',
      });
      expect(
        await sendOne(o.token, command('pack_type.upsert', { pack_type_id: p.carton, product_id: p.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4300' })),
      ).toMatchObject({ status: 'ACCEPTED' });
      expect(await sendOne(o.token, command('barcode.add', { barcode: '036000291452', product_id: p.productId, pack_type_id: p.carton }))).toMatchObject({
        status: 'ACCEPTED',
      });
      expect(await sendOne(o.token, command('barcode.remove', { barcode: '036000291452' }))).toMatchObject({ status: 'ACCEPTED' });
      const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));
      expect((await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: 'Back store' })).statusCode).toBe(200);

      const barcodeRowId = (await changeLog(o.businessId)).find((r) => r.table_name === 'product_barcode')!.row_id;
      expect((await changeLog(o.businessId)).slice(before)).toEqual([
        { table_name: 'product', operation: 'INSERT', row_id: p.productId, row_key: null },
        { table_name: 'pack_type', operation: 'INSERT', row_id: p.piece, row_key: null },
        { table_name: 'pack_type', operation: 'INSERT', row_id: p.carton, row_key: null },
        { table_name: 'product', operation: 'UPDATE', row_id: p.productId, row_key: null },
        { table_name: 'pack_type', operation: 'UPDATE', row_id: p.carton, row_key: null },
        { table_name: 'product_barcode', operation: 'INSERT', row_id: barcodeRowId, row_key: '0036000291452' },
        // The delete row carries the code: phones know barcodes by code, and the row is gone.
        { table_name: 'product_barcode', operation: 'DELETE', row_id: barcodeRowId, row_key: '0036000291452' },
        { table_name: 'location', operation: 'INSERT', row_id: store.id, row_key: null },
        { table_name: 'location', operation: 'UPDATE', row_id: store.id, row_key: null },
      ]);
    });

    it('app_user cannot delete products, pack types or locations; the trigger still logs a delete done by migrator', async () => {
      const o = await signupOwner();
      const p = newProduct();
      expect(await sendOne(o.token, p.create)).toMatchObject({ status: 'ACCEPTED' });
      const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));

      await asAppUser(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.business_id', $1, true)", [o.businessId]);
        for (const [table, id] of [
          ['pack_type', p.carton],
          ['product', p.productId],
          ['location', store.id],
        ]) {
          await c.query('SAVEPOINT s');
          await expect(c.query(`DELETE FROM ${table} WHERE id = $1`, [id]), table).rejects.toThrow(new RegExp(`permission denied for table ${table}`));
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
        await c.query('ROLLBACK');
      });

      // A maintenance delete (as migrator, under the tenant setting) is logged by
      // the same trigger, with the right row id. Rolled back afterwards.
      const logged = await asMigrator(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query("SELECT set_config('app.business_id', $1, true)", [o.businessId]);
          await c.query('DELETE FROM pack_type WHERE id = $1', [p.carton]);
          await c.query('DELETE FROM pack_type WHERE id = $1', [p.piece]);
          await c.query('DELETE FROM product WHERE id = $1', [p.productId]);
          await c.query('DELETE FROM location WHERE id = $1', [store.id]);
          return (
            await c.query<{ table_name: string; operation: string; row_id: string }>(
              "SELECT table_name, operation, row_id FROM change_log WHERE operation = 'DELETE' ORDER BY id",
            )
          ).rows;
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(logged).toEqual([
        { table_name: 'pack_type', operation: 'DELETE', row_id: p.carton },
        { table_name: 'pack_type', operation: 'DELETE', row_id: p.piece },
        { table_name: 'product', operation: 'DELETE', row_id: p.productId },
        { table_name: 'location', operation: 'DELETE', row_id: store.id },
      ]);
    });

    it('a rolled-back change writes no change_log row, in each of the four tables', async () => {
      const o = await signupOwner();
      const p = newProduct();
      expect(await sendOne(o.token, p.create)).toMatchObject({ status: 'ACCEPTED' });
      expect(await sendOne(o.token, command('barcode.add', { barcode: '036000291452', product_id: p.productId, pack_type_id: p.piece }))).toMatchObject({
        status: 'ACCEPTED',
      });
      const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));
      const before = await changeLog(o.businessId);

      const crashed = [
        command('product.create', newProduct('Never saved').create.payload),
        command('product.update', { product_id: p.productId, name: 'Never renamed' }),
        command('pack_type.upsert', { pack_type_id: p.carton, product_id: p.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '1' }),
        command('barcode.add', { barcode: '11112222', product_id: p.productId, pack_type_id: p.carton }),
        command('barcode.remove', { barcode: '036000291452' }),
      ];
      for (const cmd of crashed) {
        crashAfterNextAudit();
        expect(await sendOne(o.token, cmd), cmd.type).toMatchObject({ status: 'FAILED' });
      }
      crashAfterNextAudit();
      expect((await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: 'Never renamed' })).statusCode).toBe(500);
      crashAfterNextAudit();
      expect((await post('/v1/locations', { name: 'Never created' }, o.token)).statusCode).toBe(500);

      expect(await changeLog(o.businessId)).toEqual(before);
      const codes = await asAdmin(async (c) => (await c.query<{ barcode: string }>('SELECT barcode FROM product_barcode')).rows.map((r) => r.barcode));
      expect(codes).toEqual(['0036000291452']);
    });
  });

  // ---------------------------------------------------------------- 2. audit
  describe('2. audit', () => {
    it('every audit action of section 8 is written exactly once, by the acting member', async () => {
      const o = await signupOwner();
      const before = (await auditActions(o.businessId)).length; // signup's own rows
      const p = newProduct();
      const steps = [
        p.create, // product.created, pack_type.created x2
        command('product.update', { product_id: p.productId, name: 'Maize 2kg' }), // product.updated
        command('product.update', { product_id: p.productId, archived: true }), // product.archived
        command('product.update', { product_id: p.productId, archived: false }), // product.restored
        command('pack_type.upsert', { pack_type_id: p.carton, product_id: p.productId, name: 'carton of 24', units_per_pack: 24, sell_price: '4300' }), // pack_type.updated
        command('barcode.add', { barcode: '036000291452', product_id: p.productId, pack_type_id: p.carton }), // barcode.added
        command('barcode.remove', { barcode: '036000291452' }), // barcode.removed
      ];
      for (const s of steps) expect(await sendOne(o.token, s), s.type).toMatchObject({ status: 'ACCEPTED' });
      const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token)); // location.created
      await call('PATCH', `/v1/locations/${store.id}`, o.token, { name: 'Back store' }); // location.updated
      await call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: true }); // location.archived
      await call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: false }); // location.restored

      const rows = (await auditActions(o.businessId)).slice(before);
      expect(rows.map((r) => r.action).sort()).toEqual(
        [
          'barcode.added',
          'barcode.removed',
          'location.archived',
          'location.created',
          'location.restored',
          'location.updated',
          'pack_type.created',
          'pack_type.created',
          'pack_type.updated',
          'product.archived',
          'product.created',
          'product.restored',
          'product.updated',
        ].sort(),
      );
      // All twelve actions of section 8 appear (pack_type.created once per pack type).
      expect(new Set(rows.map((r) => r.action)).size).toBe(12);
      for (const r of rows) expect(r.actor_membership_id, r.action).toBe(o.membershipId);
    });

    it('a crash right after the audit insert leaves no audit row and no data change, for every command type and location route', async () => {
      const o = await signupOwner();
      const p = newProduct();
      expect(await sendOne(o.token, p.create)).toMatchObject({ status: 'ACCEPTED' });
      expect(await sendOne(o.token, command('barcode.add', { barcode: '036000291452', product_id: p.productId, pack_type_id: p.piece }))).toMatchObject({
        status: 'ACCEPTED',
      });
      const store = json<{ id: string }>(await post('/v1/locations', { name: 'Store' }, o.token));
      const snapshot = () =>
        asAdmin(async (c) => ({
          audit: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0].n),
          products: (await c.query('SELECT id, name, sku, archived_at FROM product ORDER BY id')).rows,
          packs: (await c.query('SELECT id, name, units_per_pack, sell_price, archived_at FROM pack_type ORDER BY id')).rows,
          barcodes: (await c.query('SELECT barcode, pack_type_id FROM product_barcode ORDER BY barcode')).rows,
          locations: (await c.query('SELECT id, name, archived_at FROM location ORDER BY id')).rows,
        }));
      const before = await snapshot();

      const commands = [
        command('product.create', newProduct('Never saved').create.payload),
        command('product.update', { product_id: p.productId, archived: true }),
        command('pack_type.upsert', { pack_type_id: randomUUID(), product_id: p.productId, name: 'bale', units_per_pack: 6, sell_price: '1' }),
        command('barcode.add', { barcode: '11112222', product_id: p.productId, pack_type_id: p.carton }),
        command('barcode.remove', { barcode: '036000291452' }),
      ];
      for (const cmd of commands) {
        crashAfterNextAudit();
        expect(await sendOne(o.token, cmd), cmd.type).toMatchObject({ status: 'FAILED' });
      }
      for (const req of [
        () => post('/v1/locations', { name: 'Never created' }, o.token),
        () => call('PATCH', `/v1/locations/${store.id}`, o.token, { archived: true }),
      ]) {
        crashAfterNextAudit();
        expect((await req()).statusCode).toBe(500);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------- 3. logs
  it('3. no log line of a sync request, a failed command or a 500 contains names, prices, barcodes or tokens', async () => {
    const o = await signupOwner();
    // The log buffer is shared by the whole file (earlier tests crash commands
    // on purpose), so counts below look only at this test's lines. The leak
    // check looks at every line of the file, which is stricter.
    const firstLine = t.logs.length;
    const secrets = {
      name: 'ZEBRA-LOGCHECK-NAME',
      sku: 'SKU-LOGCHECK-77',
      sell: '987654.32',
      cost: '123456.78',
      barcode: 'LOGCHECK-BARCODE-1',
      otherBarcode: 'LOGCHECK-BARCODE-2',
      search: 'logcheck-search-text',
    };
    const p = newProduct(secrets.name);
    const payload = {
      ...p.create.payload,
      sku: secrets.sku,
      pack_types: [{ pack_type_id: p.piece, name: 'piece', units_per_pack: 1, sell_price: secrets.sell, cost_price: secrets.cost }],
      barcodes: [{ barcode: secrets.barcode, pack_type_id: p.piece }],
    };
    // Accepted, rejected (unknown product), and FAILED (a crash whose message quotes the data).
    // Only the first call crashes; later calls run the real method.
    const products = t.app.get(ProductsService, { strict: false });
    vi.spyOn(products, 'upsertPackType').mockImplementationOnce(async () => {
      throw new Error(`could not save ${secrets.name} at ${secrets.sell} with ${secrets.otherBarcode}`);
    });
    const crashing = command('pack_type.upsert', { pack_type_id: p.piece, product_id: p.productId, name: secrets.name, units_per_pack: 1, sell_price: secrets.sell });
    const results = await send(o.token, [
      command('product.create', payload),
      command('product.update', { product_id: randomUUID(), name: secrets.name, sku: secrets.sku }),
      crashing,
    ]);
    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED', 'FAILED']);

    // A 500 on the sync route itself, with the data in the error message.
    vi.spyOn(t.app.get(SyncService, { strict: false }), 'processCommands').mockRejectedValueOnce(
      new Error(`exploded on ${secrets.name} ${secrets.sell} ${secrets.barcode}`),
    );
    expect((await post('/v1/sync/commands', { commands: [command('product.create', payload)] }, o.token)).statusCode).toBe(500);

    // Reads: the search text and the scanned code stay out of the logs too.
    expect((await call('GET', `/v1/products?q=${secrets.search}`, o.token)).statusCode).toBe(200);
    expect((await call('GET', `/v1/products/by-barcode/${secrets.barcode}`, o.token)).statusCode).toBe(200);
    expect((await post('/v1/auth/refresh', { refresh_token: o.refreshToken })).statusCode).toBe(200);

    const raw = t.rawLogs();
    for (const [what, value] of Object.entries({ ...secrets, accessToken: o.token, refreshToken: o.refreshToken })) {
      expect(raw.includes(value), `${what} appears in the logs`).toBe(false);
    }
    // The failed command is logged by id and type only.
    const mine = t.logs.slice(firstLine);
    const failed = mine.filter((l) => l.msg === 'sync command failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ commandId: crashing.command_id, commandType: 'pack_type.upsert', errorName: 'Error' });
    // And the 500 was logged, so the check above saw that line too.
    expect(mine.some((l) => l.route === '/v1/sync/commands' && l.status === 500)).toBe(true);
  });

  // ---------------------------------------------------------------- grants inventory
  it("grants inventory: app_user's exact privileges on every table (approved in B5)", async () => {
    const tables = await asAdmin(
      async (c) =>
        (await c.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 1")).rows.map(
          (r) => r.relname,
        ),
    );
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const actual: Record<string, string> = {};
    await asAdmin(async (c) => {
      for (const table of tables) {
        const held: string[] = [];
        for (const priv of privileges) {
          const r = await c.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', ['app_user', `public.${table}`, priv]);
          if (r.rows[0].ok) held.push(priv);
        }
        actual[table] = held.join(',') || '-';
      }
    });
    // The exact list: a new table, or a changed grant, must be added here on purpose.
    expect(actual).toEqual({
      _prisma_migrations: '-',
      approval: 'SELECT,INSERT', // plus UPDATE of the two consumption columns only (checked below; Phase C1)
      audit_log: 'SELECT,INSERT',
      business: 'SELECT', // plus INSERT of id, name, type only (checked below)
      change_log: 'SELECT,INSERT', // pruned only through change_log_prune() (Phase D1)
      change_log_horizon: 'SELECT', // written only by change_log_prune() (Phase D1)
      device: 'SELECT,INSERT', // plus UPDATE of five columns only (checked below; Phase D1)
      device_membership: 'SELECT,INSERT,DELETE',
      location: 'SELECT,INSERT,UPDATE',
      membership: 'SELECT,INSERT,UPDATE',
      otp_challenge: '-',
      pack_type: 'SELECT,INSERT,UPDATE',
      payment: 'SELECT,INSERT', // plus UPDATE of status only (checked below; Phase E1)
      person: '-', // a few columns only (checked below)
      product: 'SELECT,INSERT,UPDATE',
      product_barcode: 'SELECT,INSERT,DELETE',
      refresh_token: 'SELECT,INSERT,UPDATE',
      sale: 'SELECT,INSERT', // plus UPDATE of status, paid_total, balance_due and the void columns (checked below; Phase E1)
      sale_counter: 'SELECT,INSERT', // plus UPDATE of last_number (checked below; Phase E1)
      sale_item: 'SELECT,INSERT', // append-only (Phase E1)
      stock_balance: 'SELECT,INSERT,UPDATE',
      stock_conversion: 'SELECT,INSERT',
      stock_movement: 'SELECT,INSERT',
      sync_command: 'SELECT,INSERT,UPDATE',
    });

    const columns = await asAdmin(
      async (c) =>
        (
          await c.query<{ table_name: string; privilege_type: string; columns: string }>(
            `SELECT table_name, privilege_type, string_agg(column_name, ',' ORDER BY column_name) AS columns
               FROM information_schema.column_privileges
              WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name IN ('approval', 'business', 'device', 'payment', 'person', 'sale', 'sale_counter')
              GROUP BY 1, 2 ORDER BY 1, 2`,
          )
        ).rows,
    );
    expect(columns).toEqual([
      {
        table_name: 'approval',
        privilege_type: 'INSERT',
        columns: 'approver_membership_id,business_id,consumed_at,consumed_by_sync_command_id,created_at,device_id,id,purpose,requester_membership_id,valid_until',
      },
      {
        table_name: 'approval',
        privilege_type: 'SELECT',
        columns: 'approver_membership_id,business_id,consumed_at,consumed_by_sync_command_id,created_at,device_id,id,purpose,requester_membership_id,valid_until',
      },
      { table_name: 'approval', privilege_type: 'UPDATE', columns: 'consumed_at,consumed_by_sync_command_id' },
      { table_name: 'business', privilege_type: 'INSERT', columns: 'id,name,type' },
      { table_name: 'business', privilege_type: 'SELECT', columns: 'created_at,id,name,type,updated_at' },
      // Phase D1: table-wide UPDATE replaced by the columns the application writes.
      {
        table_name: 'device',
        privilege_type: 'INSERT',
        columns: 'business_id,created_at,id,is_shared,last_seen_at,last_sync_at,name,platform,push_token,registered_by_membership_id,secret_hash,status',
      },
      {
        table_name: 'device',
        privilege_type: 'SELECT',
        columns: 'business_id,created_at,id,is_shared,last_seen_at,last_sync_at,name,platform,push_token,registered_by_membership_id,secret_hash,status',
      },
      { table_name: 'device', privilege_type: 'UPDATE', columns: 'is_shared,last_seen_at,last_sync_at,name,status' },
      // Phase E1: payments are only ever reversed (status).
      {
        table_name: 'payment',
        privilege_type: 'INSERT',
        columns: 'amount,business_id,created_at,created_by_membership_id,duplicate_of_payment_id,id,method,mpesa_code,occurred_at,sale_id,status,verified',
      },
      {
        table_name: 'payment',
        privilege_type: 'SELECT',
        columns: 'amount,business_id,created_at,created_by_membership_id,duplicate_of_payment_id,id,method,mpesa_code,occurred_at,sale_id,status,verified',
      },
      { table_name: 'payment', privilege_type: 'UPDATE', columns: 'status' },
      { table_name: 'person', privilege_type: 'SELECT', columns: 'created_at,email,email_verified_at,id,phone,phone_verified_at' },
      // Phase E1: a sale changes only by payments and the void; the counter only by its number.
      {
        table_name: 'sale',
        privilege_type: 'INSERT',
        columns:
          'balance_due,business_id,created_at,created_by_membership_id,device_id,id,local_ref,location_id,note,occurred_at,paid_total,received_at,sale_number,status,total,total_mismatch,void_approval_id,void_approved_by_membership_id,void_note,void_reason,voided_at,voided_by_membership_id',
      },
      {
        table_name: 'sale',
        privilege_type: 'SELECT',
        columns:
          'balance_due,business_id,created_at,created_by_membership_id,device_id,id,local_ref,location_id,note,occurred_at,paid_total,received_at,sale_number,status,total,total_mismatch,void_approval_id,void_approved_by_membership_id,void_note,void_reason,voided_at,voided_by_membership_id',
      },
      {
        table_name: 'sale',
        privilege_type: 'UPDATE',
        columns: 'balance_due,paid_total,status,void_approval_id,void_approved_by_membership_id,void_note,void_reason,voided_at,voided_by_membership_id',
      },
      { table_name: 'sale_counter', privilege_type: 'INSERT', columns: 'business_id,last_number' },
      { table_name: 'sale_counter', privilege_type: 'SELECT', columns: 'business_id,last_number' },
      { table_name: 'sale_counter', privilege_type: 'UPDATE', columns: 'last_number' },
    ]);
    // Nothing is granted to PUBLIC on any table.
    const publicGrants = await asAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.grantee = 0`,
          )
        ).rows,
    );
    expect(publicGrants).toEqual([]);
  });
});
