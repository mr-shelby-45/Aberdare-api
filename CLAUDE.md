# CLAUDE.md - Aberdare API (backend)

Read this file fully at the start of every session. Then read `docs/architecture.md` for any design question and `docs/spike.md` while the spike is the current phase.

## 1. What this project is

The backend for a mobile (Android and iOS) subscription POS and inventory app for Kenyan shops, wholesalers and warehouses. One app, three independent business types chosen at signup: Retail, Wholesale, Warehouse. Many businesses (tenants) share one database. The phone app (Flutter, separate repo, not built yet) works offline and syncs to this API.

This repo is the backend only. Do not create any mobile or web UI code here.

The owner of the project is Ian, a developer who knows Next.js and TypeScript well, is new to NestJS, Prisma row-level security and Claude Code. Explain what you are doing in plain language, briefly. Do not assume he will spot a subtle mistake, so be explicit about risks.

## 2. Current phase

**SPIKE: PASSED.** Confirmed by Ian on 2026-10-24 (80 of 80 tests passing, results in `docs/spike-results.md`). Only Ian edits this line. Claude Code must never change it.

**PHASE A: IDENTITY. Design first, then build.**

The Phase A design is `docs/phase-a-design.md`. It is the source of truth for this phase and wins over `docs/architecture.md` where they disagree.

The spike proved the risky foundations. Real features are now built in the order below, one phase at a time. Do not start a phase until Ian writes "Phase X approved" in the status line at the end of this section. Do not build features from a later phase, even if it seems convenient.

| Phase | Contents |
|---|---|
| A. Identity | people, memberships, devices, SMS login codes, PIN login, tokens, shared tablets, per-request tenant interceptor, non-tenant access paths |
| B. Catalogue | locations, products, pack types, barcodes, search, and `POST /sync/commands` with the catalogue commands |
| C. Stock | receive, adjust, count, convert, approvals, stock reads |
| D. Sync | snapshot and changes reads |
| E. Sales and payments | sales, manual payments, voids, sales in sync |
| T. Field sales | location kinds and scope, issue and return, settlement |
| M. Daraja | Daraja C2B callbacks and M-Pesa verification (after E, needs Safaricom setup) |
| F. Worker | worker, notifications (fake senders), scheduled jobs |
| G. Business features | G1 reports, G2 subscriptions, G3 orders from a website |
| H. Launch work | hosting, Linux container, load test, Sentry |

Rules for every phase:
- Before writing code, present the design for that phase (tables, endpoints, who can do what, what could go wrong) and wait for Ian's approval. Update `docs/architecture.md` when the design is approved.
- Every phase keeps the rules in section 5 and the layer rules in section 4. The patterns proven in the spike (see `docs/spike-results.md`, "Final patterns") are the way to do these things. Do not invent new ones without asking.
- Every phase ends with passing tests shown in the session and a commit.
- Open risks listed in `docs/spike-results.md` are handled in the phase where they first matter. Do not ignore them, and do not fix them early without asking.

Status: I Ian mark Phase F done. Phase G is approved, start phase G

## 3. Fixed technology decisions

These are decided. Do not substitute, add alternatives, or "improve" them. If you think one is wrong, say so and wait for an answer.

