# Phase A results

**Status: all five steps (A1 to A5) passed. Waiting for Ian's review.** Only Ian marks Phase A done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-a-walkthrough.md`.

**Final suite:** 12 test files, **208 of 208 tests passed in ten consecutive full runs** (about 218 s each), with lint, type-check, build and the drift check clean, on the commit that adds this summary. An earlier series of ten failed one test each time (the RLS coverage list, see A5) and was repeated from the start after the fix.

## Summary

| Step | Question | Answer | New tests | Workaround needed? |
|---|---|---|---|---|
| A1 | Can login find people, devices and tokens before any business is known, without opening RLS? | **Yes**, through narrow `SECURITY DEFINER` functions owned by a NOLOGIN role | 32 | Grants must be set before the ownership hand-over (a real bug, fixed by a follow-up migration) |
| A2 | Can an owner sign up with both codes proven, without revealing existing accounts? | **Yes** | 24 | `main.ts` loads `.env`; scrypt takes ~430 ms (accepted) |
| A3 | Do login, refresh rotation and the per-request pipeline hold up, including races? | **Yes** | 31 | Lockout redesigned before coding (was an oracle); "locked for good" is a count, not `'infinity'` |
| A4 | Do staff invites, activation, shared tablets and device admin keep access tight? | **Yes** | 24 | A `team` module above the data modules (avoids a circular import) |
| A5 | Is every sensitive change audited, append-only, and are secrets and accounts never revealed? | **Yes** | 17 | Request context inside `TenantInterceptor` |

Phase A added 128 tests to the spike's 80: **208 in all**.

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Lookups before a business is known | `IdentityLookup` is the only caller of 14 `identity_*` functions: owned by `identity_owner` (NOLOGIN), `SECURITY DEFINER`, `search_path = pg_catalog, public, pg_temp`, STRICT, one exact key, time passed in, executable only by `app_user`. Grant and revoke before `ALTER ... OWNER TO`. Joins the open tenant transaction when there is one | `src/database/identity-lookup.ts`, `*_a1_*`, `*_a2_*`, `*_a4_*`, `*_a5_identity_reset_password` |
| Request pipeline | Every route protected unless `@Public()`. `AuthGuard` checks the access token only. `TenantInterceptor` opens the request context, runs the request in one tenant transaction, loads the live membership and device, enforces `@RequirePermission`, and runs the handler in the same transaction. Never check status or permissions in a guard | `src/modules/auth/auth.guard.ts`, `tenant.interceptor.ts` |
| Tokens | JWT HS256, one `aud` per kind (`access` 15 min, `signup` 10 min, `selection` 5 min, `setup` 10 min), `algorithms` and audience pinned on verify, `iat`/`exp` from the Clock. Refresh tokens: random, stored as SHA-256, rotated by one atomic claim; reuse revokes the family. Device secrets: 32 random bytes, SHA-256, shown once | `src/modules/auth/*token*.service.ts` |
| Hashing | scrypt N=2^15, r=8, p=3, HMAC pepper first, `scrypt$N$r$p$salt$hash`, **about 430 ms per hash** on the dev machine, always outside a transaction. Codes and temp PINs: HMAC-SHA256 over `channel|target|purpose|code` (temp PINs bound to the membership id) | `src/common/auth/password-hasher.ts`, `code-hasher.ts` |
| Locks | Never answer differently for a right and a wrong guess. Password lock: always `INVALID_CREDENTIALS` with a dummy hash. PIN lock: `ACCOUNT_LOCKED` without checking the PIN. Counters are single atomic statements | `login.service.ts`, `pin-login.service.ts` |
| Not revealing accounts | Same status, body and number of scrypt calls for known and unknown phones and emails on every public route; "expired" and "rate limited" fold into the same answer where they could leak | A2, A3, A4, A5 tests |
| Time | Injected `Clock` everywhere (lockouts, expiries, send limits, JWT times); `FakeClock` in tests | `src/common/time/clock.ts`, `test/helpers/clock.ts` |
| Audit | `AuditService.record()` in the tenant transaction; `audit_log` SELECT and INSERT only, forced RLS; no secret-like metadata keys | `src/modules/audit/` |
| Module layout | `staff`, `devices`, `sessions`, `business` are data modules; `auth` and `team` orchestrate above them; `audit` sits below all | `src/modules/` |

## Proof the tests catch mistakes

Each was applied temporarily, the named test failed, and the change was reverted and confirmed gone.

