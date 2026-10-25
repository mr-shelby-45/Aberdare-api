import { createHash, randomUUID } from 'node:crypto';
import { IdentityLookup } from '../src/database/identity-lookup.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TenantRunner, currentTx } from '../src/database/tenant.js';
import { asAdmin, asAppUser, asMigrator, createBusiness, resetTables } from './helpers/db.js';
import { prismaWithPool } from './helpers/prisma.js';

// Phase A1: the non-tenant access path and business RLS
// (docs/phase-a-design.md sections 5 and 19). Numbers in test names refer to
// the A1 list in section 19.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const NOW = new Date('2026-10-25T08:00:00.000Z');
const PHONE_OWNER_A = '+254700000001';
const PHONE_INVITEE = '+254700000002';
const PHONE_BOTH = '+254700000003';
const PHONE_OWNER_B = '+254700000004';
const EMAIL_OWNER_A = 'owner-a@example.com';

// The exact columns each function returns, in order. Anything more is a leak.
const COLUMNS: Record<string, string[]> = {
  identity_find_person_by_phone: ['person_id', 'phone_verified', 'email_verified', 'has_password'],
  identity_find_person_for_login: ['person_id', 'password_hash', 'failed_login_count', 'login_locked_until'],
  identity_record_password_attempt: ['failed_login_count', 'login_locked_until'],
  identity_list_active_memberships: ['membership_id', 'business_id', 'business_name', 'role_preset', 'status'],
  identity_find_invites_by_phone: [
    'membership_id',
    'business_id',
    'temp_pin_hash',
    'temp_pin_expires_at',
    'temp_pin_failed_count',
  ],
  identity_find_device: ['device_id', 'business_id', 'secret_hash', 'status', 'is_shared'],
  identity_list_device_members: ['membership_id', 'display_name'],
  identity_claim_refresh_token: [
    'refresh_token_id',
    'business_id',
    'membership_id',
    'device_id',
    'family_id',
    'outcome',
  ],
  identity_ensure_person: ['person_id', 'created'],
  // Added in A2 (tested in test/a2-signup.spec.ts).
  identity_create_otp_challenge: ['challenge_id', 'outcome'],
  identity_verify_otp: ['challenge_id', 'outcome'],
  identity_complete_owner_signup: ['person_id', 'outcome'],
  // Added in A4 (tested in test/a4-staff.spec.ts). Returns one boolean.
  identity_activate_phone: ['identity_activate_phone'],
  // Added in A5 (tested in test/a5-audit.spec.ts). Returns the person id or NULL.
  identity_reset_password: ['identity_reset_password'],
};

interface World {
  bizA: string;
  bizB: string;
  ownerA: { personId: string; membershipId: string };
  invitee: { personId: string; membershipId: string };
  both: { personId: string; inA: string; inB: string };
  ownerB: { personId: string; membershipId: string };
  sharedDeviceA: string;
  personalDeviceA: string;
  deviceB: string;
  refreshA: { token: string; familyId: string };
}

