import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PRESET_PERMISSIONS, effectivePermissions } from '../src/common/auth/permissions.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, asAppUser, resetTables } from './helpers/db.js';
import { type World, stockApi } from './helpers/stock-api.js';

// Phase T1: schema, the FIELD_ATTENDANT preset, the new permissions and field
// locations (docs/phase-t-design.md sections 3 and 11). Test numbers follow
// the T1 list in section 11; test 6 is the earlier suites.

describe('T1: field schema, preset and permissions', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.190', 99_000_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  const errorOf = (res: LightMyRequestResponse) => {
    const e = (res.json() as { error?: { code: string } }).error;
    return { status: res.statusCode, code: e?.code };
  };
  /** A shop with a field attendant and their field location. */
  async function fieldShop(name = 'Duka A'): Promise<World & { field: Awaited<ReturnType<typeof api.activeStaff>>; van: string }> {
    const w = await api.world(name);
    const field = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Otieno');
    const res = await api.post('/v1/locations', { name: 'Van 1', kind: 'FIELD', assigned_membership_id: field.membershipId }, w.owner.token);
    expect(res.statusCode, res.body).toBe(201);
    return { ...w, field, van: api.json<{ id: string }>(res).id };
  }

  /** Runs statements as app_user in one rolled-back transaction; each answers 'ok' or its SQLSTATE and constraint. */
  async function asTenant(businessId: string, fn: (attempt: (sql: string, params?: unknown[]) => Promise<string>, c: pg.Client) => Promise<void>): Promise<void> {
    await asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
      const attempt = async (sql: string, params: unknown[] = []) => {
        await c.query('SAVEPOINT a');
        try {
          await c.query(sql, params);
          await c.query('RELEASE SAVEPOINT a');
          return 'ok';
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT a');
          const e = err as { code?: string; constraint?: string };
          return `${e.code}${e.constraint ? ` ${e.constraint}` : ''}`;
        }
      };
      try {
        await fn(attempt, c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }
  const newCommand = async (c: pg.Client, businessId: string) =>
    (
      await c.query<{ id: string }>(
        "INSERT INTO sync_command (business_id, command_id, type, occurred_at, received_at, status) VALUES ($1, gen_random_uuid(), 't1.test', now(), now(), 'PROCESSING') RETURNING id",
        [businessId],
      )
    ).rows[0].id;
  const settlementSql = `INSERT INTO field_settlement (id, business_id, field_location_id, attendant_membership_id, closed_by_membership_id, sync_command_id,
      occurred_at, received_at, period_start, period_end, expected_cash, cash_received, cash_variance, mpesa_verified_total, mpesa_unverified_total,
      sale_count, voided_count, unpaid_total, snapshot, sequence, earlier_sales_cash)
    VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now() - interval '1 day', now(), 100, $7, $7::numeric - 100, 0, 0, 1, 0, 0, pg_current_snapshot()::text,
            (SELECT coalesce(max(sequence), 0) + 1 FROM field_settlement WHERE field_location_id = $3), 0)`; // snapshot since T4, sequence since T5, earlier_sales_cash since T6

  // ---------------------------------------------------------------- 1. inventories and grants
  it('1. app_user may only read and insert transfers, settlements and lines; a location\'s kind and assignee never change', async () => {
    const privileges = await asAdmin(async (c) => {
      const out: Record<string, string> = {};
      for (const table of ['stock_transfer', 'field_settlement', 'field_settlement_line']) {
        const held: string[] = [];
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          if ((await c.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', ['app_user', `public.${table}`, p])).rows[0].ok) held.push(p);
        }
        out[table] = held.join(',');
      }
      for (const column of ['kind', 'assigned_membership_id', 'is_default', 'name', 'archived_at']) {
        out[`location.${column}`] = (await c.query<{ ok: boolean }>("SELECT has_column_privilege('app_user', 'public.location', $1, 'UPDATE') AS ok", [column])).rows[0].ok ? 'UPDATE' : '-';
      }
      out['location.DELETE'] = (await c.query<{ ok: boolean }>("SELECT has_table_privilege('app_user', 'public.location', 'DELETE') AS ok")).rows[0].ok ? 'yes' : 'no';
      return out;
    });
    expect(privileges).toEqual({
      stock_transfer: 'SELECT,INSERT',
      field_settlement: 'SELECT,INSERT',
      field_settlement_line: 'SELECT,INSERT',
      'location.kind': '-',
      'location.assigned_membership_id': '-',
      'location.is_default': '-',
      'location.name': 'UPDATE',
      'location.archived_at': 'UPDATE',
      'location.DELETE': 'no',
    });
  });

  // ---------------------------------------------------------------- 2. checks
  it('2. the database refuses bad kinds, assignees, defaults, a second active field location, bad transfers, movements and settlements', async () => {
    const w = await fieldShop();
    const second = await api.activeStaff(w.owner, 'FIELD_ATTENDANT', 'Wafula');
    const outcomes: Record<string, string> = {};
    await asTenant(w.owner.businessId, async (attempt, c) => {
      const loc = (kind: string, assignee: string | null, extra = '') =>
        attempt(`INSERT INTO location (business_id, name, kind, assigned_membership_id${extra ? ', is_default' : ''}) VALUES ($1, 'X', $2, $3${extra ? ', true' : ''})`, [w.owner.businessId, kind, assignee]);
      outcomes.unknownKind = await loc('TRUCK', null);
      outcomes.warehouse = await loc('WAREHOUSE', null);
      outcomes.assigneeOnShop = await loc('SHOP', second.membershipId);
      outcomes.fieldWithoutAssignee = await loc('FIELD', null);
      outcomes.setDefaultAsAppUser = await attempt(
        "INSERT INTO location (business_id, name, kind, assigned_membership_id, is_default) VALUES ($1, 'X', 'FIELD', $2, false)",
        [w.owner.businessId, second.membershipId],
      ).then(async () => {
        // the default flag on a field location (an existing default row is in the way of a second default, so flip a field row)
        await c.query('SAVEPOINT d');
        try {
          await c.query("UPDATE location SET is_default = true WHERE kind = 'FIELD' AND assigned_membership_id = $1", [second.membershipId]);
          return 'ok';
        } catch (err) {
          return `${(err as { code: string }).code}`;
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT d');
        }
      });
      outcomes.secondActiveField = await loc('FIELD', w.field.membershipId);
      await c.query("UPDATE location SET archived_at = now() WHERE id = $1", [w.van]);
      outcomes.newActiveAfterArchive = await loc('FIELD', w.field.membershipId);

      const cmd = await newCommand(c, w.owner.businessId);
      const transfer = randomUUID();
      outcomes.transfer = await attempt(
        "INSERT INTO stock_transfer (id, business_id, kind, from_location_id, to_location_id, occurred_at, created_by_membership_id, sync_command_id) VALUES ($1, $2, 'ISSUE', $3, $4, now(), $5, $6)",
        [transfer, w.owner.businessId, w.loc, w.van, w.manager.membershipId, cmd],
      );
      outcomes.transferToSameLocation = await attempt(
        "INSERT INTO stock_transfer (business_id, kind, from_location_id, to_location_id, occurred_at, created_by_membership_id, sync_command_id) VALUES ($1, 'ISSUE', $2, $2, now(), $3, $4)",
        [w.owner.businessId, w.loc, w.manager.membershipId, cmd],
      );
      outcomes.transferKind = await attempt(
        "INSERT INTO stock_transfer (business_id, kind, from_location_id, to_location_id, occurred_at, created_by_membership_id, sync_command_id) VALUES ($1, 'MOVE', $2, $3, now(), $4, $5)",
        [w.owner.businessId, w.loc, w.van, w.manager.membershipId, cmd],
      );
      const move = (type: string, change: number, transferId: string | null, settlementId: string | null = null, reason: string | null = null) =>
        attempt(
          'INSERT INTO stock_movement (business_id, location_id, pack_type_id, quantity_change, movement_type, quantity_after, occurred_at, transfer_id, settlement_id, reason) VALUES ($1, $2, $3, $4, $5, 0, now(), $6, $7, $8)',
          [w.owner.businessId, w.loc, w.maize.piece, change, type, transferId, settlementId, reason],
        );
      outcomes.transferOut = await move('TRANSFER_OUT', -2, transfer);
      outcomes.transferIn = await move('TRANSFER_IN', 2, transfer);
      outcomes.transferOutWithoutTransfer = await move('TRANSFER_OUT', -2, null);
      outcomes.transferOutPositive = await move('TRANSFER_OUT', 2, transfer);
      outcomes.transferInNegative = await move('TRANSFER_IN', -2, transfer);
      outcomes.transferIdOnReceive = await move('RECEIVE', 2, transfer);

      const settlement = randomUUID();
      outcomes.settlement = await attempt(settlementSql, [settlement, w.owner.businessId, w.van, w.field.membershipId, w.manager.membershipId, cmd, '90']);
      outcomes.negativeCash = await attempt(settlementSql, [randomUUID(), w.owner.businessId, w.van, w.field.membershipId, w.manager.membershipId, cmd, '-1']);
      outcomes.settlementOnAdjust = await move('ADJUST', -1, null, settlement, 'LOST');
      outcomes.settlementOnReceive = await move('RECEIVE', 1, null, settlement);
      const line = (counted: number, expected: number, variance: number) =>
        attempt(
          'INSERT INTO field_settlement_line (business_id, settlement_id, pack_type_id, issued, returned, sold, voided_back, expected_quantity, counted_quantity, variance) VALUES ($1, $2, $3, 5, 0, 3, 0, $4, $5, $6)',
          [w.owner.businessId, settlement, w.maize.piece, expected, counted, variance],
        );
      outcomes.lineWrongVariance = await line(1, 2, 0);
      outcomes.line = await line(1, 2, -1);
      outcomes.lineTwice = await line(1, 2, -1);
      outcomes.updateSettlement = await attempt('UPDATE field_settlement SET cash_received = 100 WHERE id = $1', [settlement]);
      outcomes.deleteLine = await attempt('DELETE FROM field_settlement_line WHERE settlement_id = $1', [settlement]);
    });
    expect(outcomes).toEqual({
      unknownKind: '23514 location_kind_known',
      warehouse: 'ok',
      assigneeOnShop: '23514 location_assignee_on_field',
      fieldWithoutAssignee: '23514 location_assignee_on_field',
      setDefaultAsAppUser: '42501', // app_user cannot change is_default at all; the check itself is shown below as the table owner
      secondActiveField: '23505 location_one_active_field_per_member',
      newActiveAfterArchive: 'ok',
      transfer: 'ok',
      transferToSameLocation: '23514 stock_transfer_locations_differ',
      transferKind: '23514 stock_transfer_kind_known',
      transferOut: 'ok',
      transferIn: 'ok',
      transferOutWithoutTransfer: '23514 stock_movement_transfer_id_on_transfers',
      transferOutPositive: '23514 stock_movement_type_sign',
      transferInNegative: '23514 stock_movement_type_sign',
      transferIdOnReceive: '23514 stock_movement_transfer_id_on_transfers',
      settlement: 'ok',
      negativeCash: '23514 field_settlement_cash_not_negative',
      settlementOnAdjust: 'ok',
      settlementOnReceive: '23514 stock_movement_settlement_id_on_adjust',
      lineWrongVariance: '23514 field_settlement_line_variance',
      line: 'ok',
      lineTwice: '23505 field_settlement_line_business_id_settlement_id_pack_type_i_key',
      updateSettlement: '42501',
      deleteLine: '42501',
    });
    // A FIELD location can never be the default, even for the table owner.
    const asOwner = await asAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query("UPDATE location SET is_default = false WHERE business_id = $1", [w.owner.businessId]);
        await c.query('UPDATE location SET is_default = true WHERE id = $1', [w.van]);
        return 'ok';
      } catch (err) {
        return `${(err as { code: string; constraint: string }).code} ${(err as { constraint: string }).constraint}`;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(asOwner).toBe('23514 location_field_not_default');
  });

  // ---------------------------------------------------------------- 3. composite keys
  it('3. transfers, settlements, assignees, closers and lines must belong to the same business', async () => {
    const a = await fieldShop('Duka A');
    const b = await fieldShop('Duka B');
    const outcomes: Record<string, string> = {};
    await asTenant(a.owner.businessId, async (attempt, c) => {
      const cmd = await newCommand(c, a.owner.businessId);
      outcomes.assigneeOfB = await attempt(
        "INSERT INTO location (business_id, name, kind, assigned_membership_id) VALUES ($1, 'X', 'FIELD', $2)",
        [a.owner.businessId, b.field.membershipId],
      );
      const transfer = (from: string, to: string, by: string) =>
        attempt(
          "INSERT INTO stock_transfer (business_id, kind, from_location_id, to_location_id, occurred_at, created_by_membership_id, sync_command_id) VALUES ($1, 'ISSUE', $2, $3, now(), $4, $5)",
          [a.owner.businessId, from, to, by, cmd],
        );
      outcomes.transferFromB = await transfer(b.loc, a.van, a.manager.membershipId);
      outcomes.transferToB = await transfer(a.loc, b.van, a.manager.membershipId);
      outcomes.transferByB = await transfer(a.loc, a.van, b.manager.membershipId);
      const settle = (loc: string, attendant: string, closer: string) =>
        attempt(settlementSql, [randomUUID(), a.owner.businessId, loc, attendant, closer, cmd, '100']);
      outcomes.settlementAtB = await settle(b.van, a.field.membershipId, a.manager.membershipId);
      outcomes.settlementAttendantB = await settle(a.van, b.field.membershipId, a.manager.membershipId);
      outcomes.settlementCloserB = await settle(a.van, a.field.membershipId, b.manager.membershipId);
      const own = randomUUID();
      await attempt(settlementSql, [own, a.owner.businessId, a.van, a.field.membershipId, a.manager.membershipId, cmd, '100']);
      outcomes.lineOfB = await attempt(
        'INSERT INTO field_settlement_line (business_id, settlement_id, pack_type_id, issued, returned, sold, voided_back, expected_quantity, counted_quantity, variance) VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0)',
        [a.owner.businessId, own, b.maize.piece],
      );
    });
    for (const [what, outcome] of Object.entries(outcomes)) expect(outcome.split(' ')[0], what).toBe('23503');
  });

  // ---------------------------------------------------------------- 4. presets and extras
  it('4. FIELD_ATTENDANT has exactly three permissions and takes no extras; managers and owners gain stock.transfer and field.settle', async () => {
    expect([...PRESET_PERMISSIONS.FIELD_ATTENDANT].sort()).toEqual(['payments.confirm', 'sales.create', 'stock.view']);
    for (const preset of ['MANAGER', 'OWNER'] as const) {
      expect(PRESET_PERMISSIONS[preset].has('stock.transfer'), preset).toBe(true);
      expect(PRESET_PERMISSIONS[preset].has('field.settle'), preset).toBe(true);
    }
    expect(PRESET_PERMISSIONS.ATTENDANT.has('stock.transfer')).toBe(false);
    expect(PRESET_PERMISSIONS.ATTENDANT.has('field.settle')).toBe(false);
    // Stored extras are ignored on read for a field attendant.
    expect([...effectivePermissions('FIELD_ATTENDANT', ['costs.view', 'stock.transfer'])].sort()).toEqual(['payments.confirm', 'sales.create', 'stock.view']);

    const w = await fieldShop();
    // Live: /me shows exactly the three, and the manager has the two new ones.
    const me = async (token: string) => api.json<{ permissions: string[] }>(await api.call('GET', '/v1/me', token)).permissions;
    expect(await me(w.field.token)).toEqual(['payments.confirm', 'sales.create', 'stock.view']);
    expect(await me(w.manager.token)).toEqual(expect.arrayContaining(['field.settle', 'stock.transfer']));
    expect(await me(w.attendant.token)).not.toEqual(expect.arrayContaining(['stock.transfer']));
    // Even if extras reach the row, they are ignored.
    await asAdmin((c) => c.query("UPDATE membership SET extra_permissions = ARRAY['costs.view'] WHERE id = $1", [w.field.membershipId]));
    expect(await me(w.field.token)).toEqual(['payments.confirm', 'sales.create', 'stock.view']);
    await asAdmin((c) => c.query("UPDATE membership SET extra_permissions = '{}' WHERE id = $1", [w.field.membershipId]));

    // The staff API refuses extras for a field attendant, on create and on update.
    const created = await api.post('/v1/staff', { phone: '+254799000901', display_name: 'Kamau', role_preset: 'FIELD_ATTENDANT', extra_permissions: ['reports.view'] }, w.owner.token);
    expect(errorOf(created)).toEqual({ status: 422, code: 'EXTRA_PERMISSIONS_NOT_ALLOWED' });
    expect((await api.post('/v1/staff', { phone: '+254799000902', display_name: 'Njeri', role_preset: 'FIELD_ATTENDANT' }, w.owner.token)).statusCode).toBe(201);
    expect(errorOf(await api.call('PATCH', `/v1/staff/${w.field.membershipId}`, w.owner.token, { extra_permissions: ['reports.view'] }))).toEqual({ status: 422, code: 'EXTRA_PERMISSIONS_NOT_ALLOWED' });
    // An attendant with extras becomes a field attendant only if the extras are cleared in the same request.
    const att = await api.activeStaff(w.owner, 'ATTENDANT', 'Akinyi');
    expect((await api.call('PATCH', `/v1/staff/${att.membershipId}`, w.owner.token, { extra_permissions: ['reports.view'] })).statusCode).toBe(204);
    expect(errorOf(await api.call('PATCH', `/v1/staff/${att.membershipId}`, w.owner.token, { role_preset: 'FIELD_ATTENDANT' }))).toEqual({ status: 422, code: 'EXTRA_PERMISSIONS_NOT_ALLOWED' });
    expect((await api.call('PATCH', `/v1/staff/${att.membershipId}`, w.owner.token, { role_preset: 'FIELD_ATTENDANT', extra_permissions: [] })).statusCode).toBe(204);
    expect(await me(att.token)).toEqual(['payments.confirm', 'sales.create', 'stock.view']);
    // stock.convert as an extra is still refused below manager.
    expect(errorOf(await api.call('PATCH', `/v1/staff/${w.attendant.membershipId}`, w.owner.token, { extra_permissions: ['stock.convert'] }))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
  });

  // ---------------------------------------------------------------- 5. field locations
  it('5. the owner creates a field location for a field attendant; wrong assignees, kinds and a second active one are refused; audit carries kind and assignee', async () => {
    const w = await fieldShop();
    const b = await api.world('Duka B');
    const bField = await api.activeStaff(b.owner, 'FIELD_ATTENDANT', 'Mutua');
    const create = (body: object, token = w.owner.token) => api.post('/v1/locations', body, token);

    const list = api.json<{ locations: Record<string, unknown>[] }>(await api.call('GET', '/v1/locations', w.owner.token)).locations;
    expect(list.find((l) => l.id === w.van)).toEqual({ id: w.van, name: 'Van 1', is_default: false, kind: 'FIELD', assigned_membership_id: w.field.membershipId, archived: false });
    expect(list.find((l) => l.is_default)).toMatchObject({ kind: 'SHOP', assigned_membership_id: null });
    // A warehouse; a shop is the default kind.
    expect(api.json<{ kind: string }>(await create({ name: 'Store', kind: 'WAREHOUSE' })).kind).toBe('WAREHOUSE');
    expect(api.json<{ kind: string }>(await create({ name: 'Kiosk' })).kind).toBe('SHOP');

    // Refusals.
    expect(errorOf(await create({ name: 'Van 2', kind: 'FIELD' }))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await create({ name: 'Shop 2', kind: 'SHOP', assigned_membership_id: w.field.membershipId }))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    for (const who of [w.attendant.membershipId, w.manager.membershipId, bField.membershipId, randomUUID()]) {
      expect(errorOf(await create({ name: 'Van 2', kind: 'FIELD', assigned_membership_id: who })), who).toEqual({ status: 422, code: 'ASSIGNEE_INVALID' });
    }
    expect(errorOf(await create({ name: 'Van 2', kind: 'TRUCK' }))).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(errorOf(await create({ name: 'Van 2', kind: 'FIELD', assigned_membership_id: w.field.membershipId }))).toEqual({ status: 409, code: 'FIELD_LOCATION_EXISTS' });
    expect(errorOf(await create({ name: 'Van 2', kind: 'FIELD', assigned_membership_id: w.field.membershipId }, w.manager.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });

    // Reassignment: archive the old one, create a new one; the old one cannot be restored while the new one is active.
    expect((await api.call('PATCH', `/v1/locations/${w.van}`, w.owner.token, { archived: true })).statusCode).toBe(200);
    const van2 = await create({ name: 'Van 2', kind: 'FIELD', assigned_membership_id: w.field.membershipId });
    expect(van2.statusCode, van2.body).toBe(201);
    expect(errorOf(await api.call('PATCH', `/v1/locations/${w.van}`, w.owner.token, { archived: false }))).toEqual({ status: 409, code: 'FIELD_LOCATION_EXISTS' });
    // An invited (not yet activated) field attendant can be assigned.
    const invited = api.json<{ membership_id: string }>(await api.post('/v1/staff', { phone: '+254799000903', display_name: 'Chege', role_preset: 'FIELD_ATTENDANT' }, w.owner.token)).membership_id;
    expect((await create({ name: 'Van 3', kind: 'FIELD', assigned_membership_id: invited })).statusCode).toBe(201);

    // Audit rows carry kind and assignee.
    const audit = await asAdmin(
      async (c) =>
        (await c.query<{ action: string; target_id: string; metadata: Record<string, unknown> }>(
          "SELECT action, target_id, metadata FROM audit_log WHERE business_id = $1 AND action LIKE 'location.%' AND target_id = $2 ORDER BY occurred_at, action",
          [w.owner.businessId, w.van],
        )).rows,
    );
    expect(audit.map((r) => [r.action, r.metadata])).toEqual([
      ['location.created', { is_default: false, kind: 'FIELD', assigned_membership_id: w.field.membershipId }],
      ['location.archived', { kind: 'FIELD', assigned_membership_id: w.field.membershipId }],
    ]);
    // Nothing of business B's field attendant leaks into A's locations.
    expect(JSON.stringify(api.json(await api.call('GET', '/v1/locations?include_archived=true', w.owner.token)))).not.toContain(bField.membershipId);
  });
});
