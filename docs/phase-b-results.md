# Phase B results

**Status: all five steps (B1 to B5) passed. Waiting for Ian's review.** Only Ian marks Phase B done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-b-walkthrough.md`.

**Final suite (end of phase, 3 runs in a row):** 3 runs done, all passed, on the commit that adds this summary. Run 1: 19 files, 269 of 269 (201.4 s). Run 2: 19 files, 269 of 269 (175.4 s). Run 3: 19 files, 269 of 269 (175.6 s). Lint, type-check, build and the drift check were clean before the runs. Earlier failed runs during Phase B are recorded in their step sections below, as observed.

## Summary

| Step | What it built | New tests | Phase B cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| B1 | Catalogue schema, triggers, default location, location endpoints, `locations.manage` | 11 | 11 | Default-then-drop for new NOT NULL columns; `REVOKE DELETE ON product` (approved); `change_log.row_key` for barcodes |
| B2 | `@OwnTransactions()`, `POST /v1/sync/commands`, `product.create`, `product.update`, `pack_type.upsert` | 21 | 32 | Constraint name read from Prisma 7's error (probe); three barcode tests fixed for a wrong 13-digit example |
| B3 | `barcode.add`, `barcode.remove`, `GET /products/by-barcode/:code` | 8 | 40 | Test speed-ups (scrypt cost and `synchronous_commit`, test only); A4's race test made deterministic |
| B4 | Listing, search, by-id, signed cursor | 9 | 49 | Trigram index unusable under RLS (wording corrected); `name_lower` generated column (option B) after a flaky speed test |
| B5 | Hardening tests, grants inventory, log checks, walkthrough | 8 | 57 | Test app pool wait 10 s (approved) after a pool timeout under heavy CPU load |