| Design mutation | Test that failed |
|---|---|
| 1. Skip the membership status check in the interceptor | A3 test 4 (suspended and removed staff got 200) |
| 2. Read-then-write refresh rotation | A3 test 7 (11 of 20 concurrent refreshes succeeded with one token) |
| 3. No single-use check on a code | A2 test 2 (a used code verified again) |
| 4. A different error for an unknown email | A3 tests 1 and 2 (login); A5 test 4 (password forgot) |
| 5. Stop redacting the device secret in logs | A5 test 3 |
| 6. `identity_find_device` executable by PUBLIC | A1 grants test |
| 7. Permission check in a Nest guard | A3 test 6 (even the owner was refused) |

Extra mutation in A4: removing "only the owner grants owner-only permissions" failed the self-promotion test. Real bugs the tests caught on the way: functions left PUBLIC-executable (A1), `ACCOUNT_EXISTS` misreported (A2), the permanent PIN lock never applying (A3).

## Versions

Unchanged from `docs/spike-results.md`, plus `@nestjs/jwt` 12.0.3 (approved for Phase A). Hashing uses Node's built-in `crypto`; no other library was added.

## Things to know

1. **Grant before you hand over a function.** A non-owner's `REVOKE`/`GRANT` only warns and changes nothing, and Prisma reports success. (A1)
2. **One statement keeps one snapshot under READ COMMITTED.** "Claim, else explain why not" needs two statements, or a concurrent loser is misreported. (A1)
3. **`'infinity'` timestamps read as `Invalid Date` in Prisma 7** and compare false with everything. Use a count or a flag for "forever". (A3)
4. **Any test run applies pending migrations to `aberdare_test`.** When a migration is waiting for review, run no tests. (A4)
5. **Locks and "expired" answers can be oracles.** Design every refusal on a public route as if the attacker controls the timing. (A3, A5)
6. **Hash before the transaction.** scrypt at ~430 ms inside a transaction would hold a connection and approach Prisma's 5-second limit under load. (A2)
7. **Queries on one transaction run one after another.** No `Promise.all` on the request's transaction. (A4)
8. **The request's one transaction includes the audit row,** so an action and its record can never disagree. (A5)
9. **Tests here are slow:** a warm full run takes about 4 minutes on this machine, and the first after a restart can take 10 (about 5 minutes of module import). Run long suites in the background. (A5)
10. **A new tenant table must also be added to the RLS coverage test's list** (`test/step4-migrations.spec.ts`). That list is a deliberate inventory, so updating it is expected, never a weakening. (A5)

## Open risks

Roughly in order of how soon they matter. Spike risks still open are in `docs/spike-results.md`; Phase A resolved spike risks 2 (role and table names: the table is now `person`) and 3 (non-tenant access paths).

1. **Codes are sent inside the request, right after the commit.** With the fake senders this costs nothing; with real SMS and email (Phase F) a slow provider makes requests slow, and known and unknown accounts take visibly different times on `signup/start` and `password/forgot`. Phase F moves sending to the worker.
2. **scrypt throughput.** Four hashes at a time (libuv thread pool), ~430 ms each: a burst of logins queues. Measure on the real host before launch (Phase H).
3. **Rate limits are in process memory** (spike risk 5): several API instances each count separately.
4. **Password reset is not one transaction across businesses.** The password changes first; tokens are then revoked one business at a time. A failure in between leaves some old refresh tokens valid until they expire (at most their lifetime) or the owner resets again.
5. **How long to keep audit IP addresses**, and the data protection position on storing them (design section 18, item 5). Undecided.
6. **Small work differences on two public routes:** a wrong temp PIN updates counters only for phones with an invite (A4), and `forgot` stores a code only for real accounts. The answers are identical; the timing difference is a few small queries.
7. **Selection tokens can be replayed within their 5 minutes** (needs the password first). Accepted in A3.
8. **The strict refresh rule** ends both sessions when two refreshes race with one token; the client falls back to PIN login. Accepted in A1.
9. **Audit metadata checks key names, not values.** A caller could still put a secret under an innocent key; review new audit calls.
10. **No audit read endpoint and no change-password endpoint yet** (Phase G and later).
11. **Hosted databases need `identity_owner` created by hand**, with `GRANT identity_owner TO migrator WITH INHERIT FALSE, SET TRUE`; the first A1 migration stops with a clear message otherwise.
12. **`AUTH_DEV_FIXED_CODES`** is refused in production, but a staging server must keep it off too.

## Changes to `docs/architecture.md` and `CLAUDE.md`

