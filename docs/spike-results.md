# Spike results

**Status: all five steps passed. Waiting for Ian's review.** Only Ian marks the spike as passed, in CLAUDE.md section 2.

The final full run: 7 test files, **80 of 80 tests passed**, on the commit that adds this summary. The step-by-step record, with the evidence for each claim, is under "Step details" below.

## Summary

| Step | Question | Answer | Tests | Workaround needed? |
|---|---|---|---|---|
| 0 | Does the stack run with two database roles? | Yes | 5 | Vitest instead of Jest (Nest 12 default, approved); Prisma 7 driver adapter |
| 1 | Can Prisma plus a transaction-local setting isolate tenants? | **Yes** | 12 | None. One timeout fix in test 5 (connection wait, see risk 4) |
| 2 | Are stock decreases safe under concurrency? | **Yes**, with one conditional statement at READ COMMITTED | 14 | None |
| 3 | Is every command processed exactly once? | **Yes**, with `INSERT ... ON CONFLICT` plus a savepoint | 13 | None |
| 4 | Do migrations leave hand-written SQL alone? | **Mostly.** Prisma drops an undeclared GIN index; its reset loses schema grants | 13 | Declare the trigram index in `schema.prisma`; schema grants in a migration |
| 5 | Does Fastify do what webhooks and logging need? | **Yes**, and no package failed with the Nest adapter | 23 | None |

Every step ends with a passing run shown in the session. Steps 2, 3 and 5 were also checked with temporary "mutations" (the forbidden pattern put in on purpose) to prove the tests fail when they should; each mutation was reverted.

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Tenant isolation | `TenantRunner.run(businessId, fn)`: one Prisma interactive transaction, `set_config('app.business_id', id, true)` first, client in a private AsyncLocalStorage; repositories call `currentTx()`, which throws `TENANT_CONTEXT_MISSING` outside it. RLS `ENABLE` + `FORCE` + `shop_only` NULLIF policy on every tenant table. | `src/database/tenant.ts` |
| Keeping the raw client out of repositories | `DatabaseModule` does not export `PrismaService`; oxlint bans Prisma and `pg` imports outside `src/database/`; RLS returns zero rows as the last line | `src/database/database.module.ts`, `.oxlintrc.json` |
| Cross-tenant references | Composite foreign keys `(business_id, x_id) → x(business_id, id)` (foreign key checks ignore RLS) | `prisma/schema.prisma` |
| Stock decrease (strict) | `UPDATE stock_balance SET quantity = quantity - $q WHERE ... AND quantity >= $q RETURNING quantity`; no row = `STOCK_INSUFFICIENT` | `src/modules/stock/stock.repository.ts` |
| Stock change (sale mode, receipts) | One upsert: `INSERT ... ON CONFLICT ... DO UPDATE SET quantity = quantity + EXCLUDED.quantity RETURNING quantity`; flag when below zero | same |
| Ledger | `stock_movement` append-only (app_user has SELECT and INSERT only); balance updated in the same transaction | step 2 migrations |
| Idempotency | One transaction per command; first write `INSERT INTO sync_command ... ON CONFLICT DO NOTHING RETURNING id`; handler in a savepoint; expected rejections stored; a crash rolls back everything so the retry works; restrictive policy makes stored outcomes final | `src/modules/sync/` |
| Migrations | One hand-written file per policy, grant, trigger, function, extension or special index; read every generated migration; guard test fails on drops of custom objects; RLS coverage test; Prisma-expressible custom indexes also declared in `schema.prisma`; anything the app needs lives in a migration | CLAUDE.md section 8 (workflow rule), `test/step4-migrations.spec.ts` |
| HTTP | `createApp()` for production and tests: `trustProxy` from config (default: trust nobody), server-generated request IDs, one JSON log line per request, redaction, one error filter, 422 validation, helmet, rate limit, raw body | `src/create-app.ts` |

## Versions