Phase B also added 4 tests outside the Phase B files (`test/password-hasher.spec.ts`, the production-cost guard for the test speed-up). The full suite went from 240 (before B3) to the count shown above.

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Per-command transactions | `@OwnTransactions()` on `POST /v1/sync/commands` only (a test enforces it): the session is checked in a short tenant transaction, then each command gets its own tenant transaction with the spike's claim, savepoint and store core | `src/common/auth/own-transactions.decorator.ts`, `src/modules/auth/tenant.interceptor.ts`, `src/modules/sync/sync.service.ts` |
| Dispatcher order | Envelope, unknown type, type permission, `occurred_at` (not more than 24 h ahead), payload, payload-dependent permissions (`costs.view` for any `cost_price`), handler in a savepoint. `FAILED` logged by id, type and error name only | `src/modules/sync/sync.service.ts`, `sync.controller.ts` |
| Conflicts | Rules checked in code first for clear reasons; unique violations mapped by constraint name (`uniqueViolationConstraint()`, Prisma 7: `meta.driverAdapterError.cause.constraint.index`) | `src/database/db-errors.ts`, `src/modules/products/products.service.ts` |
| Ordering of changes | Every product or pack type change locks the product row; a units change also locks the pack type row, so no stock movement can appear between the `UNITS_LOCKED` check and the update | `products.repository.ts`, `pack-types.repository.ts` |
| Idempotent barcode add | `INSERT ... ON CONFLICT (business_id, barcode) DO NOTHING RETURNING id`, then a fresh read: same pack type is a no-op, otherwise `BARCODE_TAKEN` | `barcodes.repository.ts` |
| Barcode normalisation | Trim; a 12-digit numeric code gets a leading 0; `^[A-Za-z0-9._-]{4,48}$`; no check digits; case kept. Applied on every write and lookup | `src/modules/products/barcode.ts` |
| Money | Strings matching `^\d{1,12}(\.\d{1,2})?$`, normalised by string work (`normalizeMoney`), `NUMERIC(14,2)` in the database, read back as `numeric::text`; never a JavaScript number | `src/common/validation/money.ts`, `pack-types.repository.ts` |
| Search | One parameterised SQL: barcode (rank 0), SKU (1), name prefix (2), name contains (3), on `name_lower LIKE lower(pattern) ESCAPE '\'` with `%`, `_`, `\` escaped; RLS on every table | `products.repository.ts` (`search`) |
| Listing | Keyset on `(name, id)` through `product_business_id_name_id_idx`; two statements so the row comparison stays an index condition; cursor signed with HMAC-SHA256 (key from `AUTH_PEPPER`) and bound to `include_archived` | `products.repository.ts` (`page`), `product-cursor.ts` |
| Cost price | The `cost_price` key is absent (not null) without `costs.view`, on every read | `src/modules/products/product-view.ts` |
| Generated column | Hand-written `GENERATED ALWAYS ... STORED`, declared in Prisma as `@default(dbgenerated(...)) @ignore` so Prisma neither drops it nor exposes it | `*_b4_product_name_lower`, `schema.prisma` |

## Proof the tests catch mistakes

Each was applied temporarily, the named test failed, and the change was reverted and checked (backups compared byte for byte, or the database function's md5 compared).

| Design mutation | Test that failed | What it caught |
|---|---|---|
| 1. `cost_price` returned regardless of permission | B4 test 4 | an attendant saw the `cost_price` key |
| 2. Check-then-insert for barcodes | B3 test 3 | only 10 of 19 concurrent losers got `BARCODE_TAKEN`; the rest crashed into the unique index |
| 3. `%` and `_` not escaped | B4 test 2 | `0%` also matched "500 grams rice" |
| 4. `UNITS_LOCKED` check removed | B2 test 11 | a units change was `ACCEPTED` after a stock movement |
| 5. Barcode delete not logged by the trigger | B3 test 4 and B5 test 1 | the `DELETE` row was missing from `change_log` |
| 6. Plain key on `pack_type_id` instead of the composite key | B1 test 2 | a barcode was accepted on another product's pack type |
| 7. `archived_at IS NULL` dropped from search | B4 test 3 | the archived product appeared |

## Versions

Unchanged since Phase A (`docs/phase-a-results.md`). No library was added in Phase B.

## Things to know

1. **Exact inventories must be updated on purpose:** the RLS table list, the trigger and function list and `HAND_WRITTEN_INDEXES` (`test/step4-migrations.spec.ts`), and now the grants inventory (`test/b5-hardening.spec.ts`). Forgetting one fails the build; updating it is expected, never a weakening.
2. **Under RLS, `LIKE`/`ILIKE` cannot use an index** (they are not leakproof): a search filters the caller's own business rows. Keep that filter cheap (`name_lower`), and measure as `app_user`, never as the superuser.
3. **Faster test hashing changed race timing.** A race test that relied on slow hashing to keep two requests overlapping stopped testing the race; it now forces the overlap. Never widen such an assertion to "either answer".
4. **This machine is noisy under load** (2 cores; the same query varied 3 times between runs; one gate took six times its normal time). Leave clear margins under time bounds, and make timing tests write their measurements before asserting.
5. **Barcode examples: count the digits.** Only a 12-digit code gets a leading zero.
6. **Reverting a mutation on a file that is not in git yet:** `git checkout` fails quietly; restore from a copy and compare.
7. **A generated column needs both `dbgenerated(...)` and `@ignore`** in `schema.prisma`, or Prisma generates a `DROP COLUMN` or a failing `DROP DEFAULT`.
8. **Run real-API checks against the test database**, so the dev database stays clean for Ian's walkthroughs.

## Open risks

Roughly in order of how soon they matter.

1. **Carton barcodes** (design open item 1): if a real carton shows the same number as its pieces, one barcode must map to several pack types of one product, and the app must ask "piece or carton?". Ian checks a real carton.
2. **Overload answers 500** (architecture open item 30): a burst bigger than the pool fails the whole request with `500 INTERNAL_ERROR` when no connection frees up within `DATABASE_TX_MAX_WAIT_MS` (2 s in production). It should be `503` with `Retry-After`. Decide with the production pool size and a load test (spike risk 4).
3. **Error codes hidden in logs** (architecture open item 31): redacting the field name `code` also hides Prisma error codes. Log them as `errorCode`.
4. **Search cost grows with one shop's product count** (about 8 ms of database time at 20,000 products here). No index helps under RLS; revisit well past 100,000 products in one shop.
5. **Accepted `ALREADY_EXISTS` leak:** a command with a product or pack type id that exists in another business reveals that the random id exists somewhere (decided in B2).
6. **Commands that always crash are retried forever** (spike risk 7): still open; `FAILED` is not stored.
7. **An `occurred_at` more than 24 hours ahead is a stored rejection:** a phone with a badly wrong clock must resend under a new command id after fixing it.
8. **Cost prices sit in audit metadata:** any future audit read endpoint must hide them from anyone without `costs.view` (design section 8).
9. **The production pool size and wait** are still unmeasured (spike risk 4); the test app's 10 s wait says nothing about production.
10. **Docker Desktop crashed once during B2** (and once in the spike); a full run lost to it was repeated, and recorded.

## The search plan and timings

See "B4: Search and listing" below: the probe that found the trigram index unusable under RLS, the flaky `ILIKE` runs, the comparison of five ways to match, the two series of five runs with `name_lower`, and the recorded `EXPLAIN` plan.

## Changes to the other documents

- `docs/phase-b-design.md`: section 12 holds Ian's new testing method (from B3); section 6 item 2 corrected about the trigram index and records `name_lower` (approved in B4).
- `docs/architecture.md`: sections 5 (commands, the endpoint, the route marker, as built in B2), 7 (barcodes and search, as built in B3 and B4), 12 (catalogue tables and columns, `row_key`, no product deletes), 13 (location and catalogue endpoints), 14 (`locations.manage`), 16 (open items 21 to 31).
- `CLAUDE.md`: section 2 phase table (B gains `POST /sync/commands`, D keeps snapshot and changes); section 8 notes on the sync endpoint and handlers, constraint names, inventories, NOT NULL columns, generated columns, RLS and `LIKE`, the test speed-ups, the race-test lesson, the testing method, timing tests, mutation reverts, barcode test data, the test pool wait, the grants inventory and real-API runs.

# Step details

## B1: Schema, triggers, locations (passed)

**Result:** 11 new tests in `test/b1-catalogue.spec.ts` pass, covering design section 12 B1 tests 2 to 8 (test 1, RLS coverage with `product_barcode`, is in `test/step4-migrations.spec.ts`), plus the cross-business delete check moved from spike step 1. The B1 file passed ten runs in a row (11 of 11 each). The full suite, 13 files, passed **219 of 219 twice in a row** (about 345 s each), with lint, type-check, build and the drift check clean.

**Built (approved by Ian on 2026-10-25):**
- Seven migrations. `*_b1_catalogue_columns` (generated, with the default-then-drop edit for `sell_price`, `occurred_at` and `received_at`); `*_b1_catalogue_checks` (trimmed product name of 1 to 120 characters, non-negative prices, at most 10000 units, barcode format, one default location per business); `*_b1_product_barcode_rls`; one trigger migration each for `pack_type`, `location` and `product_barcode`; `*_b1_product_no_delete` (`REVOKE DELETE ON product FROM app_user`).
- `product_barcode` with a composite key to `pack_type (business_id, product_id, id)`, so a barcode can never point at another product's pack type. `app_user` has SELECT, INSERT and DELETE (no UPDATE).
- `change_log.row_key`: the barcode trigger stores the barcode text, so phones can remove a barcode they only know by code.
- `sync_command.occurred_at` and `received_at`: the spike's command envelope now requires `occurredAt` (ISO), and `received_at` comes from the Clock. The envelope's final shape and the 24-hour rule come in B2.
- Signup creates the default location "Main shop" in the signup transaction (`LocationsService.createDefault`), with a `location.created` audit row.
- `GET /v1/locations` (any active member; `include_archived=true` shows archived ones), `POST /v1/locations` and `PATCH /v1/locations/:id` (rename, archive, restore) with `locations.manage`. The new permission is in the owner preset and on the owner-only-to-grant list. Errors: `LOCATION_NOT_FOUND` (the same for another business's id and a missing one), `LOCATION_IS_DEFAULT`, `LAST_ACTIVE_LOCATION`, `VALIDATION_FAILED`. Archiving is one conditional statement. Audit: `location.created`, `location.updated` (name before and after), `location.archived`, `location.restored`.

**Choices I made that the design left open (tell me if any is wrong):**
- Location names: 1 to 60 characters after trimming, not unique.
- `include_archived=true` is allowed for every active member (the design calls it "the owner list"). Archived location names are not sensitive.
- Archiving the default location answers `422 LOCATION_IS_DEFAULT`; the design names no code for it.

**Spike code and tests changed by B1:**
- `ProductsRepository.remove()` is gone (products cannot be deleted). Spike step 1 test 3 now asserts the delete is refused outright (`permission denied`), which is stronger; the "another business's delete affects zero rows" check moved to `product_barcode`.
- The step 4 trigger test checks product inserts and updates, then a barcode insert and delete (with `row_key`); the product delete check became "refused".
- The step 4 inventories (RLS tables, triggers, functions, hand-written indexes) list the B1 objects, still as exact lists. `seedShop` now writes four `change_log` rows (location, product and two pack types), and the two tests that counted one row expect four.
- `seedShop` and the step 4 pack types have a sell price; step 3 commands carry `occurredAt`.
- A5's signup audit test expects exactly the rows signup writes; it now includes `location.created` (and checks its actor and IP). Found by the first full-suite run, which failed only that test, twice; the full suite was run twice again after the fix.

**Proof the tests catch mistakes:**
- Design mutation 6, the composite barcode key replaced by a plain key on `pack_type_id` (test database only): B1 test 2 failed ("promise resolved instead of rejecting": a barcode was accepted on another product's pack type). The composite key was restored and checked identical to the migration.
- The shadow-database probe before approval showed each new constraint refusing bad data by name, `app_user` unable to update barcodes or delete locations, the barcode delete row carrying its code, no log row after a rollback, and zero rows everywhere without a tenant.

**Things to know:**
1. The new unique `(business_id, product_id, units_per_pack)` also refuses a second base unit, so two constraints now guard that rule. B2 must map either constraint name to `BASE_UNIT_DUPLICATE` when the units are 1, and to `PACK_UNITS_DUPLICATE` otherwise. Which one Postgres reports first is not something to rely on.
2. Every new tenant table, trigger, trigger function and hand-written index must be added to the exact inventories in `test/step4-migrations.spec.ts` (forgotten for `audit_log` in A5, done on purpose here).
3. Businesses created before Phase B (only in tests) have no default location; `LAST_ACTIVE_LOCATION` protects them. No backfill was written, as the design says.

**Open for later steps:**
- The real command envelope (`command_id`, `occurred_at`, snake_case) and `OCCURRED_AT_INVALID` (B2).
- The step 4 RLS coverage test does not yet check grants per table. `app_user`'s DELETE on `product` was found by reading the old migration, not by a test. A grants inventory test would be a good addition in B5.

## B2: Command endpoint and catalogue commands (passed)

**Result:** 21 new tests in `test/b2-commands.spec.ts` pass, covering design section 12 B2 tests 1 to 14, plus a test that only `POST /v1/sync/commands` carries the route marker and one for the audit key exception. No migration was needed. The B2 file passed ten runs in a row (21 of 21 each). The full suite, 14 files, passed **240 of 240 twice in a row** (about 268 s each), with lint, type-check, build and the drift check clean. An earlier second full run was lost to a Docker Desktop crash (the database disappeared mid-run: 154 connection and timeout failures); after a restart and Postgres crash recovery, both fresh runs passed.

**Built (approved by Ian on 2026-10-25, with all five recommended answers):**
- `@OwnTransactions()` and its branch in `TenantInterceptor`: the session is checked in a short tenant transaction (a suspended member gets `403 MEMBERSHIP_INACTIVE` before any command runs), then the handler runs outside any transaction.
- `POST /v1/sync/commands` (`SyncController`, `SyncModule`): 1 to 100 commands, explicit 1 MiB body limit (`413 PAYLOAD_TOO_LARGE`), snake_case envelope, results in request order as `{ command_id, status, reason?, message?, result? }`. The spike's claim, savepoint and store core is unchanged. New checks: `UNKNOWN_COMMAND_TYPE`, `OCCURRED_AT_INVALID` (more than 24 hours ahead, by the Clock), and payload-dependent permissions (`costs.view` for any `cost_price`, including `null`). A `FAILED` command is logged as id, type and error name only.
- `product.create`, `product.update` and `pack_type.upsert` handlers (`src/modules/products/commands/`), with the rules in `ProductsService`. Rules are checked in code first; database conflicts are mapped by constraint name as the backstop. Money uses strings only (`MONEY_PATTERN`, `normalizeMoney`). Barcode normalisation (`normalizeBarcode`) is built for `product.create`. The product row is locked for every product or pack type change; the pack type row is locked before the `UNITS_LOCKED` check.
- `StockService.hasMovements()` and a minimal `StockModule`, so the units lock asks the stock module instead of reading its table.
- `uniqueViolationConstraint()` in `src/database/db-errors.ts`. A probe showed that Prisma 7 puts the name at `meta.driverAdapterError.cause.constraint.index`, for model calls (P2002) and raw SQL (P2010) alike.
- Audit: `product.created`, `product.updated` (name and SKU before and after), `product.archived`, `product.restored`, `pack_type.created`, `pack_type.updated` (before and after for each changed field), `barcode.added`. `AuditService` now allows exactly the keys `barcode` and `barcodes`.

**The five decisions:** `barcode.add` and `barcode.remove` move to B3; `PACK_LIMIT_REACHED` counts active pack types only; `barcode`/`barcodes` are allowed audit keys; reason and result names are mapped in the controller only; the `ALREADY_EXISTS` leak for ids from another business is accepted (risk below).

**Spike code and tests changed by B2:** the envelope is snake_case and `SyncActor` has `membershipId`; `SyncService` takes its handler list instead of the two stock handlers; step 3 and B1 test 4 were updated mechanically. The step 3 crash test also expects the new internal `failure` field (type and error name), which the controller never sends.

**Proof the tests catch mistakes:**
- Design mutation 4, the `UNITS_LOCKED` check removed: B2 test 11 failed (a units change was `ACCEPTED` after a stock movement). `products.service.ts` is not in git yet, so it was restored from a backup and checked identical with `cmp`.
- My own test slip: three barcode tests first failed because the example `6161101560029` has 13 digits, not 12, so it correctly got no leading zero. The tests now use the 12-digit UPC-A `036000291452`, stored as `0036000291452`. The code was right.

**Things to know:**
1. A second base unit is reported by `pack_type_one_base_unit_per_product` (seen in the probe), not by the units unique. Both are mapped to `BASE_UNIT_DUPLICATE`.
2. The design says every product, pack type and barcode read is limited to the caller's business; B2 has no reads yet (B4). Tests read stored values as the superuser.
3. Cost prices appear in `pack_type.created` and `pack_type.updated` audit metadata. A future audit read endpoint must hide them from anyone without `costs.view` (design section 8).

**Open risks from B2:**
- **Accepted:** a command with a product or pack type id that exists in another business answers `ALREADY_EXISTS` instead of being created, which reveals that the id exists somewhere. Ids are random UUIDs and are never shown across businesses, so they cannot be guessed; per-business primary keys would be the only full fix.
- An occurred_at more than 24 hours ahead is stored as a rejection, so a phone with a badly wrong clock must resend under a new command id after fixing it.

## Test speed-ups and the new testing method (approved by Ian before B3)

**Method:** `docs/phase-b-design.md` section 12 now holds Ian's testing method (commit `cc6fe43`). Baseline before it: the full suite was 240 of 240.

**Measured** (one full run each, Vitest JSON reporter, same machine):

| | Before | After |
|---|---|---|
| Suite wall time | 267.2 s | 160.7 s |
| Sum of test files | 212.1 s | 104.3 s |
| a3-login | 43.4 s | 11.5 s |
| a5-audit | 34.8 s | 8.6 s |
| a4-staff | 27.4 s | 9.2 s |
| b2-commands | 26.4 s | 11.0 s |
| a2-signup | 15.6 s | 5.7 s |
| b1-catalogue | 11.7 s | 4.1 s |
| step2-stock | 28.7 s | 30.6 s (database-bound, unchanged) |

The scrypt benchmark: 372.9 ms per hash at the production cost, 3.9 ms at the test cost.

**Applied:**
1. `test/helpers/fast-password-hasher.ts`: the production hasher with scrypt N=2^10, p=1, used only by `startTestApp`. In `src/` the only change is that the cost moved from a module constant into a protected field; production has no setting for it. `test/password-hasher.spec.ts` (4 tests) proves the app built by `createApp()` uses exactly `PasswordHasher` and stores `scrypt$32768$8$3$`.
2. `synchronous_commit = off` on `aberdare_test` only, set by the test global setup, which refuses a database not ending in `_test`. Checked after the run: `off` in `aberdare_test`, `on` in `aberdare`.

**Not applied:** `fsync=off` (dev and test share one container, so it would risk corrupting the dev database on a crash); fewer repeats in spike step 2 (that would weaken a spike proof).

**A real finding from the faster run:** the after-run failed one test (243 of 244). A4's "two concurrent activations with the same setup token" expected the loser to be refused at the atomic invite claim (401). With fast hashing, one request could now finish before the other checked the SMS code, so the loser was refused at the code check instead (400), and the test no longer exercised the claim race at all. The test now holds both requests at the PIN hash until both have arrived, so they always meet at the claim; the exact `[200, 401]` assertion is unchanged, and it passed 5 runs in a row. Slow hashing had been keeping that race alive by luck.

## B3: Barcodes and lookup (passed)

**Result:** new 8, Phase B cumulative 40 (B1 11, B2 21, B3 8), all passing in one gate run. The concurrency test (20 concurrent adds of one code) passed 5 runs in a row. The full suite then passed once: 16 files, 252 of 252 (155.7 s), with lint, build and the drift check clean (240 baseline + 4 production-cost hasher tests + 8 B3 tests).

**Built (approved by Ian on 2026-10-25, with the recommended answers):**
- `barcode.add` and `barcode.remove` handlers, registered in `CatalogueHandlers` (the endpoint now accepts all five catalogue commands).
- `barcode.add`: normalise (invalid is `VALIDATION_FAILED`), lock the product (`PRODUCT_NOT_FOUND`), check the pack type belongs to it (`PACK_TYPE_NOT_FOUND`), then `INSERT ... ON CONFLICT DO NOTHING RETURNING id` and, if nothing was inserted, a fresh read: the same pack type is an accepted no-op, otherwise `BARCODE_TAKEN`. Allowed on archived products and pack types. Audit `barcode.added`, not for a no-op.
- `barcode.remove`: normalise, one `DELETE ... RETURNING`; a missing code is an accepted no-op. Audit `barcode.removed`; the trigger logs the delete with `row_key`.
- `GET /v1/products/by-barcode/:code` (`ProductsController`, any active member): `{ pack_type_id, product }`, prices with two decimals, `cost_price` key absent without `costs.view`. Unknown, malformed and other businesses' codes: the same `404 BARCODE_NOT_FOUND`. The product view (`product-view.ts`, `ProductsService.view`) is ready for B4.

**Proof the tests catch mistakes:**
- Design mutation 2, check-then-insert in `barcode.add`: B3 test 3 (concurrent adds) failed. Only 10 of the 19 losers got `BARCODE_TAKEN`; the rest hit the unique index and crashed. Restored from a backup and checked identical.
- Design mutation 5, the barcode trigger without its delete (test database only): B3 test 4 failed (no `DELETE` row in `change_log`). The function was restored from its migration and its definition checked identical (md5 before and after). B5 test 1 will be checked against the same mutation in B5.

**Things to know:**
1. The lookup normalises the code the same way as writes, so a 12-digit scan finds a code stored as 13 digits. Case is not changed: `ABC-123` and `abc-123` are different codes.
2. Codes never reach a log line: the request log records the route pattern, not the URL (checked in B3 test 6).

## B4: Search and listing (passed)

**Result:** new 9, Phase B cumulative 49 (B1 11, B2 21, B3 8, B4 9), all passing in one gate run. The speed test (test 8) passed 5 runs in a row in its final form. Lint, build and the drift check were clean. The first full-suite run **failed one test** (260 of 261): A1's "text keys: phone and email lookups" timed out (7.1 s against its usual 1.2 s). The whole A1 file was slow in that run (56 s, usually 10.5 s), and was just as slow run alone right afterwards (76.5 s, the same timeout), every test about 8 to 12 times slower, so it was not test order and not B4 code. Connections (about 17 ms), the table wipe (about 80 ms), open sessions and free memory were all normal when checked. A few minutes later A1 alone passed 32 of 32 in 12.2 s with no code change. The cause was not identified; it looks like a temporary slowdown of the machine. A second full run then passed: 17 files, 261 of 261 (181.8 s).

**Built (approved by Ian on 2026-10-25, with the four recommended answers and option B):**
- `GET /v1/products`: a keyset-paged listing in `(name, id)` order with `next_cursor`, or, with `q`, a search (exact barcode, exact SKU, names starting with `q`, other names containing `q`; by name within each group; at most 50; no paging). `limit` defaults to 20 and is capped at 50; `q` is 2 to 100 characters with no control characters (a NUL would otherwise be a 500).
- `GET /v1/products/:id`: the same 404 `PRODUCT_NOT_FOUND` for another business's id, a missing one and a non-UUID.
- Signed cursor (`ProductCursor`): base64url JSON of the last name and id plus `include_archived`, with an HMAC-SHA256 keyed from `AUTH_PEPPER`. Tampered, truncated or forged cursors, a cursor reused with another `include_archived`, and a cursor with `q` are all `422`.
- Product views are built in a batch: 3 queries for a whole page (products, pack types, barcodes), shared with by-barcode.
- `business_id` as a query parameter is `422`; as a header it is ignored (the response is identical).
- Migration `*_b4_product_name_lower` (option B): `product.name_lower`, `GENERATED ALWAYS AS (lower(name)) STORED`, declared in `schema.prisma` with `@default(dbgenerated("lower(name)"))` and `@ignore` (without them Prisma would generate a `DROP COLUMN` or a failing `DROP DEFAULT`). The name match is `name_lower LIKE lower(pattern) ESCAPE '\'`.