- `architecture.md`: section 3 (identity path, `business` RLS, composite keys), section 4 (authentication as built: lockouts in A3, password reset in A5), section 11 (audit log as built), sections 12 to 16 (identity tables, endpoints, permissions, environment variables, open items).
- `CLAUDE.md`: section 2 points to the Phase A design; section 3 approves `@nestjs/jwt` and Node `crypto` hashing; rule 13 names scrypt; section 8 notes on the identity path, grant-before-hand-over, Clock, hashing, the request pipeline, locks, `'infinity'`, test runs applying migrations, the module layout, the audit log, shadow-only replays and slow test runs.

# Step details

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

## A2: Codes and signup (passed)

**Result:** 24 new tests pass, covering design section 19 A2 tests 1 to 9 plus an end-to-end signup and the password rule. Full suite 136 of 136, twice. The built app starts and answers `POST /v1/auth/signup/start` with `202 {"status":"CODES_SENT"}`.

**Built (choices approved by Ian on 2026-10-25):**
- `otp_challenge` (no RLS, no app_user privileges; normalised-target check), `business.type`, and `app_user` INSERT on `business (id, name, type)`.
- Identity functions `identity_create_otp_challenge` (send limits per target across purposes, under a per-target advisory lock), `identity_verify_otp` (one atomic statement; compares the two pepper-keyed HMACs inside the database) and `identity_complete_owner_signup` (requires both verified, unconsumed, recent codes for exactly this phone and email; checks for an existing account before writing; consumes the codes; creates or completes the person). Grants written before the ownership hand-over, as learned in A1.
- `Clock`, `PasswordHasher` (scrypt N=2^15, r=8, p=3, pepper first; **about 430 ms per hash on the dev machine**, above the design's 50 to 150 ms target, accepted by Ian as OWASP's minimum), `CodeHasher`, random codes and secrets, Kenyan phone normalisation, fake SMS and email senders.
- `SignupService` with `ChallengeService`, `PurposeTokenService` (signup token, `aud: signup`), `TokenService` (access token, `aud: access`, 15 minutes, ids only; refresh token stored as SHA-256), and the business, staff and devices services. `@nestjs/jwt` 12.0.3 installed.
- Routes `POST /v1/auth/signup/start`, `/signup/verify`, `/signup`, each with a per-IP limit (`AUTH_RATE_LIMIT_MAX`, default 10 per minute).

**Proof the tests catch mistakes:**
- Design mutation 3: `identity_verify_otp` replaced on the test database by a copy without the `consumed_at IS NULL` check. "A code cannot be used again after signup" failed (`expected 200 to be 400`: an already-used code verified again). The saved original was restored and confirmed identical.
- Real bug, caught by test 7: the service checked "no person id means invalid token" before "account exists", and the signup writer returns `ACCOUNT_EXISTS` without a person id. An existing owner signing up again was told "please start again" (401) instead of `ACCOUNT_EXISTS` (409). Fixed by checking `ACCOUNT_EXISTS` first.
- Two failures were bugs in the tests themselves, fixed in the tests: a code looked up under the raw phone instead of the normalised one, and a forged token dated by the real clock while the app runs on the test clock.

**Things to know:**
1. With `TRUNCATE`-free migrations, adding a required column to a table with rows fails; local test rows were cleared first (Ian approved). Production had none.
2. Replacing a function needs CREATE on the schema; `identity_owner` does not keep it, so mutations and fixes grant it temporarily and revoke it in the same step.
3. `main.ts` now loads `.env`; without it the built app refused to start once the secrets became required (found by starting the real app; the tests pass their own settings).
4. Codes are hashed together with their channel, target and purpose, so a code for one phone or purpose is useless for another.
5. If one of the two signup codes hits a send limit, the other may still be sent; the response is `OTP_RATE_LIMITED` either way.

**Open for later steps:**
- Signup is not in the audit log yet (A5).
- Password reset and staff activation need their own narrow person-writing functions (A3/A4).
- The libuv thread pool runs four scrypt hashes at a time; a burst of logins queues. Measure under load before launch (Phase H).

## A3: Login, tokens and the request pipeline (passed)

**Result:** 31 new tests pass, covering design section 19 A3 tests 1 to 9. Full suite 167 of 167, twice. The built app answers `GET /v1/me` without a token with `401 TOKEN_INVALID` in the standard shape. No migrations were needed.

