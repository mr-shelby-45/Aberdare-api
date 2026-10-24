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