**The trigram index and the search speed (design section 12, B4 test 8):**
1. Before building, a shadow-database probe (20,000 products, as `app_user`) showed the trigram index `product_name_trgm_idx` is **not used** under RLS: `ILIKE` and `LIKE` are not leakproof, so Postgres applies them as a filter after the RLS condition, through `product_business_id_idx`. That probe measured 23 ms for `name ILIKE`. The design and architecture wording were corrected (approved).
2. With `name ILIKE`, the speed test was **flaky**. One run passed (median 154.4 ms), then a series of 5 gave: run 1 **failed** (median 200.53 ms against the bound of 200), runs 2 to 5 passed with medians 183.5, 165.4, 180.9, 191.0 ms. The database part alone varied from 74 to 200 ms between runs. The bound was not raised.
3. A shadow-database comparison of 5 ways to match, 20,000 products, median of 5: `name ILIKE` 108.5 ms; `name COLLATE "C" ILIKE` 36.6 ms (wrong for non-ASCII letters); `lower(name) LIKE` 58.9 ms; a stored lowercase copy with `LIKE` 18.0 ms (the same 100 rows as `ILIKE`). Ian chose the stored copy (option B).
4. With `name_lower`, the first series of 5 gave: run 1 **failed** (median 390.1 ms; that run recorded nothing else, because the report was written after the assertion), runs 2 to 5 passed with medians 34.3, 36.0, 34.0, 32.5 ms. The test was then changed to write its measurements **before** asserting (the 200 ms check itself is unchanged), and a second series of 5 **all passed**: medians 34.2, 37.6, 32.9, 33.1, 32.7 ms; slowest single call 82.9 ms; database execution 7.2 to 8.5 ms.
5. The 390 ms run is not explained by the query, which runs in about 8 ms. In the second series some single calls right after the warm-up took 76 to 83 ms, which points at the machine (a 2-core laptop also running Docker, Node and Vitest), not at Postgres.