All checked from the installed packages at the end of the spike.

| Tool | Version | Note |
|---|---|---|
| Node.js | 26.12.1 | Prisma 7.10.1 does not list Node 26 as supported (risk 10) |
| pnpm | 12.15.0 | blocks dependency install scripts; Prisma's are approved in `pnpm-workspace.yaml` |
| PostgreSQL | 18.6 | `postgres:18-alpine`, Docker 29.9.2 |
| NestJS | 12.2.0 | `@nestjs/core`, `@nestjs/platform-fastify` |
| Fastify | 5.12.7 | pinned by the Nest adapter; also a direct dependency at the same version |
| Prisma | 7.10.1 | `prisma`, `@prisma/client`, `@prisma/adapter-pg`. npm's "latest" tag pointed at 8.0.0-rc.27, so the version is pinned |
| pg | 8.23.1 | driver used by the Prisma adapter and by tests |
| class-validator / class-transformer | 0.15.1 / 0.5.1 | |
| @fastify/helmet / @fastify/rate-limit | 13.2.0 / 11.2.1 | |
| Vitest | 4.1.12 | |
| TypeScript | 6.0.3 | strict |
| oxlint | 1.89.0 | type-aware |

## Things to know

What the spike taught that the next phase depends on. Each item links back to its step below.

1. **Repositories never get a Prisma client.** They call `currentTx()`. Injecting `PrismaService` anywhere outside `src/database/` fails at startup and at lint time. (Step 1)
2. **After a transaction, the tenant setting reads as `''`, not NULL**, on the same pooled connection. The NULLIF in every policy is what turns that into "zero rows" instead of an error. (Step 1)
3. **Foreign key checks ignore RLS.** That is why every reference between tenant tables includes `business_id`. A plain foreign key would let one shop point at another's location. (Step 2)
4. **READ COMMITTED is enough for stock.** A competing `UPDATE` waits for the row lock and re-checks its `WHERE` against the new value. No `SELECT ... FOR UPDATE`, no SERIALIZABLE. Read-then-write in JavaScript oversold 40 of 50 in the mutation test. (Step 2)
5. **A savepoint is required whenever a failure must be recorded in the same transaction.** After any failed SQL statement Postgres rejects every further statement until `ROLLBACK TO SAVEPOINT`. Without it, a database-level rejection could not be stored and the command would be retried forever. (Step 3)
6. **Prisma 7 reports the Postgres error code at `meta.driverAdapterError.cause.originalCode`**, for raw queries and model calls alike. `23503` (foreign key) becomes `INVALID_REFERENCE`. (Step 3)
7. **Prisma's diff drops a GIN index it does not know about**, in every migration, even with no schema change. It ignores policies, triggers, functions, extensions and partial indexes. Declare Prisma-expressible custom indexes in `schema.prisma`. (Step 4)
8. **`prisma migrate reset` only rebuilds what migrations contain.** It recreated the `public` schema and lost app_user's access until the grant moved into a migration. A fresh hosted database behaves the same way. The Docker reset (`docker compose down -v`) is still the one to use locally. (Step 4)
9. **Prisma's CLI refuses `migrate reset` when run by an AI agent** unless the user consents in that moment. It worked as intended and was not bypassed. (Step 4)
10. **`prisma migrate dev` refuses in a non-interactive shell when it wants a "yes"** to a warning. `prisma migrate diff --from-migrations ... --script` produces the same SQL; it is documented in CLAUDE.md. (Steps 2 and 4)
11. **Error messages are not safe to log.** Database errors can quote the values being written. 500s are logged with name, code and stack frames only. (Step 5)
12. **Never `trustProxy: true`.** With it, a client can claim any IP, including one inside a webhook allowlist (shown by the mutation test). (Step 5)
13. **Every test file shares one real database**, so files run one at a time and data is wiped between tests. Concurrency tests inside a file are genuinely concurrent. (Steps 1 to 5)
14. **This development machine needed a bigger page file.** With 8 GB of RAM and a 2 GB page file, Windows ran out of commit memory and tools crashed at random (`0xC0000409`). Fixed with a 6 GB page file and a 2 GB WSL cap (`C:\Users\kyrex\.wslconfig`). No result from a crashed run was trusted. (Step 2)
15. **Windows reserves port 5432 on this machine**, so Postgres runs on host port 15432. Use `127.0.0.1`, not `localhost`, to reach the API. (Step 0)