- Language: TypeScript, strict mode on. No `any` without a comment explaining why.
- Framework: NestJS with the **Fastify adapter** (`@nestjs/platform-fastify`). Not Express. Do not install Express packages (`express`, `helmet`, `compression`, `cors` for Express, `multer`, `cookie-parser`). Use the `@fastify/*` equivalents only when needed.
- Database: PostgreSQL (plain, no provider-specific features). Local development uses Docker.
- ORM: **Prisma 7** (stable 7.x, pinned). Tenant isolation uses Postgres row-level security (RLS), see section 5. Prisma 7 requires a driver adapter, so `@prisma/adapter-pg` and `pg` (plus `@types/pg`) are approved. Do not move to Prisma 8 (a release candidate in October 2026) without asking.
- Queue: pg-boss (runs inside Postgres). No Redis, no RabbitMQ, no Kafka.
- Tests: Vitest (the NestJS 12 default; changed from Jest with Ian's approval) plus real Postgres in Docker. Do not mock the database in spike tests. A mocked database proves nothing about RLS or concurrency.
- Package manager: pnpm. Node: current LTS.
- Validation: `class-validator` and `class-transformer` DTOs, plus a config schema checked at startup.
- Access tokens: `@nestjs/jwt` (approved for Phase A). Password, PIN and code hashing use Node's built-in `crypto` (`scrypt`, HMAC-SHA256). No Passport, bcrypt, argon2 or session library.
- Hosting is not chosen yet (South Africa region is the plan). The code must only depend on `DATABASE_URL` style environment variables. No cloud-provider SDKs.

Before adding ANY library not listed here, ask. Say what it is for and why Nest, Fastify, Prisma or the standard library cannot do it.

## 4. Folder structure

One folder per feature module. One class per file, named `feature.type.ts`. Tests sit beside the code they test.

```
src/
  main.ts                 starts the API (Fastify)
  worker.ts               starts the background worker (same codebase, separate process)
  app.module.ts
  common/                 auth/ context/ errors/ logging/ validation/ time/
  config/                 environment loading and validation
  database/               prisma.service.ts, tenant.ts, migrations live in /prisma/migrations
  integrations/           daraja/ sms/ push/    (ONLY place that calls outside APIs)
  modules/                auth business staff devices products stock sales payments
                          orders-inbox sync subscriptions notifications reports audit health
  jobs/                   background job handlers
prisma/
  schema.prisma
  migrations/             includes hand-written SQL for RLS, triggers, special indexes
test/                     spike and end-to-end tests
docs/
```

A stock module looks like this (every module follows the same shape):

```
modules/stock/
  stock.module.ts
  stock.controller.ts
  stock.service.ts
  stock.repository.ts
  stock.service.spec.ts
  dto/stock-query.dto.ts
  commands/receive-stock.handler.ts
  commands/convert-stock.handler.ts
```

Layer rules (enforce these, they are what keeps the code understandable):
- Controller: parse input, check permission, call the service, return. No business rules.
- Service: all business rules. No Prisma calls.
- Repository: the ONLY code that calls Prisma. It always uses the tenant-scoped client from the request context (section 5).
- A module never reads another module's tables. It calls the other module's service. (Two approved exceptions. Phase C2: the read-only stock queries in `StockReadsRepository` join product, pack type, location and membership names. Phase G1: `ReportsRepository` (`src/modules/reports/`) runs read-only `SELECT` statements across `sale`, `sale_item`, `payment`, `stock_movement`, `stock_balance`, `field_settlement`, `field_settlement_line`, `location`, `product` and `pack_type`, in that one place, through the current tenant transaction (`currentTx()`), so RLS applies to every query. It never writes and never joins `membership`: display names come from `StaffService.displayNames()`. No other module may read across tables this way. See section 8.)
- External APIs (Safaricom, SMS, push) are called only from `integrations/`.

Only create the folders and files the current task needs. Do not generate empty modules "for later".

## 5. Rules that must never be broken

These protect real shopkeepers' money and data. Treat a violation as a bug even if tests pass.

**Tenant isolation**
1. Every business-owned table has a `business_id` column and an RLS policy. See `docs/architecture.md` section 3 for the exact pattern.
2. `business_id` comes ONLY from the signed access token. Never from a request body, query string, header, or URL parameter (the one exception is the optional safety check on the inbound-orders endpoint, which is compared against the shop key's business and rejected on mismatch).
3. Every request that touches business data runs inside one database transaction that first sets `app.business_id` with `set_config('app.business_id', <id>, true)`. The third argument `true` makes it transaction-local. Never use a session-level setting.
4. The API connects as a database role that is NOT the table owner and does NOT have BYPASSRLS. Migrations run as a different role. Never run the API with the migration role "to make it work".
5. A missing tenant setting must return zero rows or fail, never all rows. Write a test for it.
6. Never write `WHERE business_id = ...` as a substitute for RLS. Filters are allowed in addition, never instead.

**Money and quantities**
7. Money is never a JavaScript `number` in calculations. Use Prisma `Decimal` (database `NUMERIC(14,2)`). Currency is KES only for now.
8. Quantities are whole integers for now (pieces, cartons). Fractional quantities (kg, litres) are not supported yet. Do not add them.
9. Stock changes are only made by inserting rows in `stock_movement` and updating the cached balance in the SAME transaction. Never edit or delete a movement row. Corrections are new rows.
10. A stock decrease must be a single conditional SQL statement (see `docs/architecture.md` section 6). Never read the balance, check it in JavaScript, then write it. That pattern is a race condition.

**Time**
11. Store all timestamps as `timestamptz` in UTC. Convert to Africa/Nairobi only when displaying. Phone events carry `occurred_at` (from the phone) and the server adds `received_at`.

**Secrets and logs**
12. Never log or return PINs, OTPs, tokens, shop keys, full phone numbers (mask all but the last 3 digits), full request bodies, or M-Pesa secrets.
13. Store PINs and shop keys only as hashes (Node's `crypto.scrypt` plus a server-side pepper; see `docs/phase-a-design.md` section 7). Show a temporary PIN or shop key to the user once at creation.
14. No `console.log`. Use the project logger (structured JSON). Every log line has a UTC timestamp and a request ID.
15. No secrets in the repo. `.env` is git-ignored. Provide `.env.example` with fake values.

**Webhooks and external input**
16. Treat everything from Safaricom, the inbound-orders endpoint, and the phone as untrusted input. Validate it. Make every handler idempotent (processing the same message twice has the same effect as once).
17. Do not invent details of the Safaricom Daraja API (field names, IP ranges, response codes). Read the official documentation or ask Ian. If you cannot verify a detail, write `TODO(verify)` and tell Ian.

## 6. Common mistakes to avoid (read this list twice)

Over-engineering. Do NOT do these:
- No microservices, no separate repos, no monorepo tooling. One NestJS app with two entry points (`main.ts`, `worker.ts`).
- No CQRS framework, no event sourcing framework, no `@nestjs/cqrs`. "Command handlers" here are plain classes with one method.
- No generic base repository, no repository interfaces for every class, no abstract factories, no dependency-injection tokens unless a test truly needs one.
- No GraphQL, no WebSockets, no Redis, no caching layer. They are not needed.
- No custom decorators or abstractions that save fewer than three repeated lines.
- No feature flags system, plugin system, or configuration UI.
- Do not build "admin dashboards", "analytics", or "reports" in the spike.

Under-engineering. Do NOT do these either:
- Do not skip the concurrency, RLS and idempotency tests because they are "hard". They are the entire purpose of the spike.
- Do not leave error handling as `catch (e) { console.log(e) }`. Use the error shape in `docs/architecture.md` section 11.
- Do not skip input validation on DTOs.
- Do not let a test pass by weakening it. If a test fails, fix the code or report the finding.

Places where AI-written code commonly goes wrong in this project:
- **Prisma and RLS**: a plain `prisma.product.findMany()` outside the tenant transaction uses a different pooled connection with no tenant setting. Every query must go through the tenant-scoped transaction client. The easy mistake is injecting the global `PrismaService` into a repository. Make that impossible by design (see spike test 1).
- **Prisma interactive transactions** have a default timeout of about 5 seconds. Keep transactions short. No network calls (SMS, Daraja, push) inside a database transaction. Write a notification row in the transaction and let the worker send it.
- **`current_setting` in policies**: after a transaction ends the setting can read as an empty string, and `''::uuid` throws. The policy must use `NULLIF(current_setting('app.business_id', true), '')::uuid`.
- **Prisma migrations drop hand-written SQL**: a normal `prisma migrate dev` compares the schema file with the database and may generate statements that drop RLS policies, triggers, or special indexes it does not understand. Read every generated migration before applying it. Never apply one that drops or alters a policy, trigger, or trigram index unless that was the intent.
- **Prisma version differences**: Prisma's configuration, client generation and adapter setup have changed across major versions. Check the documentation for the version actually installed. Do not write setup code from memory.
- **Fastify differences**: Fastify is not Express. Middleware is not interchangeable. The real client IP behind a load balancer needs `trustProxy`. Webhook raw bodies need explicit enabling. Check Nest's Fastify documentation before writing adapter code.
- **Idempotency**: two identical requests arriving at the same moment both see "not processed yet". Use a unique database constraint plus `INSERT ... ON CONFLICT`, not "check then insert".
- **Timezones**: do not use `new Date()` for business logic days or "today" without stating the timezone.
- **Phone numbers**: always normalise to E.164 (`+2547...`) before comparing or storing.

## 7. How to work with Ian

- Work in small steps. One spike test or one feature slice at a time. After each step, run the tests and show the real output.
- A task is done only when the tests pass and you have shown the passing run. Never say "this should work".
- If a test fails, say so plainly, show the failure, and explain the cause. Do not hide it, rename it, or loosen it.
- Before changing the design, schema, a fixed decision in section 3, or any rule in section 5, stop and ask. When Ian approves a change, update the relevant doc file in the same commit.
- Ask a question when a decision is missing instead of guessing. Mention the default you would pick so Ian can reply with one word.
- Never run destructive commands (drop database, `migrate reset`, `git reset --hard`, force push, delete files) on anything except the local Docker development database, and say before you do.
- Commit after each passing step with a clear message. Do not commit secrets, `.env`, or `node_modules`.
- Keep explanations short. Ian prefers clear, direct, plain prose. Do not use em dashes.
- When you learn something that future sessions need (a command, a gotcha, a decision), add it to section 8 below.

## 8. Commands and project notes

Fill this in as the project grows. Keep it accurate.

```
First-time setup:       cp .env.example .env   then   pnpm install   then   pnpm exec prisma generate
Start local database:   docker compose up -d --wait
Stop local database:    docker compose down          (keeps data)
Run tests:              pnpm test                    (needs the database running; migrates aberdare_test first)
Lint:                   pnpm lint
Type-check (incl tests):pnpm typecheck
Build:                  pnpm build
Run API (dev):          pnpm start:dev               then GET http://127.0.0.1:3000/health
Run API (built):        pnpm build   then   pnpm start:prod
Run worker:             pnpm build   then   pnpm start:worker      (needs QUEUE_DATABASE_URL; Ctrl+C stops it cleanly)
Queue schema:           pnpm queue:migrate         (after every prisma migrate deploy: pg-boss's tables, as migrator)
Run a job now:          pnpm build   then   pnpm job:run <name>   (enqueues one run of a scheduled job for the running worker)
Generate Prisma client: pnpm exec prisma generate    (after every schema.prisma change)
Migration status:       pnpm exec prisma migrate status
Create migration:       pnpm exec prisma migrate dev --create-only --name <name>   then READ the SQL
Apply migrations (dev): pnpm exec prisma migrate dev
Hand-written migration: pnpm exec prisma migrate dev --create-only --name <name>   (with no schema change it is
                        empty; write the SQL into it, then apply). Keep RLS/grants/triggers in their own files.
Reset local database:   docker compose down -v   then   docker compose up -d --wait   then   pnpm exec prisma migrate deploy
                        (LOCAL DOCKER ONLY: deletes all local data in aberdare AND aberdare_test, re-runs the
                        role init script; tests rebuild aberdare_test themselves). This is the reset to use.
Prisma reset (dev DB):  pnpm exec prisma migrate reset --force   (LOCAL ONLY. Deletes all dev data. Prisma refuses
                        when run by an AI agent unless Ian consents in that moment. Works since the
                        *_step4_schema_privileges migration; prefer the Docker reset anyway.)
Check for drift:        pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
Migration guard:        part of pnpm test (test/step4-migrations.spec.ts)
```

Notes:
- Versions at step 0: Node 26.12.1, pnpm 12.15.0, NestJS 12.2.0 (Fastify adapter), Prisma 7.10.1, PostgreSQL 18.6 (`postgres:18-alpine`), Vitest 4.1, TypeScript 6.0.
- The project is ES modules (`"type": "module"`). Relative imports end in `.js`, even from `.ts` files.
- Postgres listens on host port **15432**, not 5432. Windows (Hyper-V/WSL) reserves a range that includes 5432 on this machine (`netsh int ipv4 show excludedportrange protocol=tcp`). Override with `POSTGRES_PORT`.
- Postgres 18 images keep data in `/var/lib/postgresql/18/docker`; the volume mounts at `/var/lib/postgresql`. Do not change it to `.../data`.
- Databases: `aberdare` (dev), `aberdare_test` (tests), `aberdare_shadow` (Prisma migration diffing). Roles and databases come from `docker/postgres/init/01-roles.sql`, which only runs on an empty volume.
- `app_user` has no table privileges by default. Every migration that creates a table must also `GRANT` exactly what the app needs on it (for example `stock_movement` gets SELECT and INSERT only). A missing grant fails loudly with "permission denied".
- Prisma CLI (`prisma.config.ts`) uses `MIGRATION_DATABASE_URL` (migrator). The app uses `DATABASE_URL` (app_user) through `PrismaService`. Tests replace `DATABASE_URL` with `TEST_DATABASE_URL` in `test/setup-env.ts`.
- Prisma 7 does not load `.env`; `prisma.config.ts` and the test setup use Node's `process.loadEnvFile`. No dotenv.
- Prisma's main docs now describe Prisma 8. The v7 docs are under https://www.prisma.io/docs/v7/. Prefer the installed type definitions (`node_modules/.pnpm/@prisma+config@*/`) when the docs are unclear.
- Prisma 7.10.1 prints "only supports Node.js 20.19+, 22.12+, 24.0+" on install under Node 26. It works in all step 0 checks. If anything odd appears, test on Node 24 LTS first.
- pnpm 12 blocks dependency install scripts. Approved ones are listed under `allowBuilds` in `pnpm-workspace.yaml` (`pnpm approve-builds <pkg> -y`).
- On Windows use `127.0.0.1`, not `localhost`, to reach the API: `localhost` may resolve to IPv6 `::1`, and the API listens on IPv4 `0.0.0.0`.
- Tenant wrapper (spike step 1): `TenantRunner.run(businessId, fn)` in `src/database/tenant.ts` opens one Prisma interactive transaction, runs `set_config('app.business_id', id, true)` first, and puts the transaction client in a module-private AsyncLocalStorage. Repositories call `currentTx()` / `currentBusinessId()`; both throw `TENANT_CONTEXT_MISSING` outside `run()`. Nested `run()` calls are refused.
- Three guards keep the raw client out of repositories: `DatabaseModule` does not export `PrismaService` (Nest fails with "can't resolve dependencies"), oxlint `no-restricted-imports` bans `prisma.service`, the generated client, `@prisma/*` and `pg` in `src/` outside `src/database/`, and RLS returns zero rows if both are bypassed. Do not weaken any of them.
- Repository methods must be `async`, so a missing tenant context is always a rejected promise, never a synchronous throw.
- New tenant tables: copy the pattern in `prisma/migrations/*_step1_product_rls/migration.sql` (GRANT, ENABLE + FORCE RLS, `shop_only` policy with NULLIF).
- Test files run one at a time (`fileParallelism: false`) because they share and wipe `aberdare_test`. Test helpers in `test/helpers/db.ts` seed and wipe as migrator; code under test always runs as app_user.
- References between tenant tables are composite foreign keys including `business_id` (FK checks ignore RLS). Referenced tables need `@@unique([businessId, id])`.
- `prisma migrate dev --create-only` refuses to run here (non-interactive shell) whenever it wants to confirm a warning. Then generate the same SQL with `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`, save it as `prisma/migrations/<UTC timestamp>_<name>/migration.sql`, read it, and apply with `pnpm exec prisma migrate deploy`. Check for drift with `pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.
- `PrismaService` reads `DATABASE_POOL_MAX` (default 10) and `DATABASE_TX_MAX_WAIT_MS` (default 2000, Prisma's own). A burst bigger than the pool fails with "Unable to start a transaction in the given time" after that wait. Only step 1 test 5 raises it (10000 ms).
- Phone commands (spike step 3, endpoint in B2): `SyncService.processCommands(actor, commands)` in `src/modules/sync/`, envelope `{ command_id, type, occurred_at, payload }`. A command type is a handler class implementing `CommandHandler` (type, permission, payload DTO, optional `extraPermissions()`, `handle(payload, ctx)`), for example `src/modules/products/commands/create-product.handler.ts`. A handler rejects by throwing `CommandRejectedError`; any other error is a crash and rolls the whole command back.
- Savepoints: `withSavepoint(fn)` in `src/database/tenant.ts`. Needed whenever a failure must be recorded in the same transaction: after a failed SQL statement Postgres aborts the transaction, and only `ROLLBACK TO SAVEPOINT` makes it usable again.
- Postgres error codes from Prisma 7: read them with `src/database/db-errors.ts`. The SQLSTATE is at `meta.driverAdapterError.cause.originalCode` for raw queries (Prisma code P2010) and model calls (P2003 and others) alike.
- Untrusted input is validated with `validateDto()` in `src/common/validation/validate-dto.ts` (class-validator: whitelist, forbid unknown properties, no type coercion).
- **Workflow rule for hand-written SQL (spike step 4):**
  1. Every RLS policy, grant, trigger, function, extension and special index lives in its own hand-written migration file, named after what it does.
  2. Read every generated migration before applying it. The migration guard test fails on any `DROP POLICY`, `ALTER POLICY`, `DROP`/`DISABLE TRIGGER`, `DROP FUNCTION`, `DROP EXTENSION`, `DISABLE`/`NO FORCE ROW LEVEL SECURITY`, or `DROP INDEX` of a hand-written index, unless the file has a `-- allow-destructive: <reason>` line. Never add that line without Ian's approval.
  3. An index Prisma can express (for example the GIN trigram index) must also be declared in `schema.prisma` with `map:` set to its real name, or Prisma generates a DROP for it in every migration. Add new hand-written index names to `HAND_WRITTEN_INDEXES` in `test/helpers/migration-guard.ts`.
  4. Prisma ignores policies, triggers, functions, extensions and partial indexes; it does not try to drop them.
  5. Every new table with `business_id` is checked by the RLS coverage test, so forgetting its RLS migration fails the build. Its expected table list must be updated in the same change (forgotten for `audit_log` in A5; the failure looks like an extra table in the list).
  6. Anything the app needs must be in a migration, not only in `docker/postgres/init/01-roles.sql`. `prisma migrate reset` (and a fresh hosted database) only gets what migrations contain. Only the roles and databases themselves live in the init script.
- `change_log` is written only by the `product_change_log` trigger (SECURITY INVOKER, so it runs as app_user and passes RLS). Its `id` is a BIGSERIAL because it is the sync cursor.
- HTTP setup (spike step 5): `createApp(rootModule, config)` in `src/create-app.ts` builds the app for both `main.ts` and the tests. Settings come from `loadConfig()` in `src/config/app.config.ts` (validated at startup; see `.env.example`). Test-only routes live in `test/spike/` and never ship.
- `fastify` is a direct dependency only so code can import its types and `LogController`. It must stay pinned to exactly the version `@nestjs/platform-fastify` pins (5.12.7 now); check with `pnpm ls fastify` after upgrading Nest. Two copies would break the types.
- Logging: Fastify's built-in pino, one line per request from `RequestLogController` (route pattern, never the URL, so path secrets stay out of logs). Sensitive field names are redacted and phone numbers masked by `src/common/logging/logger.options.ts`. 500s are logged with error name, code and stack frames but not the message (Prisma messages can contain the data being written).
- Errors: `AllExceptionsFilter` gives every error, including Fastify's 404s, bad JSON and rate-limit 429s, the shape `{ error: { code, message, requestId, timestamp } }`. Throw `ApiError(status, code, message)` for an error we choose; its message is shown to users.
- Proxies: with `TRUST_PROXY` empty, `X-Forwarded-For` is ignored. Never set `trustProxy: true` (trust everyone): a client could then claim any IP and pass an IP allowlist (shown by a mutation test in step 5).
- Identity access path (Phase A1): login lookups before any business is known go only through `IdentityLookup` in `src/database/identity-lookup.ts`, which calls the `identity_*` SQL functions (owned by `identity_owner`, `SECURITY DEFINER`, one exact key each). Inside a tenant transaction it uses that transaction (via `currentTxIfAny()`), otherwise the raw client. New person writes need a new narrow function, proposed to Ian first; `app_user` can never write `person` and never reads its password or lock columns.
- **Grant before you hand over a function.** `REVOKE`/`GRANT` on a function run by someone who is no longer its owner only print a WARNING and change nothing (Postgres does not fail, so Prisma reports success). In A1 this left all 9 identity functions executable by PUBLIC until the privileges test caught it (fixed by `*_a1_identity_function_grants_fix`, which does `SET ROLE identity_owner` first). In new migrations: grant and revoke first, then `ALTER ... OWNER TO`, or `SET ROLE` to the owner.
- `identity_owner` is created by `docker/postgres/init/01-roles.sql` (and by hand on a hosted database) with `GRANT identity_owner TO migrator WITH INHERIT FALSE, SET TRUE`. The first A1 migration stops with a clear message if either is missing.
- `business` has forced RLS on its own id. To create one: generate the id, `set_config('app.business_id', id, true)`, then insert (see `createBusiness` in `test/helpers/db.ts`).
- Tests that need a person with email, password or verified flags seed those columns as the postgres superuser (`asAdmin`, `TEST_ADMIN_DATABASE_URL`), because no role may write them until the A2 signup function exists. Never use `asAdmin` for anything under test.
- Two identity functions use PL/pgSQL with two statements on purpose: under READ COMMITTED one statement keeps its starting snapshot, so a "claim, else explain why not" query in one statement misreports rows a concurrent transaction just changed (tested with 20 concurrent calls).
- App wiring (Phase A2): `createApp()` is built from `withCore()` (adds the global `CoreModule`: `AppConfig`, `Clock`, `PasswordHasher`, `CodeHasher`), `createAdapter()` and `configureApp()`. Tests build the same app from the same pieces in `test/helpers/app.ts` (`startTestApp`), with `FakeClock` instead of `Clock` and the fixed `TEST_ENV` secrets. Services needing settings inject `AppConfig`; never read `process.env` in a service.
- Time: business logic uses the injected `Clock`, never `new Date()` (lockouts, expiries, rate windows, token iat/exp). JWTs are signed with `iat`/`exp` from the clock and verified with `clockTimestamp` from the clock, so tests move the clock instead of sleeping.
- Hashing (A2, Ian's choice): scrypt N=2^15, r=8, p=3 (OWASP minimum, 32 MiB), HMAC-pepper first, stored `scrypt$N$r$p$salt$hash`. About 430 ms per hash on the dev machine. Hash before opening a transaction, never inside one. Codes and temp PINs: HMAC-SHA256 with the pepper over `channel|target|purpose|code`.
- `otp_challenge` is reached only through identity functions (app_user has no privileges on it). Send limits count every purpose per target. The code comparison happens inside `identity_verify_otp` (two HMACs keyed by the pepper; approved exception to "constant-time compare in JavaScript").
- Required settings since A2: `AUTH_PEPPER` and `JWT_SECRET` (32+ characters each). `main.ts` loads `.env` when present; real environment variables win. Every token kind has its own JWT `aud` (`access`, `signup`, ...) and verification always pins `algorithms: ['HS256']` and the audience.
- Request pipeline (A3): every route is protected by default. Mark open routes with `@Public()` (health, signup, login, PIN, refresh, test-only spike routes). `AuthGuard` (global) checks the access token only; `TenantInterceptor` (global) runs the request in one tenant transaction, loads the live membership and device, and enforces `@RequirePermission(...)`. Never check membership status or permissions in a guard: guards run before the tenant transaction (shown by a mutation in A3: everyone was refused). Handlers read `request.auth` (token ids) and `request.session` (live membership, device, permissions).
- Locks must never answer differently for a right and a wrong guess, or the lock becomes a guessing oracle. Password lockout: always `INVALID_CREDENTIALS`. PIN lock: always `ACCOUNT_LOCKED`, without checking the PIN.
- Prisma 7 reads a `timestamptz` of `'infinity'` as an `Invalid Date`, which compares false with everything. Never use `'infinity'` (or `-infinity`) for "forever"; use a count or a flag (found in A3: the permanent PIN lock silently did not lock).
- Test-only protected routes for pipeline tests: `test/spike/protected.controller.ts`.
- **Any test run applies pending migrations to `aberdare_test`** (`test/global-setup.ts` runs `prisma migrate deploy`). When Ian has asked to see a migration before it is applied, do not run any tests until he approves (this caught us out once in A4; the apply was undone).
- Module layout since A4: `staff`, `devices`, `sessions` (refresh tokens) and `business` are data modules with no imports of each other; `auth` and `team` (staff and device endpoints) sit above them and orchestrate. Keep data modules free of each other to avoid circular imports. `audit` (A5) sits below all of them and imports nothing, so any module may import it.
- Audit log (A5): services call `AuditService.record({ action, targetType, targetId, metadata, actorMembershipId? })` (`src/modules/audit/`). It writes in the current tenant transaction, so it commits or rolls back with the change. Leave `actorMembershipId` out to use the request's actor; pass `null` for system events. Metadata holds only ids, enums, counts and flags; keys that look like secrets or contact details throw. The IP and actor come from `src/common/context/request-context.ts`, opened by `TenantInterceptor` for every route (inside it on purpose: Nest does not document the order of global interceptors). `app_user` has SELECT and INSERT only on `audit_log`.
- Public auth routes never reveal whether an account exists: every failed password reset is `OTP_INVALID` (not `OTP_EXPIRED`, since anyone can request a code and wait), and forgot always answers 202, even when a send limit stops the code.
- Replaying migrations in the shadow database only (to check new hand-written SQL before Ian approves it): as migrator in `aberdare_shadow`, `DROP SCHEMA public CASCADE; CREATE SCHEMA public; REVOKE ALL ON SCHEMA public FROM PUBLIC;`, then run `prisma migrate deploy` with `MIGRATION_DATABASE_URL` set to the shadow URL and `SHADOW_DATABASE_URL` set to a database name that does not exist (otherwise Prisma refuses with P3025, "shadow same as main"). Dev and test are untouched.
- Inline `node -e` scripts with backticks inside a Bash heredoc command fail on shell quoting (and then nothing runs). Write edit scripts to a file in the scratchpad, or use the editor tools.
- The first test run after a restart spends about 5 minutes importing modules (cold cache); later runs are faster. A single test file printing nothing for minutes is normal: Vitest prints a file's results when it finishes.
- Phase B1: a new tenant table, trigger, trigger function or hand-written index must also be added to the exact inventories in `test/step4-migrations.spec.ts` (RLS coverage list, trigger and function list, `HAND_WRITTEN_INDEXES`). Those lists are deliberate; updating them is expected, never a weakening.
- Adding a NOT NULL column to a table that may hold rows: Prisma's generated SQL has no default and fails on rows. Edit the generated migration to `ADD COLUMN ... NOT NULL DEFAULT <x>` then `ALTER COLUMN ... DROP DEFAULT`, and say so in a comment at the top.
- `app_user` cannot DELETE `product`, `pack_type` or `location` (archive instead); only `product_barcode` rows are deleted. `change_log.row_key` carries a barcode's text for phones.
- Testing as `app_user` in the shadow database (which `app_user` cannot connect to): connect as `postgres` and `SET LOCAL ROLE app_user` inside a transaction; RLS and grants apply as usual.
- Sync endpoint (B2): `POST /v1/sync/commands` is the only route with `@OwnTransactions()`: `TenantInterceptor` checks the session in a short transaction, then the handler runs outside any transaction and `SyncService` opens one per command. A new command type is a handler class in its module's `commands/` folder, added to `CommandHandlers` (`src/modules/sync/command-handlers.ts`; `CatalogueHandlers` until C2). Payload-dependent permissions go in the handler's `extraPermissions(payload)`. Map unique violations by constraint name with `uniqueViolationConstraint()`.
- Reverting a mutation on a file that is not in git yet: `git checkout` cannot restore it and fails quietly in a script. Copy the file to the scratchpad first, restore from the copy, and compare with `cmp` (as `mut4b.sh` did in B2).
- Barcode test data: count the digits. A 13-digit code gets no leading zero; only a 12-digit code does (`036000291452` becomes `0036000291452`). A wrong example once made three B2 tests fail for the wrong reason.
- Test speed-ups (approved by Ian before B3; suite 267 s -> 161 s): `startTestApp` replaces `PasswordHasher` with `test/helpers/fast-password-hasher.ts` (scrypt N=2^10, p=1, about 4 ms per hash), and the test global setup sets `synchronous_commit = off` on `aberdare_test` only (it refuses any database not ending in `_test`). Production has no setting for either. `test/password-hasher.spec.ts` proves the app built by `createApp()` still hashes at N=2^15, r=8, p=3. A test that checks stored hashes from the test app expects `scrypt$1024$8$1$`.
- Faster hashing changes race timing. A concurrency test that relied on slow hashing to keep two requests overlapping can silently stop testing the race. Make the overlap certain instead (A4's double-activation test holds both requests at the PIN hash until both arrive), and keep the exact assertion. Never widen it to "either answer".
- Testing method from B3 on: see `docs/phase-b-design.md` section 12 (new files until they pass, concurrency tests 5 runs in a row, a cumulative Phase B step gate plus one full run, 3 full runs at the end of the phase).
- Generated columns (B4, `product.name_lower`): Prisma 7 cannot declare one. Create it in a hand-written migration, and declare it in `schema.prisma` as `String? @default(dbgenerated("<expression>")) @map(...) @ignore`. Without the field Prisma generates a `DROP COLUMN`; without `dbgenerated` it generates `DROP DEFAULT`, which fails on a generated column and blocks every later migration. Check with `migrate diff --from-migrations ... --exit-code` (must be 0).
- Under RLS, `LIKE`/`ILIKE` (not leakproof) cannot use an index: a search filters the caller's own business rows. Keep that filter cheap (the stored `name_lower`), and measure with `EXPLAIN ANALYZE` as `app_user`, not as the superuser.
- Timing tests on this 2-core laptop are noisy (the same query varied 3 times between runs). Leave a clear margin under any time bound, and make a timing test write its measurements before it asserts, so a failing run leaves evidence.
- The test app (`startTestApp`) waits up to 10 s for a pooled connection (`DATABASE_TX_MAX_WAIT_MS=10000`, set only while the app is built; approved by Ian in B5). Production keeps Prisma's 2000. The spike helper `prismaWithPool` keeps its own explicit settings. Under heavy CPU load the 2 s wait once made a 20-request concurrency test fail with a whole-request 500 (spike open risk 4).
- `app_user`'s exact table and column privileges are pinned by the grants inventory test in `test/b5-hardening.spec.ts`. A new table or a changed grant must be added there on purpose, like the step 4 inventories.
- Real-API walkthrough runs: start the built API (`node dist/main`) with `DATABASE_URL` set to the TEST database and the dev settings on the command line, so the dev database stays clean for Ian's own walkthrough (B5).
- Stock ledger (C1): every `StockService` operation takes a `MovementContext` (`occurredAt` phone time, `createdByMembershipId`, `syncCommandId` = the claimed `sync_command` row id, now in the command context). Movements record `movement_type` and `quantity_after` from the balance statement's `RETURNING`. Database checks enforce types, signs, reasons, unit cost, count quantities and text lengths. `seedShop` creates a MANAGER member (`shop.member`) for movement creators; tests that also need an owner add their own (one owner per business).
- Approvals (C1): `ApprovalsRepository.consume()` (`src/modules/approvals/`) is the one atomic consumption statement; `app_user` may update only `consumed_at` and `consumed_by_sync_command_id`. `StockIntegrityService.check()` lists pools whose balance differs from the ledger sum.
- Error logs carry `errorCode` (the Postgres SQLSTATE, else the error's own code, via `errorCodeForLog()` in `src/database/db-errors.ts`), in the unhandled-error line and the `sync command failed` line. The field name `code` stays redacted.
- Stock commands (C2): `stock.receive` and `stock.adjust` handlers live in `src/modules/stock/commands/`, provided by `StockCommandsModule` (imports Stock, Products, Locations, Audit). It exists because `ProductsModule` imports `StockModule`; putting the handlers in `StockModule` would be a cycle. Rules are in `StockCommandsService`; it throws `StockError` (with `invalidLines` for `INVALID_LINES`), and `rejectionFor()` turns that into a `CommandRejectedError`, whose optional `data` becomes the command's `result`. Every line is checked before any write; lines are applied larger pack first, then by id (the lock order).
- `StockRepository.changeBalance()` returns `null` when the result would leave -`MAX_BALANCE`..`MAX_BALANCE` (2,000,000,000; cap in C2, floor in C3; a bigint `WHERE` on the upsert's conflict branch); `StockService` turns that into `VALIDATION_FAILED`.
- `stock.convert` (C4): `ConvertStockHandler` has dispatcher permission `stock.view` and checks `stock.convert` itself, because from C5 an attendant may convert with an approval. `StockService.convert()` (quantity, options `{ note, approvedByMembershipId, approvalId }`) replaced the spike's `convertOne`; the spike step 2 and C1 tests call `convert(…, 1, …)`.
- Approvals (C5): `ApprovalsModule` (`src/modules/approvals/`: service, controller under `/v1/stock`, repository) imports Database, Staff and Audit; `StockCommandsModule` imports it. `@OwnTransactions()` is now on two routes (sync commands and `POST /v1/stock/approvals`, approved by Ian); the B2 marker test lists both. The approval counters are changed by `StaffService.recordApprovalAttempt()` after a `FOR UPDATE` read, never by the PIN login code. `SyncActor` has `deviceId` and `CommandContext` has `receivedAt`; tests that build an actor by hand pass a device id.
- Approval purposes (E5): `STOCK_CONVERT` and `SALE_VOID` (`APPROVAL_PURPOSES` in `approvals.repository.ts`, each mapped to its permission in `approvals.service.ts`). Commands use an approval with `ApprovalsService.use(purpose, ...)`. `sale.void` is in `SalesService.void()`; a double void is stopped twice, by the conditional `UPDATE` and by the `voided_is_final` policy, so a mutation test of one needs the other removed (drop the policy only in `aberdare_test`, then re-create it and compare an md5 of `pg_policies`).
- Void lock order (E6): sale row, then stock pools (lock order), then payments. Reversing a payment that holds an M-Pesa code makes a concurrent sale reusing the code wait at the code index; if the void still needed that sale's pool, they deadlocked (`40P01`, found by the E6 workload). Any new code that changes a payment row must do it after its stock statements.
- E6: the randomized sales workload (`test/e6-hardening.spec.ts`) runs seeds 404, 505 and 606; replay one with `E6_SEED=<n> pnpm exec vitest run test/e6-hardening.spec.ts -t randomized`. A `FAILED` command puts its log line (with the SQLSTATE) in the failure message; a deadlock depends on timing, so repeat the run rather than trusting one replay. The Postgres log (`docker compose logs`) names both statements of a deadlock. The Phase E walkthrough is `docs/phase-e-walkthrough.md`, mirrored by `test/e6-walkthrough.spec.ts`.
- Field sales schema (T1): `location.kind` (`SHOP` default, `WAREHOUSE`, `FIELD`) and `assigned_membership_id` (exactly on `FIELD`, one active field location per member by the partial index `location_one_active_field_per_member`); `app_user` may update only a location's `name`, `archived_at` and `updated_at`, so a field location is reassigned by archiving it and creating a new one. `stock_transfer`, `field_settlement` and `field_settlement_line` are append-only (SELECT and INSERT). The `FIELD_ATTENDANT` preset holds `sales.create`, `payments.confirm`, `stock.view` and never extras (`effectivePermissions()` ignores them; the staff API refuses them with `EXTRA_PERMISSIONS_NOT_ALLOWED`). `stockApi().activeStaff()` can create one. Results: `docs/phase-t-results.md`.
- Location scope (T2): `LocationScope` (`src/modules/locations/location-scope.ts`) is the one place that decides; never add an ad hoc check. Commands use `LocationsService.findInScope(id, membershipId)` (null for missing, foreign and out of scope alike); reads use `scopeOf(membershipId).ids()` (null = all) in the query; sync gets it through `syncView()`, and the changes cursor binds `scope` (`ChangeFeedService` takes `{ costs, allSales, scope }`). `location` and `stock_balance` send no delete markers since T2.
- Transfers (T3): `StockService.transfer()` runs every balance statement of both locations in `inTransferLockOrder()` (`src/modules/stock/lock-order.ts`: location id, then larger pack first, then pack type id); the source is strict, the destination capped. Any new operation touching several locations must use that order. A forced deadlock test must start the command that would get the released row first (the lock queue is first come, first served).
- Settlements (T4): window rule B, a sale or movement belongs to the settlement whose snapshot first sees its transaction (`sale.txid`, `stock_movement.txid`, `field_settlement.snapshot`, `pg_visible_in_snapshot`); never a time window. The close locks the location row `FOR NO KEY UPDATE` (never `FOR UPDATE`: sales' foreign keys take `FOR KEY SHARE` on it), then the location's balance rows in the pack order, then takes the snapshot. `field-settlements` is a data module (the sales flag `AFTER_SETTLEMENT` uses it); `field` orchestrates. A test close needs the attendant's phone synced within 10 minutes (a sync read stamps `last_sync_at`). Tests that insert `field_settlement` by hand must supply `snapshot`.
- Settlement order (T5): the previous settlement is the one with the highest `field_settlement.sequence` (previous + 1 under the location lock), never the latest `period_end` or `received_at`: a close that arrives first can commit second, and the test clock gives ties. `period_end` is the clock time after the lock, never before the previous one. Hand-written settlement inserts must supply `sequence` too.
- Payments in settlements (T6): `payment.location_id` (part of the foreign key to the sale), `recorded_by_device_id`, `txid` and `reversed_txid` (the void sets it with `REVERSED`; a check ties them). A settlement counts a payment + when its snapshot first sees `txid`, - when it first sees `reversed_txid`, and only the attendant's own payments on their personal devices (`DevicesService.personalDeviceIdsOf()`: registered by them, not shared, any status); `PaymentsService.windowTotals()`. Hand-written payment inserts must supply `location_id` and `recorded_by_device_id`, and a hand-written reversal must set `reversed_txid`. A command with an actor the API cannot produce (a manager on a hawker's personal phone) is sent through `SyncService.processCommands()` directly (`test/t6-payment-window.spec.ts`). The randomized field workload (`test/t5-hardening.spec.ts`) runs seeds 707, 808 and 909; replay one with `T5_SEED=<n> pnpm exec vitest run test/t5-hardening.spec.ts -t randomized`. The Phase T walkthrough is `docs/phase-t-walkthrough.md`, mirrored by `test/t5-walkthrough.spec.ts`.
- Worker and queue (F1): `src/worker.ts` uses `createWorker()` (`src/create-worker.ts`), which tests use too. pg-boss is pinned at exactly 12.38.0 (its peer `@opentelemetry/api` came with it); read the installed version's docs and typings before using a new pg-boss call. pg-boss connects as `queue_user` (`QUEUE_DATABASE_URL`; tests `TEST_QUEUE_DATABASE_URL`, mapped in `test/setup-env.ts`), which has USAGE only on the `pgboss` schema; `app_user` has none there. Its tables are created by `pnpm queue:migrate` (and the test global setup) as migrator; the worker starts with `migrate: false`. Never create a partitioned queue (that is runtime DDL `queue_user` cannot run). The worker logs through `createWorkerLogger()` (the API's pino options from an unlistened Fastify instance; no direct pino dependency).
- `queue_user` is a role, so it comes from `docker/postgres/init/01-roles.sql` on a fresh volume, and by hand (as postgres) on an existing volume or a hosted database; the `f1_queue_schema` migration stops with a clear message if it is missing.
- Per-schema default privileges only ADD: `ALTER DEFAULT PRIVILEGES IN SCHEMA x REVOKE ... FROM PUBLIC` silently does nothing against the global default (PUBLIC keeps EXECUTE on new functions). The gate for pg-boss's functions is the schema's USAGE (found in F1; the ineffective line was removed and its local checksum updated).
- Handing a function to `identity_owner` needs `GRANT CREATE ON SCHEMA public TO identity_owner` just for the `ALTER FUNCTION ... OWNER TO`, revoked in the same migration (A1 pattern; F1 `list_business_ids` hit it).
- `error_event` has no RLS (Phase F1 exception approved by Ian): `app_user` may only INSERT, so write it with a plain INSERT, never `INSERT ... RETURNING` or a Prisma `create()` that returns the row. The step 4 RLS test lists it as the one exception. `resetTables()` truncates it.
- Notifications (F2): `NotificationsService.notify(event, targets, { exclude })` (`src/modules/notifications/`, a data module importing only staff and the database layer) writes in the caller's transaction with one `createMany({ skipDuplicates: true })` (`INSERT ... ON CONFLICT DO NOTHING`, no RETURNING). Recipients come from `StaffService.listActive()`: `OWNERS` = active members with the OWNER preset; named members only if active. It never fails the caller: its work runs in `withSavepoint()` and any error becomes one `error_event` (`ErrorEventLog`, `src/database/error-event-log.ts`) in the same transaction. Types and allowed data keys are in `notification-types.ts`; `created_at` comes from the Clock. Business isolation of the reads has two guards (RLS and `recipient_membership_id = caller`): a mutation test of one needs the other removed too.
- Push delivery (F3): `NotificationDeliveryService` (`src/modules/notifications/`) for one business: claim (one `UPDATE ... WHERE status = 'PENDING' AND id IN (... FOR UPDATE SKIP LOCKED)`, attempts + 1, `next_attempt_at` = the 5-minute lease) and commit, send with no transaction open, then save each result only if the row is still in that claim (`status = 'SENDING' AND attempts = <claimed>`). 3 attempts (30 s, then 2 min); a dead token is cleared and the row `DEAD` without an `error_event`. The worker's jobs are `NotificationJobs` (`src/jobs/`): `notifications.dispatch` (stately queue, business id as `singletonKey`), `notifications.sweep` (every minute) and the `notification_due` wake-up (`pg_notify` in `notify()`'s transaction, `NotificationDueListener` in `src/database/`). Only `IN_APP` and `PUSH` channels until a phase needs SMS or email. Pushes go only to active personal devices with a token (`DevicesService.pushTargetsOf()`); phones set theirs with `PUT /v1/devices/me/push-token`.
- Worker tests: `startTestWorker(t.clock, { schedules: false, listen: false })` (`test/helpers/worker.ts`) builds the worker with the API test app's fake clock; its `push` is the `FakePushSender` (scripted answers per token, an outbox of every push with its answer, and `calledInsideTransaction`). The claim's two guards against a double claim are the status condition and the lease: a race test passes with either one removed (shown in F3).
- Events (F4): `NotificationEvents` (`src/modules/notifications/notification-events.ts`) holds who is told what: `saleFlagged` (from `SalesService.create()`, owners except the seller), `stockConverted` and `approvalUsed` (from `StockCommandsService.convert()`; `approvalUsed` also from `SalesService.void()`, never from `ApprovalsService.use()`, which runs before the conversion exists), `settlementVariance` (from the settlement close). Each is called after the command's audit row, in its transaction. In the command path a repeated command never re-runs (sync idempotency), so a mutation of the dedupe key is caught only by F2 test 1.
- Scheduled jobs (F5): `ScheduledJobs` (`src/jobs/scheduled-jobs.service.ts`, registered by `startWorker()`): `changelog.prune` 00:00 UTC (`ChangeFeedService.prune()`, exported by the sync module), `stock.integrity` 00:30 and `devices.stale` 04:00 (fan-outs: one job per business on a stately queue, 3 at a time, 5-minute expiry), `notifications.purge` 01:00 and `errors.purge` 01:10 (`RetentionMaintenance` in `src/database/`). Each job's work is a plain method tests call with the Clock. An integrity mismatch writes one `error_event` with `pools=<n>` and short ids (8 characters, `location:pack`) for as many pools as fit in 200 characters. `device.stale` dedupes on the device's last sync time (or `never`). pg-boss keeps schedules in `pgboss.schedule` (one row per name, key `''`), which `resetTables()` does not empty: a test that adds schedule rows must remove them.
- F6: the randomized notification workload (`test/f6-hardening.spec.ts`) runs seeds 1001, 2002 and 3003; replay one with `F6_SEED=<n> pnpm exec vitest run test/f6-hardening.spec.ts -t randomized`. Push fates come from `FakePushSender.decide` (tests only), set through `startTestWorker(..., { configurePush })` before the worker starts: jobs left queued by an earlier worker run at once. A dead token is gone for good, so a workload must let phones register a new one. The Phase F walkthrough is `docs/phase-f-walkthrough.md`, mirrored by `test/f6-walkthrough.spec.ts`; results in `docs/phase-f-results.md`.
- Reports (G1a): `ReportsModule` (`src/modules/reports/`) under `/v1/reports`. Dates: `from` and `to` are inclusive Nairobi days, converted by `src/common/time/nairobi.ts` (fixed UTC+3, Kenya has no daylight saving) to the half-open range `[from 00:00, to + 1 day 00:00)` Nairobi; SQL groups by `(occurred_at AT TIME ZONE 'Africa/Nairobi')::date`. Never group or filter by the UTC date. Each report is ONE SQL statement (CTEs, `ROLLUP` for the totals row, `UNION ALL` for side figures) so the timeout bounds it and every figure comes from one snapshot. `ReportsService.timed()` runs `set_config('statement_timeout', 8000, true)` first and turns SQLSTATE 57014 (`isQueryCanceled()`) into `503 REPORT_TOO_SLOW`.
- Prisma's interactive transactions end after 5 seconds by default (separate from `DATABASE_TX_MAX_WAIT_MS`), and the limit is only noticed at the next statement or the commit: a 6 second report that succeeded failed at commit with a 500 (G1a mutation 8b). Report routes get a 10 second transaction through `@TransactionTimeout(REPORT_TRANSACTION_TIMEOUT_MS)` (approved by Ian in G1a), read by `TenantInterceptor` and passed to `TenantRunner.run(id, fn, { timeoutMs })`. A test lists the routes that use the marker.
- Report rate limit (G1a): 30 a minute per member, checked by `ReportRateLimitGuard` (a controller guard, so it runs after the global `AuthGuard` and before the tenant transaction) with the plugin's own `fastify.createRateLimit()`, decorated as `reportRateLimit` in `configureApp()`. Route-level `config.rateLimit` runs before the token is checked and could only count per IP. The plugin's in-memory store returns one shared counter object: requests that arrive in the same tick all read the final count, so 31 concurrent requests are all refused (fail closed; the global limit behaves the same). Test bursts one after another.
- A slow report in a test: hold `LOCK TABLE sale IN ACCESS EXCLUSIVE MODE` on a migrator connection; the report's SELECT waits, and the wait counts towards `statement_timeout` (`test/g1a-reports.spec.ts` 7c and 7e).
- Test data for `pg`: pass jsonb values as `JSON.stringify(...)`; the driver sends a JavaScript array as a Postgres array (`22P02` before any check runs). A multi-statement `query()` returns an array of results.
- Access tokens expire while a test moves the fake clock (`TOKEN_EXPIRED`). Log the member in again by PIN on the same device (`relogin()` in `test/c5-approvals.spec.ts`). Staff PATCH answers 204.
- Change feed (D1): `change_log.txid` (xid8, filled by its default; the triggers never name it). `ChangeLogRepository.finishedAfter()` returns only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())` in `(txid, id)` order; never order by id alone or by `changed_at`. Positions are decimal text, never JavaScript numbers. The changes cursor is `ChangesCursor` (business id, position, costs). `change_log_prune()` (SECURITY DEFINER, owner policies) is the only delete; call it through `ChangeFeedService.prune()` / `ChangeLogMaintenance`. `change_log_horizon` holds the newest pruned position; `resetTables()` resets it.
- Snapshot (D2): `GET /v1/sync/snapshot` in `SyncController` / `SnapshotService`. The synced tables are entries in `SyncTables` (`src/modules/sync/sync-tables.ts`, order fixed in `SYNC_TABLE_NAMES`); each reads through its own module's `...PageForSync` service method. A new synced table is one entry plus its name. `start_cursor` must be taken before any row is read (a held-open-transaction test checks this).
- Changes (D3): `GET /v1/sync/changes` in `ChangesService`. `limit` counts log rows; collapsed changes sit at the record's first appearance; state is read now through `SyncTables.byIds` (a missing record is a delete). A held-open-transaction test is the only way to show the gap; a plain test passes with or without the finished-transactions condition.
- D4: the randomized sync check (`test/d4-hardening.spec.ts`) runs seeds 11, 22 and 33; replay one with `D4_SEED=<n> pnpm exec vitest run test/d4-hardening.spec.ts -t randomized`. The Phase D walkthrough is `docs/phase-d-walkthrough.md`, mirrored by `test/d4-walkthrough.spec.ts`.
- Sales schema (E1): `sale`, `sale_item`, `payment`, `sale_counter` (forced RLS, no DELETE for `app_user`). A voided sale is final through the restrictive `voided_is_final` policy (an UPDATE of it matches zero rows, no error). `SALE` movements must be negative and `SALE_VOID` positive with a `sale_id`; `sale_id` is optional on `SALE` only while the spike's sale-mode code is used. One original payment per M-Pesa code per business is the partial index `payment_mpesa_code_unique`. Column lists in the grants inventory follow the database's byte order (`void_note` before `voided_at`).
- `sale.create` (E2): `SalesService.create()` in `src/modules/sales/`. Write order: checks, `StockService.saleDecreases()` (lock order from `src/modules/stock/lock-order.ts`), `SalesRepository.nextSaleNumber()`, sale, items, `StockService.recordSaleMovements()`, audit. Money math uses `toCents`/`fromCents` (`src/common/money/cents.ts`, BigInt cents), never `Number`. Sales of one stock pool queue on its balance row lock, so a concurrency test of the counter (or anything after the stock statements) must spread sales over different pools, or it never races (found by E2 mutation 4).
- Payments (E3): `PaymentsModule` (`src/modules/payments/`) owns the `payment` table only; `SalesModule` imports it. Duplicate M-Pesa codes use `INSERT ... ON CONFLICT` on the partial index `payment_mpesa_code_unique` (the conflict target must repeat the index's `WHERE`), then read the original. `payment.attach` changes the sale with one conditional `UPDATE` (paid_total + x) before inserting payments. All `sale.create` commands of a business queue on `sale_counter`, so a race test of anything after the counter must use `payment.attach`, and should force the overlap with a held-open transaction plus `lockWaiters()` (`test/e3-payments.spec.ts`).
- Sales reads and sync (E4): `SalesReadsService` (`src/modules/sales/`) applies the visibility rule (without `sales.void`, only one's own sales) for `GET /v1/sales`, `GET /v1/sales/:id` and the `sale`, `sale_item`, `payment` sync tables. `SyncView` is `{ costs, allSales, membershipId }` (`syncView()` in `snapshot.service.ts`); the changes cursor binds `costs` and `all_sales`, and `ChangeFeedService` takes that `{ costs, allSales }` view. A `SyncTable` with `deletes: false` never sends delete markers. While a transaction is held open, `changes` hands out nothing committed after it, so a held-open test may only assert that changes are held back, then delivered.
- Devices since D1: `app_user` may update only `name`, `is_shared`, `status`, `last_seen_at`, `last_sync_at` (pinned in the B5 grants inventory). The sync stamp is `DevicesService.stampSync()` on `last_sync_at` (the A1 column), at most once every 5 minutes. Devices have no suspended status.
- C6: the randomized stock workload (`test/c6-hardening.spec.ts`) runs seeds 101, 202 and 303 on every run; replay one with `C6_SEED=<n> pnpm exec vitest run test/c6-hardening.spec.ts -t workload`. The Phase C walkthrough is `docs/phase-c-walkthrough.md`, mirrored by `test/c6-walkthrough.spec.ts`.
- `stock.count` (C3) is in the same module: `CountStockHandler`, `StockCommandsService.count()`, `StockService.count()`. Multi-line stock commands must sort with `inLockOrder()` in `stock-commands.service.ts`. Phase C test helpers for C3 on are in `test/helpers/stock-api.ts` (`stockApi(t, ip, phoneBase)`; give each file its own phone base).
- Audit metadata may nest objects and arrays since C2 (approved by Ian, for `lines`); the forbidden-key check runs at every level.
- Paging cursors: `SignedCursor` (`src/common/paging/signed-cursor.ts`, provided in each module that pages) signs `{ kind, values }`; callers check each value and compare the filters with the request. It replaced `ProductCursor` in C2, so older product cursors are refused once.
- Reads under test: rows inserted in one transaction share `created_at` (Postgres `now()` is the transaction start), so ordering them by `created_at, id` is random. Check their order through `change_log.id` (a BIGSERIAL), or compare them as a set (found in C2).
- Scratchpad scripts cannot import project packages (`pg`) by name. Use `createRequire(process.cwd() + '/package.json')('pg')` and run them from the project folder. There is no Python on this machine; use small Node scripts or the editor tools.
- Running `prisma format` re-aligns unrelated models and buries a schema change in a large diff. Do not run it before a review; `prisma validate` is enough.
- When a test run is filtered for display, save the full log first (`pnpm test 2>&1 | Out-File ...`). A filtered run once hid the only copy of an error.
- Machine memory: this PC has 8 GB RAM. With a 2 GB page file, Windows ran out of commit memory and Node, Prisma, tsc and the linter crashed at random (`0xC0000409`, exit 134). Fixed by a 6 GB page file (set by Ian) and `C:\Users\kyrex\.wslconfig` with `memory=2GB`. If random native crashes return, check: `Get-CimInstance Win32_OperatingSystem` FreeVirtualMemory.
- Docker Desktop's engine crashed once on start (WSL exit `0xc00000fd`) and recovered on retry. If `docker` commands fail with a 500 error, wait and retry, or restart Docker Desktop.