The plan recorded by test 8 (as `app_user`, 20,000 products, second series run 1):

```
Limit (actual time=7.154..7.162 rows=50.00 loops=1)
  ->  Sort (actual time=7.153..7.156 rows=50.00 loops=1)
        Sort Key: name, id
        ->  Index Scan using product_business_id_idx on product (actual time=0.106..6.980 rows=100.00 loops=1)
              Index Cond: (business_id = (NULLIF(current_setting('app.business_id'::text, true), ''::text))::uuid)
              Filter: ((archived_at IS NULL) AND (name_lower ~~ '%maize%'::text))
              Rows Removed by Filter: 19900
Execution Time: 7.235 ms
```

The trigram index was not used; the test asserts that, so a future plan change is noticed.

**Proof the tests catch mistakes** (each restored from a backup and checked identical, no markers left):
- Design mutation 1, `cost_price` returned regardless of permission: B4 test 4 failed (an attendant saw the `cost_price` key).
- Design mutation 3, `%` and `_` not escaped: B4 test 2 failed (`0%` also matched "500 grams rice").
- Design mutation 7, `archived_at IS NULL` dropped from search: B4 test 3 failed (the archived product appeared).

**Things to know:**
1. Search cost grows with one business's product count (about 8 ms of database time at 20,000 here). No index can help under RLS; revisit if a single shop goes well past 100,000 products.
2. `name_lower` is maintained by Postgres; nothing can write it (checked by a test, which also checks a rename is searchable at once). Non-ASCII letters fold the same way on both sides ("ÉLAN" finds "Café Élan").
3. Seeding 20,000 rows through the change_log trigger takes about 20 s, longer than Prisma's 5-second transaction limit; test 8 seeds over a plain `app_user` connection instead (still RLS and the trigger).