## Open risks

Not covered by the spike, or found by it and left open. Roughly in order of how soon they bite.

1. **pg-boss has no database home yet.** pg-boss creates its own schema and tables when it starts, and app_user cannot create anything. The worker needs its schema created by a migration (or its own role) before the first job. Not tested.
2. **Role and table both named `app_user`.** The architecture's person table (`app_user`: phone, name) shares its name with the database role. Postgres allows it, but grants and queries will be easy to misread. Decision for Ian: rename the table (for example `person`) or the role (for example `api`) before the auth tables exist.
3. **Non-tenant access paths are not designed or tested.** Login looks up `app_user` and shop keys before any business is known, and `business` itself has no RLS yet. These need the "narrow access path" from `docs/architecture.md` section 3 and their own tests.
4. **Production pool size and connection wait are not chosen.** A burst bigger than the pool fails after `DATABASE_TX_MAX_WAIT_MS` (default 2 s) with "Unable to start a transaction". Safe (no leak), but requests fail. Needs a load test on the real host.
5. **Rate limits live in process memory.** With several API instances each counts separately, so a client gets N times the limit. A Postgres-backed store is the likely fix (Redis is ruled out).
6. **Connection poolers are untested.** If the host puts PgBouncer (or similar) in front of Postgres, transaction-local `set_config` should still be safe in transaction mode, but Prisma and the pg adapter with a pooler were not tested.
7. **Poison commands are retried forever.** A command that crashes the server every time stays `FAILED` and the phone keeps sending it. Counting attempts needs a separate transaction.
8. **A reused command UUID with a different payload is silently ignored** (the old result comes back). A payload hash column would catch it.
9. **Lock order for multi-row stock operations.** Break bulk locks two balance rows in a fixed order, so the tests saw no deadlock. Any future operation touching several balance rows must use the same order (for example by pack type id), or deadlocks become possible.
10. **Prisma 7.10.1 does not list Node 26 as supported.** Everything worked, but Node 24 LTS is the fallback if something odd appears. Prisma 8 (a release candidate during the spike) will need its own check before any upgrade.
11. **`fastify` must stay on the exact version Nest's adapter pins**, or two copies are installed and the types break. Check with `pnpm ls fastify` after every Nest upgrade.
12. **`change_log` cursor ordering under concurrent commits is untested.** `id` is a sequence, so a lower id can commit after a higher one. The architecture's "overlap window" handles this, but it is not built or tested.
13. **The migration guard is a text check.** It catches the destructive statements listed in CLAUDE.md, but not, for example, a dropped CHECK constraint or a `REVOKE` of a grant. Read every generated migration anyway.
14. **Money was not exercised.** No `Decimal` / `NUMERIC(14,2)` column exists yet; rule 7 is still untested in code.
15. **Sentry is not added.** 500s are only logged until its SDK is approved.
16. **Safaricom details are unconfirmed:** callback IP ranges and protection method (`docs/architecture.md` section 8). Start webhooks in `log` mode.
17. **Crashed sync commands are not logged** (`TODO(step 5)` in `sync.service.ts`); resolved when the sync endpoint exists.
18. **Only tested on this Windows machine.** The app has not been built or run in a Linux container, and production roles must be created on the host by hand (the Docker init script does not run there).
19. **Africa/Nairobi display and clock-skew flagging are not exercised.** All storage is UTC as required.

## Changes to `docs/architecture.md`

