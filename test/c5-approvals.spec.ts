import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PasswordHasher } from '../src/common/auth/password-hasher.js';
import { PRESET_PERMISSIONS } from '../src/common/auth/permissions.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, OWNER_PIN, STAFF_PIN, type World, stockApi } from './helpers/stock-api.js';

// Phase C5: approvals (docs/phase-c-design.md section 6) and the approval path
// of stock.convert. Numbers in test names refer to the C5 list in section 13.

describe('C5: approvals', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.100', 91_000_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------- helpers
  const mint = (caller: Member, approver: string, pin: string) =>
    api.post('/v1/stock/approvals', { approver_membership_id: approver, approver_pin: pin, purpose: 'STOCK_CONVERT' }, caller.token);
  /** Mints and returns the approval id (the PIN must be right). */
  async function approval(caller: Member, approver: Member, pin = STAFF_PIN): Promise<string> {
    const res = await mint(caller, approver.membershipId, pin);
    expect(res.statusCode, res.body).toBe(201);
    return api.json<{ approval_id: string }>(res).approval_id;
  }
  const convert = (w: World, quantity: number, extra: object = {}, occurredAt?: string) =>
    api.command('stock.convert', { location_id: w.loc, from_pack_type_id: w.maize.carton, to_pack_type_id: w.maize.piece, quantity, ...extra }, occurredAt);
  const stockUp = (w: World, cartons: number) =>
    api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: w.maize.carton, quantity: cartons }] }));
  /** The error body without its per-request fields. */
  const denial = (res: LightMyRequestResponse) => {
    const body = res.json() as { error: { code: string; message: string } };
    return { status: res.statusCode, code: body.error.code, message: body.error.message, keys: Object.keys(body.error).sort() };
  };
  const approvalRow = (id: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ consumed_at: Date | null; consumed_by_sync_command_id: string | null; created_at: Date; valid_until: Date; device_id: string; requester_membership_id: string; approver_membership_id: string }>(
          'SELECT consumed_at, consumed_by_sync_command_id, created_at, valid_until, device_id, requester_membership_id, approver_membership_id FROM approval WHERE id = $1',
          [id],
        )).rows[0],
    );
  const counters = (membershipId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ approval_failed_count: number; approval_locked_until: Date | null; pin_failed_count: number; pin_locked_until: Date | null }>(
          'SELECT approval_failed_count, approval_locked_until, pin_failed_count, pin_locked_until FROM membership WHERE id = $1',
          [membershipId],
        )).rows[0],
    );
  const allAudit = (businessId: string) =>
    asAdmin(
      async (c) =>
        (await c.query<{ action: string; target_id: string; actor_membership_id: string | null; metadata: Record<string, unknown> }>(
          `SELECT action, target_id, actor_membership_id, metadata FROM audit_log WHERE business_id = $1 AND action LIKE ANY(ARRAY['approval.%', 'stock.converted']) ORDER BY occurred_at, action`,
          [businessId],
        )).rows,
    );
  /** Counts scrypt runs (real checks and dummy checks alike). */
  function scryptCounter(): () => number {
    const hasher = t.app.get(PasswordHasher) as unknown as { derive: (...args: unknown[]) => Promise<Buffer> };
    const spy = vi.spyOn(hasher, 'derive');
    return () => spy.mock.calls.length;
  }
  const pinLogin = (m: Member, pin: string) =>
    api.post('/v1/auth/pin', { device_id: m.deviceId, device_secret: m.deviceSecret, pin });
  /** A fresh access token on the same device, after the fake clock moved past the old one's lifetime. */
  async function relogin(m: Member): Promise<void> {
    const res = await pinLogin(m, STAFF_PIN);
    expect(res.statusCode, res.body).toBe(200);
    m.token = api.json<{ access_token: string }>(res).access_token;
  }

  // ---------------------------------------------------------------- 1. approvers
  it('1. GET /stock/approvers lists active members who can convert, not the caller, names only', async () => {
    const w = await api.world();
    const suspended = await api.activeStaff(w.owner, 'MANAGER', 'Dalmas');
    expect((await api.post(`/v1/staff/${suspended.membershipId}/suspend`, undefined, w.owner.token)).statusCode).toBe(204);
    const other = await api.activeStaff(w.owner, 'ATTENDANT', 'Esther');
    // stock.convert stored on an attendant as the superuser (the API refuses it): still not an approver.
    await asAdmin((c) => c.query("UPDATE membership SET extra_permissions = ARRAY['stock.convert'] WHERE id = $1", [other.membershipId]));

    const res = await api.call('GET', '/v1/stock/approvers', w.attendant.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      approvers: [
        { membership_id: w.owner.membershipId, display_name: 'Amina', role_preset: 'OWNER' },
        { membership_id: w.manager.membershipId, display_name: 'Baraka', role_preset: 'MANAGER' },
      ],
    });
    // The caller is never listed.
    expect(api.json<{ approvers: { membership_id: string }[] }>(await api.call('GET', '/v1/stock/approvers', w.manager.token)).approvers.map((a) => a.membership_id)).toEqual([
      w.owner.membershipId,
    ]);
    // Another business sees only its own.
    const b = await api.world('Duka B');
    expect(api.json<{ approvers: { membership_id: string }[] }>(await api.call('GET', '/v1/stock/approvers', b.attendant.token)).approvers.map((a) => a.membership_id).sort()).toEqual(
      [b.owner.membershipId, b.manager.membershipId].sort(),
    );
  });

  // ---------------------------------------------------------------- 2. minting
  it('2. the right PIN mints an approval; every refusal is the same 403 after exactly one scrypt run', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    const suspended = await api.activeStaff(w.owner, 'MANAGER', 'Dalmas');
    expect((await api.post(`/v1/staff/${suspended.membershipId}/suspend`, undefined, w.owner.token)).statusCode).toBe(204);
    const attendant2 = await api.activeStaff(w.owner, 'ATTENDANT', 'Esther');
    const lockedManager = await api.activeStaff(w.owner, 'MANAGER', 'Faith');
    for (let i = 0; i < 5; i++) expect((await mint(w.attendant, lockedManager.membershipId, '0000')).statusCode).toBe(403);
    expect((await counters(lockedManager.membershipId)).approval_locked_until).not.toBeNull();

    const scrypt = scryptCounter();
    const ok = await mint(w.attendant, w.manager.membershipId, STAFF_PIN);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(scrypt()).toBe(1);
    const body = api.json<{ approval_id: string; valid_until: string }>(ok);
    expect(Object.keys(body).sort()).toEqual(['approval_id', 'valid_until']);
    expect(body.valid_until).toBe(new Date(t.clock.now().getTime() + 15 * 60_000).toISOString());
    expect(await approvalRow(body.approval_id)).toMatchObject({
      requester_membership_id: w.attendant.membershipId,
      approver_membership_id: w.manager.membershipId,
      device_id: w.attendant.deviceId,
      consumed_at: null,
    });

    const cases: [string, string, string][] = [
      ['wrong PIN', w.manager.membershipId, '1111'],
      ['unknown approver', randomUUID(), STAFF_PIN],
      ['an attendant as approver', attendant2.membershipId, STAFF_PIN],
      ['a suspended approver', suspended.membershipId, STAFF_PIN],
      ['the caller themselves', w.attendant.membershipId, STAFF_PIN],
      ['a locked approver, right PIN', lockedManager.membershipId, STAFF_PIN],
      ["another business's manager", b.manager.membershipId, STAFF_PIN],
    ];
    const first = denial(await mint(w.attendant, w.manager.membershipId, '2222'));
    expect(first).toEqual({ status: 403, code: 'APPROVAL_DENIED', message: expect.any(String), keys: ['code', 'message', 'requestId', 'timestamp'] });
    for (const [name, approver, pin] of cases) {
      const before = scrypt();
      expect(denial(await mint(w.attendant, approver, pin)), name).toEqual(first);
      expect(scrypt() - before, name).toBe(1);
    }
    // A caller who can convert needs no approval.
    const notNeeded = await mint(w.manager, w.owner.membershipId, OWNER_PIN);
    expect(denial(notNeeded)).toMatchObject({ status: 422, code: 'APPROVAL_NOT_NEEDED' });
    // Only the one good approval exists.
    expect(await asAdmin(async (c) => (await c.query('SELECT 1 FROM approval WHERE business_id = $1', [w.owner.businessId])).rowCount)).toBe(1);
  });

  // ---------------------------------------------------------------- 3. counters
  it('3. five wrong PINs lock approvals for 15 minutes; the lock refuses a right PIN; the approver can still log in; success resets', async () => {
    const w = await api.world();
    for (let i = 0; i < 4; i++) expect((await mint(w.attendant, w.manager.membershipId, '0000')).statusCode).toBe(403);
    expect(await counters(w.manager.membershipId)).toMatchObject({ approval_failed_count: 4, approval_locked_until: null });
    // A success resets the count.
    await approval(w.attendant, w.manager);
    expect((await counters(w.manager.membershipId)).approval_failed_count).toBe(0);

    for (let i = 0; i < 5; i++) expect((await mint(w.attendant, w.manager.membershipId, '0000')).statusCode).toBe(403);
    const locked = await counters(w.manager.membershipId);
    expect(locked.approval_locked_until?.toISOString()).toBe(new Date(t.clock.now().getTime() + 15 * 60_000).toISOString());
    // The right PIN is refused during the lock, identically.
    const wrong = denial(await mint(w.attendant, w.manager.membershipId, '0000'));
    expect(denial(await mint(w.attendant, w.manager.membershipId, STAFF_PIN))).toEqual(wrong);
    // The login counters are untouched, and the manager's own PIN login works throughout.
    expect(await counters(w.manager.membershipId)).toMatchObject({ pin_failed_count: 0, pin_locked_until: null });
    expect((await pinLogin(w.manager, STAFF_PIN)).statusCode).toBe(200);

    t.clock.advanceMinutes(14);
    await relogin(w.attendant);
    expect((await mint(w.attendant, w.manager.membershipId, STAFF_PIN)).statusCode).toBe(403);
    t.clock.advanceMinutes(2);
    expect((await mint(w.attendant, w.manager.membershipId, STAFF_PIN)).statusCode).toBe(201);
    expect((await counters(w.manager.membershipId)).approval_failed_count).toBe(0);
    expect((await allAudit(w.owner.businessId)).filter((a) => a.action === 'approval.locked')).toEqual([
      { action: 'approval.locked', target_id: w.manager.membershipId, actor_membership_id: w.attendant.membershipId, metadata: { approver_membership_id: w.manager.membershipId, failed_count: 5 } },
    ]);
    expect((await pinLogin(w.manager, STAFF_PIN)).statusCode).toBe(200);
  });

  it('3. 20 concurrent wrong guesses are all counted and cause exactly one lock (run 5 times)', async () => {
    const w = await api.world();
    // Hold every request at the PIN check until all 20 are there, so they truly overlap.
    const hasher = t.app.get(PasswordHasher);
    const original = hasher.verify.bind(hasher);
    let arrived = 0;
    let release!: () => void;
    const allHere = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(hasher, 'verify').mockImplementation(async (secret, stored) => {
      if (++arrived === 20) release();
      await allHere;
      return original(secret, stored);
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => mint(w.attendant, w.manager.membershipId, '0000')));
    expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(403));
    expect(arrived).toBe(20);
    const c = await counters(w.manager.membershipId);
    expect(c.approval_failed_count).toBe(20);
    expect(c.approval_locked_until).not.toBeNull();
    expect(c.pin_failed_count).toBe(0);
    expect((await allAudit(w.owner.businessId)).filter((a) => a.action === 'approval.locked')).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 4. using an approval
  it('4. an attendant converts with an approval; it is used once; 20 concurrent commands with one approval give exactly one ACCEPTED', async () => {
    const w = await api.world();
    await stockUp(w, 10);
    const id = await approval(w.attendant, w.manager);
    const cmd = convert(w, 1, { approval_id: id });
    const r = await api.sendOne(w.attendant.token, cmd);
    expect(r).toEqual({ command_id: cmd.command_id, status: 'ACCEPTED', result: { from_after: 9, to_after: 24, units_added: 24, approved_by_membership_id: w.manager.membershipId } });
    const row = await approvalRow(id);
    expect(row.consumed_at).not.toBeNull();
    expect(row.consumed_by_sync_command_id).toBe((await api.syncCommand(w.owner.businessId, cmd.command_id)).id);
    const conversion = await asAdmin(
      async (c) =>
        (await c.query('SELECT created_by_membership_id, approved_by_membership_id, approval_id FROM stock_conversion WHERE business_id = $1', [w.owner.businessId])).rows,
    );
    expect(conversion).toEqual([{ created_by_membership_id: w.attendant.membershipId, approved_by_membership_id: w.manager.membershipId, approval_id: id }]);
    // Reusing it.
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: id }))).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });
    // Without any approval an attendant is still refused.
    expect(await api.sendOne(w.attendant.token, convert(w, 1))).toMatchObject({ status: 'REJECTED', reason: 'PERMISSION_DENIED' });

    const fresh = await approval(w.attendant, w.manager);
    const results = await Promise.all(Array.from({ length: 20 }, () => api.sendOne(w.attendant.token, convert(w, 1, { approval_id: fresh }))));
    expect(results.filter((x) => x.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'REJECTED' && x.reason === 'APPROVAL_INVALID')).toHaveLength(19);
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(8);
    expect(await api.integrity(w.owner.businessId)).toEqual([]);
  });

  // ---------------------------------------------------------------- 5. binding
  it('5. an approval works only for its member and device; another business’s approval is the same as a missing one', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    await stockUp(w, 10);
    await stockUp(b, 10);
    const attendant2 = await api.activeStaff(w.owner, 'ATTENDANT', 'Esther');
    const id = await approval(w.attendant, w.manager);

    // Another member.
    const otherMember = await api.sendOne(attendant2.token, convert(w, 1, { approval_id: id }));
    // Another device: the same attendant as the dispatcher sees them from another phone.
    const sync = t.app.get(SyncService, { strict: false });
    const [otherDevice] = await sync.processCommands(
      { businessId: w.owner.businessId, membershipId: w.attendant.membershipId, deviceId: randomUUID(), permissions: PRESET_PERMISSIONS.ATTENDANT },
      [convert(w, 1, { approval_id: id })],
    );
    // Another business's approval, and one that does not exist.
    const bApproval = await approval(b.attendant, b.manager);
    const foreign = await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: bApproval }));
    const missing = await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: randomUUID() }));

    expect(otherMember).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });
    expect(otherDevice).toMatchObject({ status: 'REJECTED', code: 'APPROVAL_INVALID' });
    expect(foreign).toEqual({ ...missing, command_id: foreign.command_id });
    expect(missing).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });
    expect(otherDevice.message).toBe(missing.message);
    // None of them used the approvals; both still work for their own member.
    expect((await approvalRow(id)).consumed_at).toBeNull();
    expect((await approvalRow(bApproval)).consumed_at).toBeNull();
    expect((await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: id }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(b.attendant.token, convert(b, 1, { approval_id: bApproval }))).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 6. time and state
  it('6. phone time over 15 minutes after minting, receipt over 24 hours later, and an approver suspended or demoted after minting: APPROVAL_INVALID', async () => {
    const w = await api.world();
    await stockUp(w, 20);

    // The approver is suspended after minting.
    const second = await api.activeStaff(w.owner, 'MANAGER', 'Dalmas');
    const bySuspended = await approval(w.attendant, second);
    expect((await api.post(`/v1/staff/${second.membershipId}/suspend`, undefined, w.owner.token)).statusCode).toBe(204);
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: bySuspended }))).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });

    // The approver loses stock.convert (demoted to attendant) after minting.
    const third = await api.activeStaff(w.owner, 'MANAGER', 'Faith');
    const byDemoted = await approval(w.attendant, third);
    expect((await api.call('PATCH', `/v1/staff/${third.membershipId}`, w.owner.token, { role_preset: 'ATTENDANT' })).statusCode).toBe(204);
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: byDemoted }))).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });
    // Refused by the live re-check, which rolls back with the command: not consumed.
    expect((await approvalRow(byDemoted)).consumed_at).toBeNull();

    // Time limits. The phone's clock says 16 minutes after minting: too late.
    const late = await approval(w.attendant, w.manager);
    const mintedAt = t.clock.now().getTime();
    const at = (minutes: number) => new Date(mintedAt + minutes * 60_000).toISOString();
    t.clock.advanceMinutes(20);
    await relogin(w.attendant); // same device, so the approval still applies to it
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: late }, at(16)))).toMatchObject({ status: 'REJECTED', reason: 'APPROVAL_INVALID' });
    // Within the window by the phone's clock, even though it arrives later: fine.
    expect((await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: late }, at(14)))).status).toBe('ACCEPTED');

    // Received more than 24 hours after minting, although the phone time is inside the window.
    const stale = await approval(w.attendant, w.manager);
    const staleMintedAt = t.clock.now().getTime();
    t.clock.advanceMinutes(25 * 60);
    await relogin(w.attendant);
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: stale }, new Date(staleMintedAt + 60_000).toISOString()))).toMatchObject({
      status: 'REJECTED',
      reason: 'APPROVAL_INVALID',
    });
    expect((await approvalRow(stale)).consumed_at).toBeNull();
    expect(await api.balanceOf(w.owner.businessId, w.loc, w.maize.carton)).toBe(19);
  });

  // ---------------------------------------------------------------- 7. a failed conversion
  it('7. a conversion rejected for STOCK_INSUFFICIENT leaves the approval unused and still valid', async () => {
    const w = await api.world();
    const id = await approval(w.attendant, w.manager);
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: id }))).toMatchObject({ status: 'REJECTED', reason: 'STOCK_INSUFFICIENT' });
    expect((await approvalRow(id)).consumed_at).toBeNull();
    await stockUp(w, 1);
    expect(await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: id }))).toMatchObject({ status: 'ACCEPTED', result: { approved_by_membership_id: w.manager.membershipId } });
    expect((await approvalRow(id)).consumed_at).not.toBeNull();
  });

  // ---------------------------------------------------------------- 8. ignored for managers
  it('8. a member with stock.convert who sends an approval_id: it is ignored and not consumed', async () => {
    const w = await api.world();
    await stockUp(w, 2);
    const id = await approval(w.attendant, w.owner, OWNER_PIN);
    expect(await api.sendOne(w.manager.token, convert(w, 1, { approval_id: id }))).toMatchObject({
      status: 'ACCEPTED',
      result: { approved_by_membership_id: w.manager.membershipId },
    });
    expect((await approvalRow(id)).consumed_at).toBeNull();
    const conversion = await asAdmin(async (c) => (await c.query('SELECT approval_id FROM stock_conversion WHERE business_id = $1', [w.owner.businessId])).rows);
    expect(conversion).toEqual([{ approval_id: null }]);
    // The attendant can still use it.
    expect((await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: id }))).status).toBe('ACCEPTED');
  });

  // ---------------------------------------------------------------- 9. logs, audit, rate limit
  it('9. no PIN or approval id in any log; audit rows for granted, locked and converted; the route limit answers 429', async () => {
    const w = await api.world();
    await stockUp(w, 2);
    const logStart = t.rawLogs().length;
    const id = await approval(w.attendant, w.manager);
    t.clock.advanceMinutes(1);
    await api.sendOne(w.attendant.token, convert(w, 1, { approval_id: id, note: 'approval note' }));
    t.clock.advanceMinutes(1);
    for (let i = 0; i < 5; i++) await mint(w.attendant, w.owner.membershipId, '4321');
    const logs = t.rawLogs().slice(logStart);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [id, `"${STAFF_PIN}"`, '"4321"', 'approver_pin', 'approval note']) expect(logs, secret).not.toContain(secret);

    const audit = await allAudit(w.owner.businessId);
    expect(audit.map((a) => a.action)).toEqual(['approval.granted', 'stock.converted', 'approval.locked']);
    expect(audit[0]).toMatchObject({
      target_id: id,
      actor_membership_id: w.attendant.membershipId,
      metadata: { requester_membership_id: w.attendant.membershipId, approver_membership_id: w.manager.membershipId, purpose: 'STOCK_CONVERT' },
    });
    expect(audit[1]).toMatchObject({ actor_membership_id: w.attendant.membershipId, metadata: { approved_by_membership_id: w.manager.membershipId, approval_id: id } });
    expect(audit[2]).toMatchObject({ target_id: w.owner.membershipId, metadata: { approver_membership_id: w.owner.membershipId } });
    const text = JSON.stringify(audit);
    for (const secret of [STAFF_PIN, '4321', 'approval note', '"pin']) expect(text, secret).not.toContain(secret);

    // The per-IP route limit (the auth limit, 3 here instead of 10).
    const limited = await startTestApp({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const lapi = stockApi(limited, '198.51.100.101', 92_000_000);
      const lw = await lapi.world('Duka L');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (await lapi.post('/v1/stock/approvals', { approver_membership_id: lw.manager.membershipId, approver_pin: '0000', purpose: 'STOCK_CONVERT' }, lw.attendant.token)).statusCode,
        );
      }
      expect(statuses).toEqual([403, 403, 403, 429]);
    } finally {
      await limited.app.close();
    }
  });
});