**Built (approved by Ian on 2026-10-25):**
- `AuthGuard` (global, token only) and `TenantInterceptor` (global: one tenant transaction per protected request, live membership and device checks, `@RequirePermission`, handler in the same transaction). `@Public()`, `@RequirePermission()`, `common/auth/permissions.ts` (presets; `stock.convert` never effective for an attendant).
- `POST /v1/auth/login` (email and password, with `requires_selection` and a 5-minute selection token), `POST /v1/auth/pin`, `POST /v1/auth/refresh` (rotation; reuse revokes the family), `POST /v1/auth/logout`, `GET /v1/me`. scrypt always outside a transaction; counters are single atomic statements.

**Decisions changed during the build (with Ian):**
- My first lockout recommendation (only the correct password reveals the lock) was a guessing oracle; caught before coding. Ian chose: during a password lockout every answer is `INVALID_CREDENTIALS` (same as an unknown email). PIN locks answer `ACCOUNT_LOCKED` without checking the PIN.

**Proof the tests catch mistakes** (each applied temporarily, then reverted and confirmed gone):
- Mutation 1, no membership status check in the interceptor: test 4 failed (suspended and removed staff got `200`).
- Mutation 2, read-then-write refresh claim: test 7 failed (two racing refreshes both succeeded; 11 of 20 concurrent refreshes succeeded with one token).
- Mutation 4, a different error for an unknown email: tests 1 and 2 failed.
- Mutation 7, the permission check in a guard: test 6 failed (the guard has no session yet, so even the owner was refused).
- Real bug, caught by the 10-failure PIN tests: "locked for good" was stored as `pin_locked_until = 'infinity'`, which Prisma reads as an Invalid Date, so the lock never applied (probe confirmed). Now `pin_failed_count >= 10`.
- One test of mine was too loose ("20 parallel wrong PINs" accepted any count from 5 to 20); tightened before running to the exact invariant: failed count plus lock refusals equals 20.

**Things to know:**
1. Every route is protected unless marked `@Public()`; forgetting the marker fails closed (401), never open.
2. The interceptor subscribes to the handler inside `TenantRunner.run`, so all handler work, including writes, is in the request's one transaction.
3. A session's device must belong to its membership (registered by it, or linked on a shared device); removing someone from a shared device ends their session on the next request.
4. After a timed password lock passes, one more wrong password locks again at once (the counter is reset only by a correct password). Stricter than "5 more tries"; noted, not changed.

**Open for later steps:**
- Selection tokens can be replayed within their 5 minutes (needs the password first). Recorded risk, as decided.
- Audit events for login, PIN lockout and refresh-token reuse come in A5 (`TODO(A5)` in `session.service.ts`).

## A4: Staff and devices (passed)

**Result:** 24 new tests pass, covering design section 19 A4 tests 1 to 9 plus concurrent double activation, self-promotion, wrong guesses across businesses, re-invites and the device endpoints' side effects. Full suite 191 of 191, twice.

**Built (approved by Ian on 2026-10-25):**
- Migration `*_a4_identity_activate_phone`: `identity_activate_phone` consumes a verified `STAFF_ACTIVATE` code for that person's phone and marks the phone verified. Grants before the ownership hand-over; no new column grants. 13 identity functions in all, each executable only by `identity_owner` and `app_user`.
- `POST/GET /v1/staff`, `PATCH /v1/staff/:id`, `reset-pin`, `suspend`, `reactivate`, `DELETE` (status `REMOVED`); `GET/PATCH/DELETE /v1/devices/:id`, device members add and remove; `POST /v1/auth/first-login`, `POST /v1/auth/staff/activate`, `GET /v1/auth/device-members`.
- Rules: nobody changes their own access; only the owner grants owner-only permissions; `OWNER_PROTECTED`; `stock.convert` never on an attendant (on create and on demotion); `MEMBER_EXISTS`, with re-invite of a removed member on the same row; reset and removal revoke the person's tokens, tablet links and the phones they registered; turning shared off ends the linked members' sessions on that device.
- Temp PINs: 6 digits, 3 days, HMAC bound to the membership id; a wrong guess counts against every live invite for the phone; the 5th kills it. Activation claims the invite in one atomic statement.
- Module layout: `staff`, `devices`, `sessions` (refresh tokens, moved out of `auth`) and `business` are data modules; `auth` and the new `team` module orchestrate above them, avoiding a circular import between staff and devices.

