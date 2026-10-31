import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { TenantRunner } from '../../src/database/tenant.js';
import { EmailSender } from '../../src/integrations/email/email.sender.js';
import type { FakeEmailSender } from '../../src/integrations/email/fake-email.sender.js';
import type { FakeSmsSender } from '../../src/integrations/sms/fake-sms.sender.js';
import { SmsSender } from '../../src/integrations/sms/sms.sender.js';
import { StockIntegrityService } from '../../src/modules/stock/stock-integrity.service.js';
import { StockService } from '../../src/modules/stock/stock.service.js';
import type { TestApp } from './app.js';
import { asAdmin } from './db.js';

// Phase C test helpers (from C3; the C2 file keeps its own copy): a business
// with an owner, a manager and an attendant created through the real API,
// commands sent through POST /v1/sync/commands, and superuser reads of the
// stock tables for assertions only. Code under test always runs as app_user.

export interface Member {
  businessId: string;
  membershipId: string;
  token: string;
  // Staff only (C5: PIN login checks).
  deviceId?: string;
  deviceSecret?: string;
  // Owner only (D3: a password login on a second device).
  email?: string;
}

/** The PIN every staff member gets at activation. */
export const STAFF_PIN = '6071';
/** The owner's PIN at signup. */
export const OWNER_PIN = '9384';
export interface Result {
  command_id: string | null;
  status: string;
  reason?: string;
  message?: string;
  result?: unknown;
}
export interface Pack {
  productId: string;
  piece: string;
  carton: string;
}
export interface World {
  owner: Member;
  manager: Member;
  attendant: Member;
  loc: string;
  maize: Pack;
}
export interface MovementRow {
  movement_type: string;
  location_id: string;
  pack_type_id: string;
  quantity_change: number;
  quantity_after: number;
  occurred_at: Date;
  created_by_membership_id: string | null;
  sync_command_id: string | null;
  expected_quantity: number | null;
  counted_quantity: number | null;
  reason: string | null;
  note: string | null;
}

const PIN = OWNER_PIN;
/** The owner's password at signup. */
export const OWNER_PASSWORD = 'baobab-sunrise-73';
const PASSWORD = OWNER_PASSWORD;

/** phoneBase keeps each test file's phone numbers apart (8 digits after +2547). */
export function stockApi(t: TestApp, ip: string, phoneBase: number) {
  let seq = 0;
  const newPhone = () => `+2547${String(phoneBase + ++seq).slice(-8)}`;
  const newEmail = () => `stock${phoneBase}-${++seq}@example.com`;
  const sms = () => t.app.get(SmsSender) as FakeSmsSender;
  const mail = () => t.app.get(EmailSender) as FakeEmailSender;

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown) =>
    t.app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: ip });
  const post = (url: string, payload: unknown, token?: string) => call('POST', url, token, payload);
  const json = <T>(res: LightMyRequestResponse) => res.json() as T;

  function lastCode(outbox: { to: string; message: string }[], to: string): string {
    const msg = [...outbox].reverse().find((m) => m.to === to);
    const code = msg?.message.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${to}`);
    return code;
  }

  async function signupOwner(businessName: string): Promise<Member> {
    const phone = newPhone();
    const email = newEmail();
    expect((await post('/v1/auth/signup/start', { phone, email })).statusCode).toBe(202);
    const verified = await post('/v1/auth/signup/verify', {
      phone,
      email,
      phone_code: lastCode(sms().outbox, phone),
      email_code: lastCode(mail().outbox, email),
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
    return { businessId: r.membership.business_id, membershipId: r.membership.id, token: r.access_token, email };
  }

  async function activeStaff(owner: Member, rolePreset: 'MANAGER' | 'ATTENDANT' | 'FIELD_ATTENDANT', displayName: string): Promise<Member> {
    const phone = newPhone();
    const created = await post('/v1/staff', { phone, display_name: displayName, role_preset: rolePreset }, owner.token);
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const { membership_id: membershipId, temp_pin: tempPin } = json<{ membership_id: string; temp_pin: string }>(created);
    const first = await post('/v1/auth/first-login', { phone, temp_pin: tempPin });
    const res = await post('/v1/auth/staff/activate', {
      setup_token: json<{ setup_token: string }>(first).setup_token,
      code: lastCode(sms().outbox, phone),
      new_pin: STAFF_PIN,
      device: { name: 'Staff phone', platform: 'android' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const s = json<{ access_token: string; device_id: string; device_secret: string }>(res);
    return { businessId: owner.businessId, membershipId, token: s.access_token, deviceId: s.device_id, deviceSecret: s.device_secret };
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

  async function newLocation(owner: Member, name: string): Promise<string> {
    const res = await post('/v1/locations', { name }, owner.token);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    return json<{ id: string }>(res).id;
  }

  // Superuser reads, for assertions only.
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
        (await c.query<MovementRow>(
          `SELECT movement_type, location_id, pack_type_id, quantity_change, quantity_after, occurred_at,
                  created_by_membership_id, sync_command_id, expected_quantity, counted_quantity, reason, note
             FROM stock_movement WHERE business_id = $1 ORDER BY created_at, id`,
          [businessId],
        )).rows,
    );
  const ledgerSum = async (businessId: string, loc: string, pack: string) =>
    (await movements(businessId)).filter((m) => m.location_id === loc && m.pack_type_id === pack).reduce((s, m) => s + m.quantity_change, 0);
  const syncCommand = (businessId: string, commandId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ id: string; status: string }>('SELECT id, status FROM sync_command WHERE business_id = $1 AND command_id = $2', [businessId, commandId]))
          .rows[0],
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
  const balanceLog = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ pack_type_id: string; operation: string }>(
          `SELECT b.pack_type_id, l.operation FROM change_log l JOIN stock_balance b ON b.id = l.row_id
            WHERE l.business_id = $1 AND l.table_name = 'stock_balance' ORDER BY l.id`,
          [businessId],
        )).rows,
    );
  const integrity = (businessId: string) =>
    t.app.get(TenantRunner, { strict: false }).run(businessId, () => t.app.get(StockIntegrityService, { strict: false }).check());

  /** Sale mode (the spike's repository code; Phase E builds sale.create): may take a pool below zero. */
  const sell = (w: World, loc: string, pack: string, qty: number) =>
    t.app
      .get(TenantRunner, { strict: false })
      .run(w.owner.businessId, () =>
        t.app
          .get(StockService, { strict: false })
          .decreaseForSale(loc, pack, qty, { occurredAt: t.clock.now(), createdByMembershipId: w.manager.membershipId, syncCommandId: null }),
      );

  const resetOutboxes = () => {
    sms().outbox.length = 0;
    mail().outbox.length = 0;
  };

  return {
    call,
    post,
    json,
    command,
    send,
    sendOne,
    newProduct,
    world,
    newLocation,
    balances,
    balanceOf,
    movements,
    ledgerSum,
    syncCommand,
    auditRows,
    balanceLog,
    integrity,
    sell,
    resetOutboxes,
    activeStaff,
  };
}
