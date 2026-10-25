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
| B. Catalogue | products, pack types, barcodes, search, locations |
| C. Stock | receive, adjust, convert, count handlers and stock reads |
| D. Sync | `/sync/commands`, `/sync/snapshot`, `/sync/changes` |
| E. Sales and payments | `sale.create`, payment attach, void and approve, manual M-Pesa matching, then Daraja |
| F. Worker | pg-boss, notifications, SMS and push integrations |
| G. Business features | subscriptions, website orders slot, reports, audit log, error events |
| H. Launch work | hosting, Linux container, load test, Sentry |

Rules for every phase:
- Before writing code, present the design for that phase (tables, endpoints, who can do what, what could go wrong) and wait for Ian's approval. Update `docs/architecture.md` when the design is approved.
- Every phase keeps the rules in section 5 and the layer rules in section 4. The patterns proven in the spike (see `docs/spike-results.md`, "Final patterns") are the way to do these things. Do not invent new ones without asking.
- Every phase ends with passing tests shown in the session and a commit.
- Open risks listed in `docs/spike-results.md` are handled in the phase where they first matter. Do not ignore them, and do not fix them early without asking.

Status: Phase A is now approved. Write Phase A code.

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
- A module never reads another module's tables. It calls the other module's service.
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
Run worker:             (to be added)
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
- Phone commands (spike step 3): `SyncService.processCommands(actor, commands)` in `src/modules/sync/`. A command type is a handler class implementing `CommandHandler` (type, permission, payload DTO, `handle()`), for example `src/modules/stock/commands/receive-stock.handler.ts`. A handler rejects by throwing `CommandRejectedError`; any other error is a crash and rolls the whole command back.
- Savepoints: `withSavepoint(fn)` in `src/database/tenant.ts`. Needed whenever a failure must be recorded in the same transaction: after a failed SQL statement Postgres aborts the transaction, and only `ROLLBACK TO SAVEPOINT` makes it usable again.
- Postgres error codes from Prisma 7: read them with `src/database/db-errors.ts`. The SQLSTATE is at `meta.driverAdapterError.cause.originalCode` for raw queries (Prisma code P2010) and model calls (P2003 and others) alike.
- Untrusted input is validated with `validateDto()` in `src/common/validation/validate-dto.ts` (class-validator: whitelist, forbid unknown properties, no type coercion).
- **Workflow rule for hand-written SQL (spike step 4):**
  1. Every RLS policy, grant, trigger, function, extension and special index lives in its own hand-written migration file, named after what it does.
  2. Read every generated migration before applying it. The migration guard test fails on any `DROP POLICY`, `ALTER POLICY`, `DROP`/`DISABLE TRIGGER`, `DROP FUNCTION`, `DROP EXTENSION`, `DISABLE`/`NO FORCE ROW LEVEL SECURITY`, or `DROP INDEX` of a hand-written index, unless the file has a `-- allow-destructive: <reason>` line. Never add that line without Ian's approval.
  3. An index Prisma can express (for example the GIN trigram index) must also be declared in `schema.prisma` with `map:` set to its real name, or Prisma generates a DROP for it in every migration. Add new hand-written index names to `HAND_WRITTEN_INDEXES` in `test/helpers/migration-guard.ts`.
  4. Prisma ignores policies, triggers, functions, extensions and partial indexes; it does not try to drop them.
  5. Every new table with `business_id` is checked by the RLS coverage test, so forgetting its RLS migration fails the build.
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
- When a test run is filtered for display, save the full log first (`pnpm test 2>&1 | Out-File ...`). A filtered run once hid the only copy of an error.
- Machine memory: this PC has 8 GB RAM. With a 2 GB page file, Windows ran out of commit memory and Node, Prisma, tsc and the linter crashed at random (`0xC0000409`, exit 134). Fixed by a 6 GB page file (set by Ian) and `C:\Users\kyrex\.wslconfig` with `memory=2GB`. If random native crashes return, check: `Get-CimInstance Win32_OperatingSystem` FreeVirtualMemory.
- Docker Desktop's engine crashed once on start (WSL exit `0xc00000fd`) and recovered on retry. If `docker` commands fail with a 500 error, wait and retry, or restart Docker Desktop.