**Proof the tests catch mistakes:**
- Mutation: the "only the owner grants owner-only permissions" check removed; the self-promotion test failed (a manager could hand out `devices.manage`); reverted.
- One test expectation of mine was wrong, not the code: a replayed setup token is refused at the SMS code check (`OTP_INVALID`, the code is already consumed), one step before the invite claim I expected (`TOKEN_INVALID`). The test now asserts the real refusal and, stronger than before, that the replay created no second device and left the membership unchanged.

**Process slip, corrected:** running the existing suite as a regression check applied the A4 migration to `aberdare_test` before Ian had reviewed it (the test setup runs `prisma migrate deploy`). The function and its history row were removed again (dev was never touched), the migration was shown, and it was applied only after approval. CLAUDE.md now warns about this.

**Things to know:**
1. Any test run applies pending migrations to the test database.
2. Queries on one transaction must run one after another; `Promise.all` on the request's transaction is avoided.
3. A first login with a wrong PIN writes counters in each business with an invite for that phone; an unknown phone writes nothing. The answers are identical; the work differs slightly (a few small updates). Recorded for A5's timing check.

**Open for later steps:**
- Audit events for staff and device changes, PIN resets and lockouts (A5).

## A5: Audit log and hardening (passed)

**Result:** 17 new tests pass, covering design section 19 A5 tests 1 to 4 plus password reset end to end; test 5 (ten full runs in a row) is under "Final suite" at the top. Migrations were replayed in the shadow database and shown to Ian before being applied.

**Built (approved by Ian on 2026-10-25):**
- Migrations `*_a5_audit_log_table` (generated), `*_a5_audit_log_rls` (format and metadata checks, SELECT and INSERT only for `app_user`, forced RLS, `shop_only` policy) and `*_a5_identity_reset_password` (14th identity function; grants before the hand-over; no new column grants).
- `AuditService` (`src/modules/audit/`): writes in the current tenant transaction; refuses metadata keys that look like secrets or contact details; actor from the request unless given (`null` for system events); IP from the request context that `TenantInterceptor` now opens on every route.
- Audit rows for: `business.signed_up`; `device.registered` (signup, password login and activation, all through `DevicesService.register`), `device.revoked`, `device.shared_changed` (only on a real change), `device.member_added`, `device.member_removed`; `staff.created`, `updated`, `suspended`, `reactivated`, `removed`, `pin_reset`; `pin.locked` (timed at 5, for good at 10); `refresh_token.reuse_detected`; `password.reset` (one row in each business of the person).
- `POST /v1/auth/password/forgot` (always 202) and `POST /v1/auth/password/reset` (hash first, verify the code, then one identity function uses the code, sets the hash and clears the lockout; then refresh tokens are revoked in every business). Every failed reset is `400 OTP_INVALID`.
- Test-only route `POST /spike/careless`: logs every credential field (also nested) and fails with them in its error message.

**Changed from the proposal (told to Ian):** the request context lives inside `TenantInterceptor`, not in a separate global interceptor, because Nest does not document the order of global interceptors and the actor is only known after the session loads.

**Proof the tests catch mistakes** (each applied temporarily, then reverted and confirmed gone):
- Design mutation 5, `device_secret` removed from log redaction: test 3 failed ("a credential of length 43 appears in the logs", the device secret).
- Design mutation 4 on the new route, `forgot` answering `404 NOT_FOUND` for an unknown email: test 4 failed (`expected { status: 404 ... } to deeply equal { status: 202 ... }`).
- The rollback test also forces a crash right after the audit insert: the request answers 500, no audit row exists and the staff member is still `ACTIVE`.
- My own test slip, caught by the spike's RLS coverage test: the first ten full runs each failed one test, because the coverage test pins the list of tables with a `business_id` and I had not added `audit_log` to it. The new table itself was correct (the list showed it); adding it to the list also makes the per-table RLS check cover it, which it had not reached. The ten runs were then repeated from the start.
- Process slip, caught: the script that reverted mutation 4 used `git checkout` on a file that is not in git yet, so the revert silently failed. Noticed in the output, reverted by hand, and a search for leftover mutation markers runs before the final suite.

**Things to know:**
1. Use `AuditService` for every business event in later phases (voids, adjustments, approvals). Never put a value in metadata that you would not put in a log.
2. A public route must answer the same for a known and an unknown account, including for "expired" and "rate limited" cases, which leak just as well.
3. Equal work is checked by counting scrypt calls, not by timing: wall-clock comparisons would be flaky on this machine.

**Open for later steps:**
- `password.changed` is in the design's list, but Phase A has no change-password endpoint, so there is nothing to record yet.
- There is no endpoint to read the audit log (reports are Phase G).
