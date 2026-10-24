# Spike results

Filled in step by step. The final summary (versions, open risks, changes to `docs/architecture.md`) is written when the spike finishes.

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

## Step 4: Prisma migrations with hand-written SQL (passed, one open fix)

**Result:** 12 new tests pass. Full suite 56 of 56 before the resets, and again 56 of 56 after deleting the Docker volume and rebuilding both databases from nothing (the test run built `aberdare_test` from an empty database).

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
- `prisma migrate reset --force` (run with Ian's explicit consent; Prisma's CLI refuses when it detects an AI agent): all 12 migrations re-apply, RLS and table grants come back, **but the app cannot work afterwards.** Prisma drops and recreates the `public` schema, now owned by `migrator` with default privileges, so `app_user` loses `USAGE` on it (`relation "product" does not exist`). That grant lived only in the Docker init script. Safe failure (nothing visible), but total. Fix proposed: a hand-written migration with `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO app_user;`. Awaiting Ian's approval.
- Difference in short: the Docker reset rebuilds the server (roles, databases, schema privileges) and then migrations; Prisma's reset only rebuilds what migrations contain. Anything outside migrations is lost by Prisma's reset. Nothing here was tested with Drizzle and no claim is made about it.

**4. Commands:** in CLAUDE.md section 8 (create, hand-write, apply, drift check, both resets).

**5. Workflow rule adopted:** in CLAUDE.md section 8 notes. In short: one hand-written file per custom object; read every generated migration; a guard test fails on any drop or weakening of policies, triggers, functions, extensions or hand-written indexes unless marked `-- allow-destructive:`; Prisma-expressible custom indexes are also declared in `schema.prisma`; an RLS coverage test fails if any table with `business_id` lacks forced RLS and the NULLIF policy.

**Other findings:**
- `prisma migrate dev --create-only` worked normally here. In step 2 it refused only because it wanted an interactive "yes" to a warning.
- `pg_trgm` is a trusted extension in Postgres 18, so `migrator` (database owner, not superuser) can install it.
- The trigger is `SECURITY INVOKER`: it runs as app_user, so its `change_log` row passes the same RLS check, and a rollback removes it with the product change (tested).