Updated during and at the end of the spike, each marked "As built" in place:

- Section 3: composite foreign keys (decided in step 2); the tenant wrapper as built, with the interceptor still to come; the database role naming question.
- Section 5: how `sync_command` processing works, including the crash behaviour Ian chose.
- Section 6: the exact stock SQL, the isolation level, append-only through grants.
- Section 11: logging, request IDs and error handling as built; Sentry not yet added.
- Section 12: `change_log` columns and why its id is a number; standard-column exceptions; tables that now exist.
- Section 15: the full list of environment variables.
- Section 16: new open items from the spike.

# Step details

## Step 0: Project setup (passed, commit e9dcea3)

- NestJS 12.2.0 on the Fastify adapter, PostgreSQL 18.6, Prisma 7.10.1 with `@prisma/adapter-pg`, Vitest 4.1, Node 26.12.1.
- Changed from the plan, with Ian's approval: Vitest instead of Jest (Nest 12 default); Prisma 7 driver adapter packages added.
- Tests: app_user runs `SELECT 1`, is not superuser, cannot bypass RLS, cannot `ALTER TABLE` or `CREATE TABLE`.

## Step 1: Tenant isolation (RLS) through Prisma (passed)

**Result:** all 8 tests in `docs/spike.md` pass, plus 4 guard tests. The full suite passed 10 runs in a row. No workaround was needed: Prisma 7 interactive transactions with the pg adapter keep every statement of the transaction on one connection, so a transaction-local `set_config` works as designed.

**Pattern chosen** (`src/database/tenant.ts`):