describe('A1: non-tenant access path and business RLS', () => {
  let prisma: PrismaService;
  let tenants: TenantRunner;
  let identity: IdentityLookup;
  let w: World;

  beforeAll(async () => {
    prisma = prismaWithPool(10);
    await prisma.$connect();
    tenants = new TenantRunner(prisma);
    identity = new IdentityLookup(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTables();
    w = await seedWorld();
  });

  /** Two businesses with owners, an invitee, a person in both, devices and a refresh token. */
  async function seedWorld(): Promise<World> {
    const bizA = await createBusiness('Duka A');
    const bizB = await createBusiness('Duka B');

    // Persons are created the real way, through the identity function.
    const pOwnerA = (await identity.ensurePerson(PHONE_OWNER_A, NOW)).personId;
    const pInvitee = (await identity.ensurePerson(PHONE_INVITEE, NOW)).personId;
    const pBoth = (await identity.ensurePerson(PHONE_BOTH, NOW)).personId;
    const pOwnerB = (await identity.ensurePerson(PHONE_OWNER_B, NOW)).personId;
    // No A1 function may set email, password or verified flags (that writer
    // comes in A2), so the superuser seeds them here.
    await asAdmin((c) =>
      c.query(
        `UPDATE person SET email = $2, password_hash = $3, phone_verified_at = $4, email_verified_at = $4
         WHERE id = $1`,
        [pOwnerA, EMAIL_OWNER_A, 'scrypt$test$owner-a', NOW],
      ),
    );

    const a = await tenants.run(bizA, async () => {
      const tx = currentTx();
      const owner = await tx.membership.create({
        data: { businessId: bizA, personId: pOwnerA, displayName: 'Amina', rolePreset: 'OWNER', status: 'ACTIVE', pinHash: 'scrypt$pin' },
      });
      const invite = await tx.membership.create({
        data: {
          businessId: bizA,
          personId: pInvitee,
          displayName: 'Baraka',
          rolePreset: 'ATTENDANT',
          status: 'INVITED',
          tempPinHash: 'hmac$temp',
          tempPinExpiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
          createdByMembershipId: owner.id,
        },
      });
      const both = await tx.membership.create({
        data: { businessId: bizA, personId: pBoth, displayName: 'Chebet', rolePreset: 'MANAGER', status: 'ACTIVE', createdByMembershipId: owner.id },
      });
      const shared = await tx.device.create({
        data: { businessId: bizA, name: 'Counter tablet', platform: 'android', secretHash: sha('secret-shared-a'), isShared: true, status: 'ACTIVE', registeredByMembershipId: owner.id },
      });
      const personal = await tx.device.create({
        data: { businessId: bizA, name: "Amina's phone", platform: 'ios', secretHash: sha('secret-personal-a'), status: 'ACTIVE', registeredByMembershipId: owner.id },
      });
      await tx.deviceMembership.createMany({
        data: [
          { businessId: bizA, deviceId: shared.id, membershipId: owner.id },
          { businessId: bizA, deviceId: shared.id, membershipId: both.id },
          { businessId: bizA, deviceId: shared.id, membershipId: invite.id },
        ],
      });
      const familyId = randomUUID();
      await tx.refreshToken.create({
        data: {
          businessId: bizA,
          membershipId: owner.id,
          deviceId: personal.id,
          familyId,
          tokenHash: sha('refresh-a'),
          expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
        },
      });
      return { owner: owner.id, invite: invite.id, both: both.id, shared: shared.id, personal: personal.id, familyId };
    });

    const b = await tenants.run(bizB, async () => {
      const tx = currentTx();
      const owner = await tx.membership.create({
        data: { businessId: bizB, personId: pOwnerB, displayName: 'Daudi', rolePreset: 'OWNER', status: 'ACTIVE' },
      });
      const both = await tx.membership.create({
        data: { businessId: bizB, personId: pBoth, displayName: 'Chebet', rolePreset: 'ATTENDANT', status: 'ACTIVE', createdByMembershipId: owner.id },
      });
      const device = await tx.device.create({
        data: { businessId: bizB, name: 'B phone', platform: 'android', secretHash: sha('secret-b'), isShared: true, status: 'ACTIVE', registeredByMembershipId: owner.id },
      });
      await tx.deviceMembership.create({ data: { businessId: bizB, deviceId: device.id, membershipId: owner.id } });
      return { owner: owner.id, both: both.id, device: device.id };
    });

    return {
      bizA,
      bizB,
      ownerA: { personId: pOwnerA, membershipId: a.owner },
      invitee: { personId: pInvitee, membershipId: a.invite },
      both: { personId: pBoth, inA: a.both, inB: b.both },
      ownerB: { personId: pOwnerB, membershipId: b.owner },
      sharedDeviceA: a.shared,
      personalDeviceA: a.personal,
      deviceB: b.device,
      refreshA: { token: 'refresh-a', familyId: a.familyId },
    };
  }

  /** Runs SQL as app_user with the given tenant (or none) on one raw connection. */
  async function appUserQuery<T extends object>(
    tenant: string | null,
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; fields: string[] }> {
    return asAppUser(async (c) => {
      await c.query('BEGIN');
      if (tenant) await c.query("SELECT set_config('app.business_id', $1, true)", [tenant]);
      try {
        const res = await c.query<T>(sql, params);
        return { rows: res.rows, fields: res.fields.map((f) => f.name) };
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  describe('1. app_user cannot read identity rows of another business', () => {
    const tenantTables = ['membership', 'device', 'device_membership', 'refresh_token'];

    it('with the tenant set to another business', async () => {
      for (const table of tenantTables) {
        const { rows } = await appUserQuery<{ n: string }>(
          w.bizB,
          `SELECT count(*) AS n FROM ${table} WHERE business_id = $1`,
          [w.bizA],
        );
        expect(rows[0].n, table).toBe('0');
      }
    });

    it('with no tenant set', async () => {
      for (const table of [...tenantTables, 'business']) {
        const { rows } = await appUserQuery<{ n: string }>(null, `SELECT count(*) AS n FROM ${table}`);
        expect(rows[0].n, table).toBe('0');
      }
      const people = await appUserQuery<{ n: string }>(null, 'SELECT count(id) AS n FROM person');
      expect(people.rows[0].n).toBe('0');
    });
  });

  describe('6. person: visible only through a membership of the current business, never writable by app_user', () => {
    const phonesSeenBy = async (tenant: string) =>
      (await appUserQuery<{ phone: string }>(tenant, 'SELECT phone FROM person ORDER BY phone')).rows.map((r) => r.phone);

    it('each business sees exactly its own members', async () => {
      expect(await phonesSeenBy(w.bizA)).toEqual([PHONE_OWNER_A, PHONE_INVITEE, PHONE_BOTH]);
      expect(await phonesSeenBy(w.bizB)).toEqual([PHONE_BOTH, PHONE_OWNER_B]);
    });

    it('the password and lock columns are never readable, even for own members', async () => {
      for (const column of ['password_hash', 'failed_login_count', 'login_locked_until', 'password_changed_at']) {
        await expect(appUserQuery(w.bizA, `SELECT ${column} FROM person`), column).rejects.toThrow(
          /permission denied for table person/,
        );
      }
    });

    it('app_user cannot insert, update or delete a person', async () => {
      for (const sql of [
        "INSERT INTO person (phone) VALUES ('+254799999999')",
        "UPDATE person SET phone = '+254799999999'",
        'DELETE FROM person',
      ]) {
        await expect(appUserQuery(w.bizA, sql), sql).rejects.toThrow(/permission denied for table person/);
      }
    });
  });

  describe('2. each function: exact columns for a right key, nothing for a wrong key', () => {
    const call = (fn: string, args: string, params: unknown[]) =>
      appUserQuery<Record<string, unknown>>(null, `SELECT * FROM ${fn}(${args})`, params);

    it('identity_find_person_by_phone', async () => {
      const right = await call('identity_find_person_by_phone', '$1', [PHONE_OWNER_A]);
      expect(right.fields).toEqual(COLUMNS.identity_find_person_by_phone);
      expect(right.rows).toEqual([
        { person_id: w.ownerA.personId, phone_verified: true, email_verified: true, has_password: true },
      ]);
      const invitee = await call('identity_find_person_by_phone', '$1', [PHONE_INVITEE]);
      expect(invitee.rows).toEqual([
        { person_id: w.invitee.personId, phone_verified: false, email_verified: false, has_password: false },
      ]);
      expect((await call('identity_find_person_by_phone', '$1', ['+254711111111'])).rows).toEqual([]);
    });

    it('identity_find_person_for_login', async () => {
      const right = await call('identity_find_person_for_login', '$1', ['Owner-A@Example.com']);
      expect(right.fields).toEqual(COLUMNS.identity_find_person_for_login);
      expect(right.rows).toEqual([
        { person_id: w.ownerA.personId, password_hash: 'scrypt$test$owner-a', failed_login_count: 0, login_locked_until: null },
      ]);
      expect((await call('identity_find_person_for_login', '$1', ['nobody@example.com'])).rows).toEqual([]);
    });

    it('identity_record_password_attempt', async () => {
      const right = await call(
        'identity_record_password_attempt',
        "$1::uuid, false, $2::timestamptz, 5, interval '15 minutes'",
        [w.ownerA.personId, NOW],
      );
      expect(right.fields).toEqual(COLUMNS.identity_record_password_attempt);
      expect(right.rows).toEqual([{ failed_login_count: 1, login_locked_until: null }]);
      const wrong = await call(
        'identity_record_password_attempt',
        "$1::uuid, false, $2::timestamptz, 5, interval '15 minutes'",
        [randomUUID(), NOW],
      );
      expect(wrong.rows).toEqual([]);
    });

    it('identity_list_active_memberships', async () => {
      const right = await call('identity_list_active_memberships', '$1::uuid', [w.both.personId]);
      expect(right.fields).toEqual(COLUMNS.identity_list_active_memberships);
      expect(right.rows).toEqual([
        { membership_id: w.both.inA, business_id: w.bizA, business_name: 'Duka A', role_preset: 'MANAGER', status: 'ACTIVE' },
        { membership_id: w.both.inB, business_id: w.bizB, business_name: 'Duka B', role_preset: 'ATTENDANT', status: 'ACTIVE' },
      ]);
      // The invitee's membership is INVITED, not ACTIVE.
      expect((await call('identity_list_active_memberships', '$1::uuid', [w.invitee.personId])).rows).toEqual([]);
      expect((await call('identity_list_active_memberships', '$1::uuid', [randomUUID()])).rows).toEqual([]);
    });

    it('identity_find_invites_by_phone', async () => {
      const right = await call('identity_find_invites_by_phone', '$1', [PHONE_INVITEE]);
      expect(right.fields).toEqual(COLUMNS.identity_find_invites_by_phone);
      expect(right.rows).toEqual([
        {
          membership_id: w.invitee.membershipId,
          business_id: w.bizA,
          temp_pin_hash: 'hmac$temp',
          temp_pin_expires_at: new Date(NOW.getTime() + 3 * 86_400_000),
          temp_pin_failed_count: 0,
        },
      ]);
      // Active people are not invites.
      expect((await call('identity_find_invites_by_phone', '$1', [PHONE_OWNER_A])).rows).toEqual([]);
    });

    it('identity_find_device', async () => {
      const right = await call('identity_find_device', '$1::uuid', [w.sharedDeviceA]);
      expect(right.fields).toEqual(COLUMNS.identity_find_device);
      expect(right.rows).toEqual([
        { device_id: w.sharedDeviceA, business_id: w.bizA, secret_hash: sha('secret-shared-a'), status: 'ACTIVE', is_shared: true },
      ]);
      expect((await call('identity_find_device', '$1::uuid', [randomUUID()])).rows).toEqual([]);
    });

    it('identity_list_device_members', async () => {
      const right = await call('identity_list_device_members', '$1::uuid, $2', [w.sharedDeviceA, sha('secret-shared-a')]);
      expect(right.fields).toEqual(COLUMNS.identity_list_device_members);
      // ACTIVE memberships only: the invitee is linked but not listed.
      expect(right.rows).toEqual([
        { membership_id: w.ownerA.membershipId, display_name: 'Amina' },
        { membership_id: w.both.inA, display_name: 'Chebet' },
      ]);
      expect((await call('identity_list_device_members', '$1::uuid, $2', [w.sharedDeviceA, sha('wrong')])).rows).toEqual([]);
      // Right secret, but the device is not shared.
      expect(
        (await call('identity_list_device_members', '$1::uuid, $2', [w.personalDeviceA, sha('secret-personal-a')])).rows,
      ).toEqual([]);
    });

    it('identity_claim_refresh_token', async () => {
      const right = await call('identity_claim_refresh_token', '$1, $2::timestamptz', [sha('refresh-a'), NOW]);
      expect(right.fields).toEqual(COLUMNS.identity_claim_refresh_token);
      expect(right.rows).toEqual([
        {
          refresh_token_id: expect.any(String),
          business_id: w.bizA,
          membership_id: w.ownerA.membershipId,
          device_id: w.personalDeviceA,
          family_id: w.refreshA.familyId,
          outcome: 'CLAIMED',
        },
      ]);
      // Rolled back above, so it can be claimed again here through the wrapper.
      expect((await identity.claimRefreshToken(sha('refresh-a'), NOW))?.outcome).toBe('CLAIMED');
      expect((await identity.claimRefreshToken(sha('refresh-a'), NOW))?.outcome).toBe('ALREADY_USED');
      expect(await identity.claimRefreshToken(sha('unknown'), NOW)).toBeNull();
    });

    it('identity_ensure_person', async () => {
      const right = await call('identity_ensure_person', '$1, $2::timestamptz', [PHONE_OWNER_A, NOW]);
      expect(right.fields).toEqual(COLUMNS.identity_ensure_person);
      expect(right.rows).toEqual([{ person_id: w.ownerA.personId, created: false }]);
    });

    it('every identity function is covered by the column list above', async () => {
      const names = await asMigrator(async (c) =>
        (
          await c.query<{ proname: string }>(
            `SELECT proname FROM pg_proc WHERE proname LIKE 'identity\\_%' ORDER BY 1`,
          )
        ).rows.map((r) => r.proname),
      );
      expect(names).toEqual(Object.keys(COLUMNS).sort());
    });
  });

  describe('3. odd inputs return nothing and never leak', () => {
    const textInputs: (string | null)[] = [
      '',
      null,
      'x'.repeat(10_000),
      "' OR '1'='1",
      `${PHONE_OWNER_A}' OR 1=1 --`,
      '%',
      '+2547%',
      `${PHONE_OWNER_A} `,
    ];

    it('text keys: phone and email lookups', async () => {
      for (const input of textInputs) {
        for (const fn of ['identity_find_person_by_phone', 'identity_find_person_for_login', 'identity_find_invites_by_phone']) {
          const { rows } = await appUserQuery(null, `SELECT * FROM ${fn}($1)`, [input]);
          expect(rows, `${fn}(${String(input).slice(0, 30)})`).toEqual([]);
        }
        const tokens = await appUserQuery(null, 'SELECT * FROM identity_claim_refresh_token($1, $2::timestamptz)', [input, NOW]);
        expect(tokens.rows).toEqual([]);
      }
    });

    it('a NULL in any argument returns nothing', async () => {
      for (const sql of [
        'SELECT * FROM identity_list_active_memberships(NULL)',
        'SELECT * FROM identity_find_device(NULL)',
        `SELECT * FROM identity_list_device_members('${w.sharedDeviceA}'::uuid, NULL)`,
        `SELECT * FROM identity_record_password_attempt('${w.ownerA.personId}'::uuid, NULL, now(), 5, interval '1 minute')`,
        `SELECT * FROM identity_claim_refresh_token('${sha('refresh-a')}', NULL)`,
        'SELECT * FROM identity_ensure_person(NULL, now())',
      ]) {
        expect((await appUserQuery(null, sql)).rows, sql).toEqual([]);
      }
    });

    it('IdentityLookup refuses ids that are not UUIDs before touching the database', async () => {
      for (const bad of ['not-a-uuid', '', "' OR 1=1 --", `${w.sharedDeviceA}x`]) {
        expect(await identity.findDevice(bad)).toBeNull();
        expect(await identity.listDeviceMembers(bad, sha('secret-shared-a'))).toEqual([]);
        expect(await identity.listActiveMemberships(bad)).toEqual([]);
        expect(await identity.recordPasswordAttempt(bad, false, { now: NOW, lockAfter: 5, lockForMinutes: 15 })).toBeNull();
      }
    });

    it('ensure_person rejects a phone that is not E.164 (the table check), creating nothing', async () => {
      for (const bad of ['0712345678', '+0712345678', '+2547', 'abc']) {
        await expect(identity.ensurePerson(bad, NOW), bad).rejects.toThrow(/person_phone_e164/);
      }
      expect((await appUserQuery<{ n: string }>(w.bizA, 'SELECT count(id) AS n FROM person')).rows[0].n).toBe('3');
    });
  });

  describe('4. privileges: app_user cannot become or change identity_owner', () => {
    it('app_user cannot SET ROLE identity_owner', async () => {
      await expect(appUserQuery(null, 'SET ROLE identity_owner')).rejects.toThrow(
        /permission denied to set role "identity_owner"/,
      );
    });

    it('app_user cannot create, replace or alter functions', async () => {
      await expect(
        appUserQuery(null, 'CREATE FUNCTION sneaky() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'),
      ).rejects.toThrow(/permission denied for schema public/);
      await expect(
        appUserQuery(
          null,
          `CREATE OR REPLACE FUNCTION identity_find_device(p_device_id uuid)
           RETURNS TABLE (device_id uuid, business_id uuid, secret_hash text, status text, is_shared boolean)
           LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::boolean $$`,
        ),
      ).rejects.toThrow(/must be owner of function identity_find_device|permission denied/);
      await expect(
        appUserQuery(null, 'ALTER FUNCTION identity_find_device(uuid) SECURITY INVOKER'),
      ).rejects.toThrow(/must be owner of function identity_find_device/);
    });

    it('every identity function: owned by identity_owner, SECURITY DEFINER, pinned search_path, executable only by app_user', async () => {
      const fns = await asMigrator(async (c) =>
        (
          await c.query<{
            proname: string;
            owner: string;
            secdef: boolean;
            config: string[] | null;
            app_user_can: boolean;
            migrator_can: boolean;
            public_acl: boolean;
          }>(`
            SELECT p.proname,
                   pg_get_userbyid(p.proowner) AS owner,
                   p.prosecdef AS secdef,
                   p.proconfig AS config,
                   has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_can,
                   has_function_privilege('migrator', p.oid, 'EXECUTE') AS migrator_can,
                   EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_acl
            FROM pg_proc p
            WHERE p.proname LIKE 'identity\\_%'
            ORDER BY 1`)
        ).rows,
      );
      expect(fns).toHaveLength(Object.keys(COLUMNS).length);
      for (const f of fns) {
        expect(f, f.proname).toEqual({
          proname: f.proname,
          owner: 'identity_owner',
          secdef: true,
          config: ['search_path=pg_catalog, public, pg_temp'],
          app_user_can: true,
          // migrator has no grant of its own, so this is false only because
          // EXECUTE was revoked from PUBLIC.
          migrator_can: false,
          public_acl: false,
        });
      }
    });

    it('identity_owner kept no CREATE on the schema, and cannot log in', async () => {
      const r = await asMigrator(async (c) =>
        (
          await c.query(
            `SELECT has_schema_privilege('identity_owner', 'public', 'CREATE') AS can_create,
                    (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'identity_owner') AS can_login,
                    (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'identity_owner') AS bypass_rls`,
          )
        ).rows[0],
      );
      expect(r).toEqual({ can_create: false, can_login: false, bypass_rls: false });
    });
  });

  describe('5. business RLS', () => {
    it('each business sees and updates only itself', async () => {
      const seenByA = await appUserQuery<{ id: string }>(w.bizA, 'SELECT id FROM business');
      expect(seenByA.rows).toEqual([{ id: w.bizA }]);
      const renamed = await asMigrator(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.business_id', $1, true)", [w.bizA]);
        const res = await c.query("UPDATE business SET name = 'hacked' WHERE id = $1", [w.bizB]);
        await c.query('COMMIT');
        return res.rowCount;
      });
      expect(renamed).toBe(0);
    });

    it('an insert works only when the new id equals the tenant', async () => {
      const insertAs = (tenant: string, id: string) =>
        asMigrator(async (c) => {
          await c.query('BEGIN');
          try {
            await c.query("SELECT set_config('app.business_id', $1, true)", [tenant]);
            await c.query("INSERT INTO business (id, name, type) VALUES ($1, 'New', 'RETAIL')", [id]);
            await c.query('COMMIT');
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          }
        });
      const id = randomUUID();
      await expect(insertAs(id, id)).resolves.toBeUndefined();
      await expect(insertAs(w.bizA, randomUUID())).rejects.toThrow(/row-level security policy for table "business"/);
    });

    it('app_user (since A2 signup) may insert only its own tenant id, and only id, name and type', async () => {
      const id = randomUUID();
      const ok = await appUserQuery(id, "INSERT INTO business (id, name, type) VALUES ($1, 'New', 'RETAIL')", [id]);
      expect(ok.rows).toEqual([]);
      await expect(
        appUserQuery(w.bizA, "INSERT INTO business (id, name, type) VALUES ($1, 'New', 'RETAIL')", [randomUUID()]),
      ).rejects.toThrow(/row-level security policy for table "business"/);
      await expect(
        appUserQuery(id, "INSERT INTO business (id, name, type, created_at) VALUES ($1, 'New', 'RETAIL', now())", [id]),
      ).rejects.toThrow(/permission denied for table business/);
      await expect(
        appUserQuery(w.bizA, "UPDATE business SET name = 'renamed'"),
      ).rejects.toThrow(/permission denied for table business/);
    });
  });

  describe('data rules', () => {
    it('a business has at most one OWNER', async () => {
      const someone = (await identity.ensurePerson('+254700000099', NOW)).personId;
      await expect(
        tenants.run(w.bizA, () =>
          currentTx().membership.create({
            data: { businessId: w.bizA, personId: someone, displayName: 'Second owner', rolePreset: 'OWNER', status: 'ACTIVE' },
          }),
        ),
      ).rejects.toThrow(/Unique constraint|membership_one_owner_per_business/);
    });

    it('IdentityLookup inside a tenant transaction is part of it (rolls back with it)', async () => {
      await expect(
        tenants.run(w.bizA, async () => {
          await identity.ensurePerson('+254700000088', NOW);
          throw new Error('staff creation failed');
        }),
      ).rejects.toThrow('staff creation failed');
      expect(await identity.findPersonByPhone('+254700000088')).toBeNull();
    });
  });

  describe('concurrency (the two-statement functions)', () => {
    it('20 concurrent ensurePerson calls for a new phone: one creates, all get the same id', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => identity.ensurePerson('+254700000077', NOW)),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.personId)).size).toBe(1);
    });

    it('20 concurrent claims of one refresh token: exactly one CLAIMED, the rest ALREADY_USED', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => identity.claimRefreshToken(sha('refresh-a'), NOW)),
      );
      const outcomes = results.map((r) => r?.outcome);
      expect(outcomes.filter((o) => o === 'CLAIMED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'ALREADY_USED')).toHaveLength(19);
    });

    it('20 concurrent wrong passwords count exactly 20, and lock from the 5th', async () => {
      const limits = { now: NOW, lockAfter: 5, lockForMinutes: 15 };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => identity.recordPasswordAttempt(w.ownerA.personId, false, limits)),
      );
      const counts = results.map((r) => r!.failedLoginCount).sort((a, b) => a - b);
      expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const lockUntil = new Date(NOW.getTime() + 15 * 60_000);
      for (const r of results) {
        expect(r!.loginLockedUntil, String(r!.failedLoginCount)).toEqual(r!.failedLoginCount >= 5 ? lockUntil : null);
      }
      const reset = await identity.recordPasswordAttempt(w.ownerA.personId, true, limits);
      expect(reset).toEqual({ failedLoginCount: 0, loginLockedUntil: null });
    });
  });

  describe('refresh token outcomes', () => {
    const setTokenState = (sql: string) =>
      tenants.run(w.bizA, () => currentTx().$executeRawUnsafe(sql, sha('refresh-a')));

    it('expired, revoked and unknown tokens are reported as such', async () => {
      const later = new Date(NOW.getTime() + 31 * 86_400_000);
      expect((await identity.claimRefreshToken(sha('refresh-a'), later))?.outcome).toBe('EXPIRED');
      await setTokenState('UPDATE refresh_token SET revoked_at = now() WHERE token_hash = $1');
      expect((await identity.claimRefreshToken(sha('refresh-a'), NOW))?.outcome).toBe('REVOKED');
      expect(await identity.claimRefreshToken(sha('never-issued'), NOW)).toBeNull();
    });
  });
});
