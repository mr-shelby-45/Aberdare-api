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
