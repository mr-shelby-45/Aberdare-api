# Spike: prove the risky parts first

Purpose: before any feature is built, prove that five risky things work with our exact stack (NestJS + Fastify + Prisma + PostgreSQL). If one fails we want to learn it now, while the project is a few files, not after months of code.

This is a throwaway-quality proof with production-quality tests. The tests are the deliverable. Small, readable code is fine; do not build features, endpoints for the real app, or UI.

## Ground rules for the spike

- Do the steps in order. Finish and show a passing run of one step before starting the next.
- Use a real PostgreSQL in Docker. No mocked database anywhere in the spike.
- Never weaken a test to make it pass. If a test fails, report the failure honestly (what happened, why, what you tried).
- A failed test is a valuable result, not an embarrassment. Do not hide it or work around it silently.
- Do not install libraries beyond CLAUDE.md section 3 without asking.
- Do not assume Drizzle or any other tool would fix a failure. It is untested. If Prisma fails a test, report it and propose options; Ian decides.
- Do not write Prisma, Nest or Fastify setup code from memory. Check the documentation for the installed versions, because setup has changed between major versions.
- After each step, commit with a clear message.

## Step 0: Project setup

Goal: an empty, working, tested skeleton.

1. Create the NestJS project in this folder using the Fastify adapter. Confirm the app starts and `GET /health` returns `{ "status": "ok" }`.
2. Add `docker-compose.yml` with PostgreSQL (a current supported major version; say which one you chose) and a persistent volume for local data.
3. Create two database roles in an init script: `migrator` (owns the schema, used for migrations) and `app_user` (not the owner, `NOBYPASSRLS`, only the privileges it needs). Two connection strings in `.env.example`: `MIGRATION_DATABASE_URL` and `DATABASE_URL`.
4. Install Prisma. Set it up so migrations run as `migrator` and the app and tests connect as `app_user`.
5. Configure Vitest (changed from Jest with Ian's approval; Nest 12 defaults to Vitest). Add a trivial test that connects as `app_user` and runs `SELECT 1`.
6. Fill in CLAUDE.md section 8 with the real commands.

Pass: `pnpm test` is green, the app starts, health responds, and a connection as `app_user` works while a connection that tries to run `ALTER TABLE` as `app_user` fails.

## Step 1: Tenant isolation (RLS) through Prisma

Question being answered: can Prisma and a transaction-scoped setting reliably give each business only its own rows?

Set up: tables `business` (no RLS) and `product` (`id`, `business_id`, `name`) with RLS enabled and forced, using the policy pattern in `docs/architecture.md` section 3. Create the policy in a hand-written SQL migration. Build the tenant wrapper: a function or Nest interceptor that opens a Prisma interactive transaction, runs `set_config('app.business_id', <id>, true)` first, and gives repositories the transaction client through AsyncLocalStorage.

Make the wrong thing hard: repositories must not be able to obtain the global Prisma client by accident. Show how the design prevents it (for example the repository only receives the tenant client from the context, and the raw `PrismaService` is only injected into the wrapper and the migration tooling).

Tests (all must pass):
1. Two businesses A and B each have products. Inside A's context, listing products returns only A's rows. Same for B.
2. Inside A's context, inserting a product with `business_id` of B fails (the WITH CHECK clause).
3. Inside A's context, updating or deleting one of B's rows affects zero rows.
4. Forgotten wrapper: calling the repository method with no tenant context returns zero rows or throws a clear error. It must never return all rows.
5. No leak between pooled connections: run at least 200 interleaved requests for businesses A and B concurrently with the pool size limited to a small number (for example 2 to 3), so connections are certainly reused. Every request sees only its own business's data every time.
6. After a transaction finishes, a plain query on the same connection with no setting returns zero rows (this checks the empty-string case).
7. `app_user` cannot bypass RLS: it cannot `SET row_security = off` to see data, cannot disable the policy, and is not the table owner.
8. The wrapper rolls back correctly when the handler throws (no partial writes).

Report: whether anything required a workaround, and the exact pattern chosen.

## Step 2: Atomic stock updates under concurrency

Question being answered: can we decrease stock safely when many requests arrive at the same moment, and does the ledger always agree with the cached balance?

Set up: tables `stock_movement` (append-only) and `stock_balance`, with RLS, per `docs/architecture.md` section 6. Write a small service with two operations: `decreaseStrict` and `decreaseForSale`. Use one conditional SQL statement (raw SQL through the tenant transaction client is fine and expected). Do not read the balance into JavaScript and check it there.

Tests (all must pass):
1. **Strict mode**: balance is 10. Fire 50 concurrent `decreaseStrict` calls of quantity 1. Exactly 10 succeed and 40 fail with `STOCK_INSUFFICIENT`. Final balance is 0, never negative. Sum of movements equals the balance.
2. **Sale mode**: balance is 10. Fire 50 concurrent `decreaseForSale` calls of quantity 1. All 50 are recorded, the balance ends at minus 40, and exactly 40 results are marked flagged (the ones that took the balance below zero). Sum of movements equals the balance.
3. Mixed quantities (for example 1, 2 and 5 at the same time) never produce a balance different from the sum of movements.
4. A failure halfway (force an error after the balance update but before commit) leaves neither a movement nor a balance change.
5. Break bulk: converting 1 carton into 24 pieces writes exactly two movement rows linked by one `stock_conversion` row, and both pools change together. 20 concurrent conversions against 5 cartons produce exactly 5 successes, 5 cartons used, 120 pieces added.
6. Run the whole concurrency test 20 times in a loop. It must be green every time. A test that passes only some of the time is a failing test.

Report: the final SQL used, and the transaction isolation level in effect (do not change the isolation level unless needed; explain if you do).

## Step 3: Idempotent commands

Question being answered: if the phone retries a command, or two copies arrive at once, is it processed exactly once?

Set up: table `sync_command` with a unique constraint on (`business_id`, `command_id`). Write service-level logic first, with no HTTP endpoint: `processCommands(commands[])`. Use a simple command, `stock.receive`, as the example handler. Insert the command row with `INSERT ... ON CONFLICT DO NOTHING` (or equivalent) as the very first step, not "select then insert".

Tests (all must pass):
1. Send the same command twice in sequence: processed once, the second returns the same stored result, stock increased once.
2. Send the same command 20 times concurrently: processed exactly once, all 20 callers receive the same result, stock increased once.
3. A batch of 5 commands where command 3 is invalid: commands 1, 2, 4, 5 are accepted, command 3 is rejected with a reason code, and the result lists each one separately.
4. A batch where one command lacks permission: that one is rejected, the others proceed.
5. Re-sending a previously rejected command returns the same rejection (it does not get a second chance by accident).
6. A command UUID from business A used by business B is treated as a different command (isolation by `business_id`).
7. Server crash simulation: if the handler throws after the command row is inserted, the final stored state must be consistent (either the whole command is rolled back including the command row, so a retry works, or it is recorded as failed). Pick one behaviour, explain it, and test it. Never leave a command row saying "done" with no effect.

Report: the chosen behaviour for step 7 and why.

## Step 4: Prisma migrations with hand-written SQL

Question being answered: does an ordinary schema change leave our RLS policies, triggers and special indexes alone, and does a full reset rebuild everything?

Set up: add to the database, through migrations, (a) the RLS policies from step 1, (b) a trigger that writes a `change_log` row when a `product` changes, (c) a trigram index (`pg_trgm`) on `product.name`, (d) a partial unique index of your choice. Each must be in a hand-written SQL migration file (use Prisma's create-only option, then edit).

Tests / checks:
1. Make an ordinary change in `schema.prisma` (add a nullable column to `product`) and generate a migration. Read the generated SQL. It must not drop or alter the policies, trigger, trigram index or partial index. If it does, record exactly what happened.
2. Apply it. Confirm the policy, trigger and indexes still exist (query the catalog tables).
3. Run a full reset of the LOCAL Docker database and re-apply all migrations from nothing. Confirm every structure comes back and the step 1 to 3 tests still pass.
4. Record the exact commands for: create a migration, hand-write one, apply, reset. Add them to CLAUDE.md section 8.
5. Write down the workflow rule that keeps hand-written SQL safe (for example: always review generated migrations; keep custom SQL in separately named files; add a CI check that fails if a migration drops a policy).

Report: any case where Prisma's diff tried to remove custom objects, and the rule adopted. For comparison, state honestly how this differs from Prisma's `migrate reset` behaviour and do not claim anything about Drizzle that you have not tested.

## Step 5: Fastify specifics

Question being answered: do the Fastify-specific needs of the webhook and rate-limiting work?

Tests (all must pass):
1. **Client IP**: with `trustProxy` configured, a request with an `X-Forwarded-For` header from a trusted proxy yields that IP in the request context. A request from an untrusted source with a forged header does NOT. Explain which proxy addresses are trusted and how that will be set per environment.
2. **Raw body**: an endpoint can access the exact raw request body bytes (needed if a webhook must be verified). Confirm with a test.
3. **IP allowlist guard**: a guard allows requests from an allowed range and blocks others, with a log-only mode switch. Test both modes with a fake range (do not put real Safaricom ranges in the test as if verified).
4. **Secret in path**: an endpoint `/webhooks/test/:secret` returns 404 for a wrong secret and does not reveal that the route exists. Use a constant-time comparison.
5. **Validation and errors**: an invalid body returns 422 with the error shape from `docs/architecture.md` section 11, including `requestId` and an ISO UTC `timestamp`. An unexpected thrown error returns `INTERNAL_ERROR` with no stack trace in the response.
6. **Logging**: a request produces one structured JSON log line with timestamp, requestId, route, status and duration. A request containing a field called `pin` or `otp` never shows its value in any log line (test it).
7. **Security headers and rate limit**: confirm `@fastify/helmet` and `@fastify/rate-limit` register on the Nest Fastify adapter and a burst of requests gets 429.

Report: any package that did not work with the Fastify adapter.

## Finishing the spike

1. Write `docs/spike-results.md` with: what passed, what failed, workarounds, final patterns chosen (the tenant wrapper, the stock SQL, the idempotency approach, the migration workflow), versions of every major tool, and anything that changes `docs/architecture.md`. Update `docs/architecture.md` where reality differed from the plan.
2. List open risks you noticed that this spike did not cover.
3. Do NOT change CLAUDE.md section 2 to "spike passed". Ask Ian to review the results and make that change himself.

## If a test fails: what to do

- Step 1 fails (RLS through Prisma): report exactly why. Options to propose, with trade-offs, not a decision: change how the wrapper obtains and releases the client, use the Prisma client extension approach, or evaluate another query layer. Another query layer is untested; it would need the same transaction-scoped setting and must pass the same eight tests before anyone trusts it.
- Step 2 fails (concurrency): the stock update must be one atomic statement or protected by a row lock. Report which, with proof from the test.
- Step 3 fails (idempotency): rely on the database unique constraint, never on application checks.
- Step 4 fails (migrations): adopt the review rule and separate custom SQL files; report whether a custom check is needed.
- Step 5 fails: report which package or setting is incompatible and the smallest fix.