```ts
return this.prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.business_id', ${businessId}, true)`;
  return storage.run({ businessId, tx }, fn);   // storage: module-private AsyncLocalStorage
});
```

- Repositories call `currentTx()`, which throws `TENANT_CONTEXT_MISSING` when no tenant transaction is active. They never receive or import a client.
- `DatabaseModule` provides `PrismaService` but exports only `TenantRunner`. A class in another module that injects `PrismaService` makes Nest fail to start (tested).
- oxlint `no-restricted-imports` blocks `prisma.service`, the generated client, `@prisma/*` and `pg` anywhere in `src/` except `src/database/` (checked with a probe file).
- Nested `run()` is refused, and a non-UUID business id is rejected before any query.
- Policy: `business_id = NULLIF(current_setting('app.business_id', true), '')::uuid` for both USING and WITH CHECK, with ENABLE and FORCE row level security. In its own hand-written migration with the grants.

**Findings worth knowing:**

1. After a transaction ends, `current_setting('app.business_id', true)` on that connection returns `''` (empty string), not NULL. Test 6 confirms it on the same backend process. Without `NULLIF` the policy would throw on `''::uuid`; with it, the query returns zero rows.
2. `SET row_security = off` is allowed for app_user, but then Postgres refuses any query that RLS would filter ("query would be affected by row-level security policy"). It cannot be used to see other tenants' rows.
3. A non-async repository method threw synchronously when the context was missing (first run of test 4 failed). Still safe, but inconsistent for callers. Fixed by making repository methods `async`; rule recorded in CLAUDE.md.
4. 200 interleaved requests on a pool of 3 completed in about 1.2 s, within Prisma's default `maxWait` of 2 s for getting a connection. Under real load a burst bigger than the pool can handle would fail with a Prisma "unable to start a transaction" error rather than leak data. Pool size and `maxWait` need tuning before production (not a spike concern).
5. The per-request interceptor from `docs/architecture.md` section 3 is not built yet. It needs the signed access token (auth), which comes after the spike. Tests call `TenantRunner.run()` directly, which is what the interceptor will do.
6. **Finding 4 happened (during step 2).** After the machine's page file was enlarged, test 5 took 2.2 to 2.8 s and failed 3 runs in 10 with "Unable to start a transaction in the given time". No data leaked: the late requests got an error. Fix agreed with Ian: `PrismaService` reads `DATABASE_TX_MAX_WAIT_MS` (default stays 2000); test 5 alone uses 10000 ms and a 30 s Vitest timeout. Same 200 requests, same pool of 3, same assertions. Then 10 of 10 runs passed. The production value of the pool size and wait is an open risk.

## Step 2: Atomic stock updates under concurrency (passed)

**Result:** all 6 tests in `docs/spike.md` pass, plus 8 supporting checks. Test 6 runs the strict, sale, mixed and conversion scenarios 20 times each inside one test (about 45 to 57 s), and the step 2 file passed in every run after the memory fix (7 runs). Full suite: 31 of 31, twice in a row.

**Tables** (approved by Ian, columns kept to what step 2 needs): `location`, `pack_type` (`units_per_pack`), `stock_balance` (no non-negative check), `stock_movement` (append-only, no `updated_at`), `stock_conversion` (links two movements). RLS enabled and forced on all five with the NULLIF policy. Checks: `units_per_pack > 0`, `quantity_change <> 0`, and (Ian's addition) `out_movement_id <> in_movement_id`.

**Final SQL** (`src/modules/stock/stock.repository.ts`):

```sql
-- Strict decrease (stock.adjust, conversions). Zero rows = STOCK_INSUFFICIENT.
UPDATE stock_balance
SET quantity = quantity - $qty, updated_at = now()
WHERE business_id = $biz AND location_id = $loc AND pack_type_id = $pack
  AND quantity >= $qty
RETURNING quantity;

-- Sale-mode decrease and receipts: one atomic upsert, may go negative.
INSERT INTO stock_balance (business_id, location_id, pack_type_id, quantity)
VALUES ($biz, $loc, $pack, $delta)
ON CONFLICT (business_id, location_id, pack_type_id)
DO UPDATE SET quantity = stock_balance.quantity + EXCLUDED.quantity, updated_at = now()
RETURNING quantity;
```

The movement row is inserted right after, in the same tenant transaction. A sale is flagged when the returned quantity is below zero.

**Isolation level:** READ COMMITTED, the Postgres default, unchanged (checked by a test). It is enough because a competing `UPDATE` waits for the row lock and then re-checks its `WHERE` clause against the newly committed row. No row locks (`SELECT ... FOR UPDATE`) and no SERIALIZABLE needed.

**Proof the tests catch a race:** the strict decrease was temporarily replaced with read-then-write (read balance, check in JavaScript, write the new value). Test 1 failed at once: all 50 decreases "succeeded" against a balance of 10. The real code was restored and re-verified.

**Findings worth knowing:**

1. Foreign key checks ignore RLS. Without composite foreign keys, business A could record stock against business B's location. With them, the database rejects it (tested). Decision recorded in `docs/architecture.md` section 3.
2. Break bulk takes two row locks (carton pool, then piece pool) in one transaction. Concurrent conversions always lock in the same order, so no deadlock in the tests. Future operations that touch several balance rows must lock in a consistent order too, or deadlocks become possible. Not covered by the spike.
3. `prisma migrate dev --create-only` refused to run because it wanted an interactive "yes" for a warning (a new unique index on `product`). The same SQL was produced with `prisma migrate diff --from-migrations` and was identical to the reviewed SQL, with no DROP or policy changes. Replaying the migrations this way also showed Prisma left step 1's hand-written RLS policy untouched (relevant to step 4).
4. Environment, not code: with an 8 GB machine and a 2 GB page file, Windows ran out of commit memory and several tools crashed at random (Prisma CLI, tsc, the linter, Vitest workers). Fixed by a 6 GB page file and a 2 GB WSL cap. No test result was trusted from a run that crashed.

## Step 3: Idempotent commands (passed)

**Result:** all 7 tests in `docs/spike.md` pass, plus 6 supporting checks. The step 3 file passed 10 runs in a row; full suite 44 of 44, twice in a row.

**Table** (approved by Ian): `sync_command` with `command_id` (phone UUID), `type`, `status` (`PROCESSING`, `ACCEPTED`, `FLAGGED`, `REJECTED`), `result jsonb`, `created_at`; unique `(business_id, command_id)`. RLS enabled and forced with the NULLIF policy, plus a restrictive `outcome_is_final` policy (UPDATE only while `PROCESSING`, `WITH CHECK (true)`). Check: `result` is NULL exactly while `PROCESSING`. app_user: SELECT, INSERT, UPDATE; no DELETE.

**Pattern** (`src/modules/sync/sync.service.ts`), one tenant transaction per command:

```sql
-- First write of the transaction. No row back = already processed.
INSERT INTO sync_command (business_id, command_id, type, status)
VALUES ($biz, $cmd, $type, 'PROCESSING')
ON CONFLICT (business_id, command_id) DO NOTHING
RETURNING id;
```

Then permission check, payload validation (class-validator), the handler inside a savepoint, and `UPDATE ... SET status, result WHERE status = 'PROCESSING'`. A concurrent duplicate's `INSERT` waits on the unique index until the first transaction commits (it then returns the stored result) or rolls back (it then processes the command itself).

**Test 7 behaviour (chosen by Ian):** an unexpected error rolls back the whole transaction, command row included. Nothing is stored, the response is `FAILED` / `INTERNAL_ERROR`, and the retry processes the command normally (tested with a crash between the balance update and the ledger insert). A row that says "done" without its effect cannot exist, because both are in one transaction. Reason: a crash is not the phone's fault, and recording it as failed would block a valid command for good.

**Proof the tests catch the mistakes they target** (each mutation applied temporarily, then reverted):
- Check-then-insert instead of `ON CONFLICT`: test 2 failed. The duplicates hit the unique index and came back `FAILED` instead of the stored result.
- Handler without a savepoint: two checks failed. A rejection after a write committed `balance 5` with a ledger sum of `0` (balance and ledger disagree), and a foreign key failure left the transaction aborted, so the rejection could not be stored and the command came back `FAILED` (it would be retried forever).

**Findings worth knowing:**

1. The savepoint is essential, not optional. After any failed SQL statement Postgres refuses further statements in that transaction, so without `ROLLBACK TO SAVEPOINT` a rejection caused by the database cannot be recorded.
2. A reference to something that does not exist (or belongs to another business, thanks to the composite foreign keys) is a permanent rejection, `INVALID_REFERENCE`. Treating it as a crash would make the phone retry it forever. Detected through the Postgres code `23503`.
3. Prisma 7 puts the Postgres SQLSTATE at `meta.driverAdapterError.cause.originalCode` for raw queries (P2010) and model calls (P2003) alike (checked with a throwaway probe).
4. Validation is strict: no type coercion (`"5"` is rejected), no fractions, no unknown properties (a `businessId` in the payload is rejected, CLAUDE.md rule 2).
5. Added for test 4: a minimal `stock.adjust` handler (strict decreases only), because a permission test needs two command types with different permissions.

**Open risks from this step:**
- A command that crashes the server every time is retried forever. Counting attempts needs a separate transaction; not built in the spike.
- A phone that reuses a command UUID with a different payload gets the original result back; the change is silently ignored. A payload hash column would catch it.
- Crashed commands are not logged yet (`TODO(step 5)` in `sync.service.ts`); the project logger comes in step 5.

## Step 4: Prisma migrations with hand-written SQL (passed)

**Result:** 13 new tests pass. Full suite 56 of 56 before the resets, 56 of 56 after deleting the Docker volume and rebuilding both databases from nothing (the test run built `aberdare_test` from an empty database), and 57 of 57 (with the schema privileges test) against the dev database right after `prisma migrate reset`.

**Hand-written objects** (each in its own migration, approved by Ian): the RLS policies from steps 1 to 3 and a new one on `change_log`; the `product_change_log` trigger and `log_product_change()` function writing `change_log` rows; `pg_trgm` and the GIN trigram index `product_name_trgm_idx`; the partial unique index `pack_type_one_base_unit_per_product` (`WHERE units_per_pack = 1`).

**1. What Prisma's diff did** (`prisma migrate diff`, and then the real `prisma migrate dev --create-only` for the ordinary change):

| Hand-written object | Prisma's diff |
|---|---|
| RLS policies, `FORCE ROW LEVEL SECURITY` | ignored, never dropped |
| Trigger and function | ignored |
| `pg_trgm` extension | ignored |
| Partial unique index | ignored |
| **GIN trigram index** | **`DROP INDEX "product_name_trgm_idx";` in every migration, even with no schema change** |

Prisma understands GIN indexes, so an undeclared one looks like something to remove. It cannot express a partial index, so it leaves that alone. Fix: declare the index in `schema.prisma` (`@@index([name(ops: raw("gin_trgm_ops"))], type: Gin, map: "product_name_trgm_idx")`) while the hand-written migration still creates it. With that, the diff is empty, and adding `product.sku String?` generated exactly `ALTER TABLE "product" ADD COLUMN "sku" TEXT;`. Checked against the real dev database, not only a scratch copy.

**2. After applying:** the catalog still has every policy (8 tables, all enabled and forced), the trigger, the function, the extension, and both indexes. Now automated in `test/step4-migrations.spec.ts`.

**3. Resets of the local Docker database:**

- `docker compose down -v`, then up, then migrate: everything comes back (roles from the init script, all objects from migrations) and the full suite passes. **This is the reset to use.**
- `prisma migrate reset --force` (run with Ian's explicit consent; Prisma's CLI refuses when it detects an AI agent): all 12 migrations re-apply, RLS and table grants come back, **but the app cannot work afterwards.** Prisma drops and recreates the `public` schema, now owned by `migrator` with default privileges, so `app_user` loses `USAGE` on it (`relation "product" does not exist`). That grant lived only in the Docker init script. Safe failure (nothing visible), but total. **Fixed** (approved by Ian) by the hand-written migration `*_step4_schema_privileges`: `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO app_user;`. Verified with a second `prisma migrate reset --force` (Ian consented again): the schema is now owned by migrator with `app_user=U`, app_user can query (0 rows with no tenant set) but still cannot create tables, and the full suite run against that freshly reset database passed 57 of 57. A test now checks the schema privileges after migrations.
- Difference in short: the Docker reset rebuilds the server (roles, databases, schema privileges) and then migrations; Prisma's reset only rebuilds what migrations contain. Anything outside migrations is lost by Prisma's reset. Nothing here was tested with Drizzle and no claim is made about it.

**4. Commands:** in CLAUDE.md section 8 (create, hand-write, apply, drift check, both resets).

**5. Workflow rule adopted:** in CLAUDE.md section 8 notes. In short: one hand-written file per custom object; read every generated migration; a guard test fails on any drop or weakening of policies, triggers, functions, extensions or hand-written indexes unless marked `-- allow-destructive:`; Prisma-expressible custom indexes are also declared in `schema.prisma`; an RLS coverage test fails if any table with `business_id` lacks forced RLS and the NULLIF policy.

**Other findings:**
- `prisma migrate dev --create-only` worked normally here. In step 2 it refused only because it wanted an interactive "yes" to a warning.
- `pg_trgm` is a trusted extension in Postgres 18, so `migrator` (database owner, not superuser) can install it.
- The trigger is `SECURITY INVOKER`: it runs as app_user, so its `change_log` row passes the same RLS check, and a rollback removes it with the product change (tested).

## Step 5: Fastify specifics (passed)

**Result:** all 7 groups of tests in `docs/spike.md` pass (23 tests, including config checks). The step 5 file passed 10 runs in a row; full suite 80 of 80, twice. The built app (`dist/main.js`) starts through the same `createApp()` and answers `/health` with security headers and one JSON log line.

**Packages:** `@fastify/helmet` 13.2.0 and `@fastify/rate-limit` 11.2.1 (approved by Ian) both register on the Nest Fastify adapter with `app.register()` and work. **No package failed to work with the adapter.** `fastify` 5.12.7 was added as a direct dependency, pinned to the exact version Nest's adapter pins, only so our code can import its types and `LogController` (pnpm does not allow importing an indirect dependency). One copy is installed.

**Patterns chosen:**

1. **Client IP:** Fastify `trustProxy` set from `TRUST_PROXY` (addresses or CIDR ranges). Default empty: no proxy is trusted and `request.ip` is the socket address. Tested: a trusted proxy's `X-Forwarded-For` is used; a forged header from an untrusted address is ignored; a client cannot spoof through the trusted proxy by sending its own header (only the address the proxy saw counts). **Per environment:** empty locally and in tests; in production, the load balancer's private range once hosting is chosen.
2. **Raw body:** Nest's `rawBody: true` option; `req.rawBody` is the exact bytes (tested with odd spacing, a newline and non-ASCII text, compared by SHA-256).
3. **IP allowlist guard** (`src/common/security/ip-allowlist.guard.ts`): Node's built-in `net.BlockList`, `log` and `enforce` modes, IPv4-mapped IPv6 handled. Tested with RFC 5737 documentation ranges only.
4. **Secret in path:** SHA-256 both sides, then `crypto.timingSafeEqual`. A wrong secret returns exactly the same 404 as a route that does not exist (tested by comparing the two responses). Secrets never reach the log because the log has the route pattern, not the URL (tested).
5. **Errors:** one global filter for every error, including Fastify's unknown-route 404s, bad JSON (400) and rate-limit 429s. Invalid DTOs give 422 `VALIDATION_FAILED` naming the fields (never their values). Unexpected errors give 500 `INTERNAL_ERROR` with nothing internal in the response.
6. **Logging:** Fastify's `LogController` (the non-deprecated way in Fastify 5.12) replaced the default two lines per request with one. pino redaction for secret field names, and phone numbers masked to the last 3 digits. Tested: pin and otp values never appear, even when a handler logs the whole body by mistake, on the validation-failure path and on the 500 path.
7. **Helmet and rate limit:** security headers present on responses; a burst gets 429 in the standard shape with `Retry-After`, per client IP.

**Proof the tests catch the mistakes they target** (each applied temporarily, then reverted):
- `trustProxy: true` (trust everyone): 3 IP tests failed. A client could claim `192.0.2.50`, an address inside the test allowlist, which is exactly how an attacker would pass a webhook allowlist.
- Redaction removed: the pin/otp test failed with the PIN visible in the log line.

**Findings worth knowing:**
1. Error messages are not safe to log: database driver messages can quote the values being written (a PIN, a phone number). 500s are logged with error name, code and stack frames only.
2. The first app start on a cold machine took about 20 s once (most likely Windows Defender scanning freshly installed packages), which timed out the first test. Later starts take about 50 ms. The step 5 file warms up once in `beforeAll` (60 s limit); no assertion changed.
3. Fastify 5.12 deprecates `disableRequestLogging` and `requestIdLogLabel` (removed in Fastify 6); `LogController` replaces them and is what we use.

**Open risks from this step:**
- Rate limits live in process memory: with several API instances, each counts separately, so a client gets N times the limit. A Postgres-backed store is the likely fix (Redis is ruled out).
- Sentry is not added; 500s are only logged until its SDK is approved.
- The real webhook allowlist ranges are still unconfirmed with Safaricom (`docs/architecture.md` section 8); start in `log` mode.
- Crashed sync commands are still not logged (`TODO(step 5)` in `sync.service.ts`): there is no HTTP request around `processCommands` yet. It is resolved when the sync endpoint exists.