## B5: Hardening and handover (passed)

**Result:** new 8 (`test/b5-hardening.spec.ts` 7, `test/b5-walkthrough.spec.ts` 1), Phase B cumulative 57 (B1 11, B2 21, B3 8, B4 9, B5 8), all passing in one gate run after the pool-wait change below. The end-of-phase full runs are at the top of this file.

**Built (approved by Ian on 2026-10-26, with the four recommended answers):**
- B5 test 1, `change_log` coverage: inserts and updates through the real paths for `product`, `pack_type`, `location` and `product_barcode`, asserted row by row; the barcode delete row carries the code in `row_key`; `app_user` is refused DELETE on `product`, `pack_type` and `location`, and the trigger's delete branch is proven by a rolled-back delete as `migrator`; a crash after each kind of write leaves no `change_log` row.
- B5 test 2, audit: one scenario writes all 12 actions of design section 8 exactly once, each by the acting member; a crash right after the audit insert leaves no audit row and no data change, for all five command types and both location writes.
- B5 test 3, logs: an accepted, a rejected and a `FAILED` command, a 500 on the sync route whose error message quotes the data, a search, a scan and a token refresh. The raw log of the whole file contains no product name, SKU, price, cost price, barcode, search text, access token or refresh token; the one `sync command failed` line carries only the command id, type and error name.
- Grants inventory (approved addition): `app_user`'s exact privileges on all 18 tables (including none on `otp_challenge`, `person` beyond six columns and `_prisma_migrations`), the column grants on `business` and `person`, and nothing granted to PUBLIC.
- B5 test 4, the walkthrough: `docs/phase-b-walkthrough.md` (curl, design section 13's ten steps) and `test/b5-walkthrough.spec.ts`, which runs the same steps with the same values and the dev fixed codes switched on, so the document is checked on every test run. No Bruno collection (decided).
- One real curl run of the walkthrough against the built API (`node dist/main`, port 3100) pointed at the test database, so the dev database stays clean for Ian. All ten steps answered as documented (for example step 7: `piece=150.00, carton of 24=null` for the owner, `PERMISSION_DENIED` for the manager; step 10: each business scans the same code to its own carton). The server's own log (98 lines) contained none of the names, prices, barcodes, tokens, phones, emails or codes (one match for "150" was inside a timestamp of a startup line).

**Proof the tests catch mistakes:**
- Design mutation 5 again, now against B5 test 1 (as the design requires): the barcode trigger without its delete made B5 test 1 fail (the `DELETE` row was missing). The function was restored from its migration and its definition checked identical (md5 before and after).

**The first gate run failed (recorded as observed):** 56 of 57 passed; B3's "20 concurrent adds" got a whole-request `500` (412 s for the gate, about six times the normal time). A temporary probe (a pool of 2 and a 100 ms wait, deleted afterwards) reproduced it: 19 of 20 requests answered `500`, each logged as a Prisma error thrown while starting a transaction. That is spike open risk 4: the test app waited Prisma's default 2 s for one of 10 pooled connections, and other programs kept the CPU about 77 to 80% busy. After Ian closed other programs the test passed 5 of 5 unchanged; the CPU still read 69 to 77% busy with only Claude and Docker open. With Ian's approval the test app now waits up to 10 s for a connection (production keeps 2 s), as spike step 1 test 5 already did; no assertion changed. The gate then passed 57 of 57.

**Two findings recorded as open risks** (architecture open items 30 and 31): overload answers `500` instead of `503`; and the log redaction of the field name `code` also hides harmless error codes (the probe's Prisma code was logged as `[REDACTED]`).
