# Phase A results

Filled in step by step. The full summary (see `docs/phase-a-design.md` section 21) is written when A5 is finished. Only Ian marks the phase done, in `CLAUDE.md` section 2.

## A1: Roles, rename, non-tenant path (passed, commit bb4fb0b)

**Result:** 32 new tests pass, covering every item in design section 5 ("Tests in A1") and section 19 (A1, 1 to 7). Full suite 112 of 112: twice on the test database, again after `docker compose down -v`, and again against the dev database right after `prisma migrate reset --force` (run with Ian's explicit consent).

**Built (choices approved by Ian on 2026-10-25):**
- Role `identity_owner` (NOLOGIN, not BYPASSRLS), created by the Docker init script and granted to `migrator` `WITH INHERIT FALSE, SET TRUE`. The first A1 migration stops with a clear message if the role or that grant is missing.
- Tables `person`, `membership`, `device`, `device_membership`, `refresh_token` with the columns of design section 4; forced RLS on them and on `business`; `TO identity_owner` policies (including `device_membership`, needed by function 7); column grants; checks for E.164 phones and lowercase emails; one `OWNER` per business.
- 9 identity functions, all `SECURITY DEFINER`, owned by `identity_owner`, `search_path = pg_catalog, public, pg_temp`, one exact key, `STRICT`, time passed in as `p_now`, executable only by `app_user`. Function 9 is `identity_ensure_person` (create-only); the signup writer comes in A2 and will require the consumed codes.
- `IdentityLookup` (`src/database/identity-lookup.ts`): the only caller. Joins an open tenant transaction when there is one.

| Function | Returns |
|---|---|
| `identity_find_person_by_phone(text)` | person_id, phone_verified, email_verified, has_password |
| `identity_find_person_for_login(text)` | person_id, password_hash, failed_login_count, login_locked_until |
| `identity_record_password_attempt(uuid, boolean, timestamptz, integer, interval)` | failed_login_count, login_locked_until |
| `identity_list_active_memberships(uuid)` | membership_id, business_id, business_name, role_preset, status |
| `identity_find_invites_by_phone(text)` | membership_id, business_id, temp_pin_hash, temp_pin_expires_at, temp_pin_failed_count |
| `identity_find_device(uuid)` | device_id, business_id, secret_hash, status, is_shared |
| `identity_list_device_members(uuid, text)` | membership_id, display_name |
| `identity_claim_refresh_token(text, timestamptz)` | refresh_token_id, business_id, membership_id, device_id, family_id, outcome |
| `identity_ensure_person(text, timestamptz)` | person_id, created |

**Proof the tests catch mistakes:**
- Real bug, caught by the privileges test: the functions migration ran `REVOKE ... FROM PUBLIC` and `GRANT ... TO app_user` as `migrator` after handing each function to `identity_owner`. Postgres only warned ("no privileges could be revoked") and changed nothing, so all 9 functions were executable by PUBLIC. Fixed by `*_a1_identity_function_grants_fix` (`SET ROLE identity_owner` first). The applied migration was not edited.
- Design mutation 6: `identity_find_device` granted back to PUBLIC on the test database; the privileges test failed naming that function (`migrator_can: true`, `public_acl: true`); reverted and confirmed.

**Things to know:**
1. Grant and revoke on a function before handing it to another owner (or `SET ROLE` to the owner). A non-owner's `REVOKE`/`GRANT` is a silent no-op apart from a WARNING. Recorded in CLAUDE.md.
2. Under READ COMMITTED a single statement keeps its starting snapshot. A one-statement "claim, else say why not" reported `EXPIRED` instead of `ALREADY_USED` for a concurrent loser, and a one-statement "insert, else select" returned no person at all. `identity_claim_refresh_token` and `identity_ensure_person` therefore use two statements; 20-way concurrency tests prove it.
3. Changing a function's owner needs the new owner to have CREATE on the schema. The migration grants it to `identity_owner` and revokes it at the end; a test checks it is gone.
4. Forced RLS on `business` applies to `migrator` too: creating a business means generating the id, setting it as the tenant, then inserting.
5. Until A2 adds the signup writer, nothing may set a person's email, password or verified flags, so tests seed those as the postgres superuser (`TEST_ADMIN_DATABASE_URL`, tests only).
6. `prisma migrate reset` recreates the schema owned by `migrator`; the schema grants for `app_user` and `identity_owner` come back because they are in migrations.

**Open for later steps:**
- Strict refresh rule (A3): the loser of a concurrent refresh sees `ALREADY_USED`, and the strict rule revokes the whole family, including the winner's new token. Kept as Ian decided; the client falls back to PIN login.
- Further person writes need their own narrow functions: signup (A2, requires consumed codes), password reset (A2/A3), marking the phone verified at staff activation (A4).
- `membership.extra_permissions` is nullable (Prisma lists cannot be required); services treat NULL as an empty list.
