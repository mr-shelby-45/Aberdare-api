# Phase B design: Catalogue

Status: approved by Ian on 2026-10-25 (all six questions answered with the recommended defaults). This file is the source of truth for Phase B. Where it disagrees with `docs/architecture.md` or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 16). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md` and `docs/phase-a-results.md` ("Final patterns" and "Things to know" in both). The patterns proven there are the way to do things. Do not invent new ones.

Phase B builds on Phase A. Do not start until Ian has marked Phase A done in `CLAUDE.md` section 2.

## 1. Goal and scope

A business has locations, products, pack types with prices, and barcodes, and staff can find products by search or by scanning. The phone creates and changes catalogue data through commands (offline first). The server answers reads. No stock quantities (Phase C).

In scope:
- Locations (default location at signup, owner can add, rename, archive).
- Products and pack types (piece, carton, and so on) with sell price and cost price.
- Barcodes: register, remove, look up by scanning.
- Server search and listing, scoped to the caller's business.
- `POST /v1/sync/commands`, pulled forward from Phase D, with the five catalogue commands.
- `change_log` triggers and audit rows for everything above.

Out of scope (do not build): stock quantities or movements, images, categories, brands, variants, bulk import, label printing, reorder levels, price tiers or discounts, per-location prices, tax fields, restricting staff to locations, snapshot and changes endpoints (Phase D), anything in Phases C to H. Business type (retail, wholesale, warehouse) changes nothing in the catalogue backend.

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Carton barcodes | One barcode maps to exactly one pack type per business. Assumes cartons have their own code. If Ian finds cartons that show the same number as the pieces, this rule changes (section 17, item 1). |
| Staff and locations | Every active member may work at every location. No per-location restriction. |
| Sync endpoint | `POST /v1/sync/commands` is built in this phase. Phase D adds snapshot and changes only. |
| Cost price | Reading and writing a cost price needs `costs.view` (owner only today, grantable). |
| Categories | Not now. |
| Bulk import | Not now. |
| Scope of every read | Every product, pack type, barcode and location read, including list and search, is limited to the caller's own business, through RLS. There is no business parameter anywhere. |
| Money | `NUMERIC(14,2)` in the database, strings in JSON (`"180.00"`), never JavaScript numbers. |
| Deletes | Products, pack types and locations are archived, never hard deleted. Barcodes can be removed, and the removal is logged. |

## 3. Data model

Same rules as Phase A section 4: every tenant table has `id`, `business_id`, `created_at`, forced RLS with the `shop_only` NULLIF policy, composite foreign keys `(business_id, x_id)`, unique `(business_id, id)`, explicit grants. Claude Code proposes the exact Prisma schema and SQL for each step and waits for approval before applying. Check what already exists in `schema.prisma` first (the spike and Phase A created `location`, `product`, `pack_type`, `change_log`, `sync_command`); change only what is listed here.

**location** (exists)
- Add `is_default boolean`, `archived_at timestamptz null`. Partial unique index: one default per business (hand-written SQL).
- `app_user`: SELECT, INSERT, UPDATE. No DELETE.

**product** (exists)
- Add `sku text null` (unique per business when present; Postgres treats NULLs as distinct, so a plain unique on `(business_id, sku)` is enough) and `archived_at timestamptz null` if they are not there already.
- Name is 1 to 120 characters after trimming. Names are not unique.
- Add a btree index on `(business_id, name, id)` for paging.

**pack_type** (exists)
- Add `sell_price numeric(14,2) not null`, `cost_price numeric(14,2) null`, `archived_at timestamptz null`. Check constraints: both prices >= 0.
- Unique `(business_id, product_id, units_per_pack)`, unique `(business_id, product_id, name)`, unique `(business_id, product_id, id)` (needed by the barcode key below). Keep the existing partial unique index of at most one `units_per_pack = 1` per product. `units_per_pack` is between 1 and 10000.
- Adding a NOT NULL column to a table with rows fails. Use `ADD COLUMN sell_price numeric(14,2) NOT NULL DEFAULT 0` then `ALTER COLUMN sell_price DROP DEFAULT` in the same migration.

**product_barcode** (new)
- `barcode text not null`, `product_id`, `pack_type_id`, `created_by_membership_id`.
- Unique `(business_id, barcode)`.
- Foreign key `(business_id, product_id, pack_type_id)` references `pack_type (business_id, product_id, id)`, so a barcode can never point at a pack type of another product or business. Also `(business_id, product_id)` references `product`.
- `app_user`: SELECT, INSERT, DELETE (the only table where delete is allowed in this phase; the trigger below records it).
- Check: barcode matches `^[A-Za-z0-9._-]{4,48}$`.

**sync_command** (exists)
- Make sure it stores `occurred_at` (from the phone) and `received_at` (server). If they are missing, add them now with the default-then-drop-default trick. Commands must record both from the first real command on, because they cannot be backfilled later.

**change_log and triggers** (hand-written SQL, one migration per object)
- Extend the existing change-log trigger pattern to `pack_type`, `product_barcode` (insert, update and delete, with the delete recording the key so phones can remove the row) and `location`. Check how the existing `product` trigger and `change_log` columns work and reuse them. Triggers are `SECURITY INVOKER`, so a rolled-back change leaves no log row.

**Default location at signup**
- The signup transaction also inserts the default location ("Main shop", `is_default = true`) under the same tenant setting. A failure leaves nothing behind. Businesses created before this phase have no location. Do not write a backfill (forced RLS stops `migrator` from reading other businesses); local data is rebuilt with `docker compose down -v`.

## 4. Catalogue rules

- A product has 1 to 6 pack types, at most one with `units_per_pack = 1`. An active product needs at least one active pack type (archiving the last one is rejected with `LAST_ACTIVE_PACK`).
- `units_per_pack` can change only while no `stock_movement` exists for that pack type. After that it is locked (`UNITS_LOCKED`); the shop creates a new pack type instead.
- Archiving a product hides it from search and listing by default. Its barcodes stay reserved (the codes cannot be reused for another product). Archived products can be restored.
- Prices can change at any time. Sales will copy the price at the time of sale (Phase E), so history is safe.
- No variants: "Coke 500ml" and "Coke 1L" are separate products. No stock quantity columns on `product` or `pack_type`; stock lives only in `stock_balance`.
- A barcode is text. Never convert it to a number (leading zeros matter).
- Barcode normalisation, applied on every write and lookup: trim; a 12-digit numeric code gets a leading `0` (UPC-A equals EAN-13 with a leading zero). Do not validate check digits. Do not change case.
- Money in JSON is a string matching `^\d{1,12}(\.\d{1,2})?$`. Numbers, negative values, three decimals, `.5`, `1e3` and over-long values are rejected. Responses always show two decimals.

## 5. Commands

Endpoint: `POST /v1/sync/commands`. Body: `{ commands: [ { command_id (uuid), type, occurred_at (ISO), payload } ] }`, at most 100 commands, body limit 1 MB. Commands are processed in order, each in its own tenant transaction as built in the spike (idempotent, savepoint around the handler). The response lists, in the same order: `{ command_id, status (ACCEPTED, FLAGGED, REJECTED, FAILED), reason?, result? }`. `FAILED` means an unexpected error, safe to retry. `occurred_at` more than 24 hours in the future is rejected with `OCCURRED_AT_INVALID`; any time in the past is fine (a phone can be offline for days).

IDs for new things are created by the phone (UUIDs). Omitted fields mean "unchanged". `null` clears an optional field.

| Command | Payload | Permission |
|---|---|---|
| `product.create` | `product_id`, `name`, `sku?`, `pack_types: [{ pack_type_id, name, units_per_pack, sell_price, cost_price? }]`, `barcodes: [{ barcode, pack_type_id }]` | `products.edit` |
| `product.update` | `product_id`, any of `name`, `sku`, `archived` (at least one) | `products.edit` |
| `pack_type.upsert` | `pack_type_id`, `product_id`, `name`, `units_per_pack`, `sell_price`, `cost_price?`, `archived?` | `products.edit` |
| `barcode.add` | `barcode`, `product_id`, `pack_type_id` | `products.edit` |
| `barcode.remove` | `barcode` | `products.edit` |

- Any command that sets or changes `cost_price` also needs `costs.view`, otherwise the whole command is `REJECTED` with `PERMISSION_DENIED`. Do not silently ignore the field.
- Permission is checked per command type in the dispatcher, using the membership loaded at the start of the request. A suspension during a batch takes effect on the next request.
- `business_id` anywhere in a payload is rejected by validation (existing rule).
- `barcode.add` with the same code on the same pack type is `ACCEPTED` as a no-op. The same code on another pack type or product is `REJECTED` with `BARCODE_TAKEN`. `barcode.remove` of a code that does not exist is `ACCEPTED` as a no-op.
- `product.create` with an existing `product_id` is `REJECTED` with `ALREADY_EXISTS`.
- Reasons used: `VALIDATION_FAILED`, `PERMISSION_DENIED`, `SKU_TAKEN`, `BARCODE_TAKEN`, `ALREADY_EXISTS`, `PRODUCT_NOT_FOUND`, `PACK_TYPE_NOT_FOUND`, `PACK_LIMIT_REACHED`, `PACK_UNITS_DUPLICATE`, `PACK_NAME_DUPLICATE`, `BASE_UNIT_DUPLICATE`, `LAST_ACTIVE_PACK`, `UNITS_LOCKED`, `OCCURRED_AT_INVALID`. Map Postgres unique violations to these by constraint name (Prisma 7 puts the SQLSTATE at `meta.driverAdapterError.cause.originalCode`; see the spike). A reference to something in another business must give `PRODUCT_NOT_FOUND`, never a message that hints it exists.

**The request transaction opt-out.** `TenantInterceptor` wraps the whole request in one tenant transaction, and the spike's runner refuses nested `run()`. This route needs one transaction per command, so add a route marker (for example `@OwnTransactions()`). For marked routes the interceptor still loads the membership and device in a short tenant transaction, applies the same status checks and builds the effective permissions, then lets the handler run outside any transaction. The dispatcher passes the actor explicitly to `AuditService.record` (which supports an explicit actor). The marker must be used for this route only. Test that a suspended member is refused before any command runs.

## 6. Reads

All reads are normal protected routes, so they run in the request's tenant transaction. Any active member may call them. They never take a business id.

- `GET /v1/locations` (active only; `include_archived=true` for the owner list).
- `GET /v1/products?q=&limit=&cursor=&include_archived=`
- `GET /v1/products/:id` (404 `PRODUCT_NOT_FOUND` for another business's id, same as for a missing id)
- `GET /v1/products/by-barcode/:code` (normalises the code; 404 `BARCODE_NOT_FOUND`; an archived product is returned with `archived: true`)

Product shape: `{ id, name, sku, archived, pack_types: [{ id, name, units_per_pack, sell_price, cost_price?, archived }], barcodes: [{ barcode, pack_type_id }] }`. The `cost_price` key is **omitted** (not null) unless the caller has `costs.view`.

**Search (`q`)**, all inside the caller's business through RLS (the Phase B tests prove it, section 14):
1. Exact barcode match (after normalising), then exact SKU match, then name.
2. Name match is case-insensitive substring using `ILIKE '%...%'` on `name`, so the existing trigram index `product_name_trgm_idx` is used. `lower(name) LIKE` would not use it.
3. Escape `%`, `_` and `\` in the user's text so they match literally.
4. `q` must be at least 2 characters (`VALIDATION_FAILED` otherwise), at most 50 results (`limit` default 20), no paging for search. Order: exact matches, then name starts with `q`, then the rest by name.
5. Archived products are hidden unless `include_archived=true`.
6. Search needs raw SQL (Prisma cannot express the operator): parameters only, never string concatenation, through the tenant transaction client in the repository.

**Listing without `q`**: keyset paging on `(name, id)`, `limit` default 20, max 50, opaque cursor. No duplicate items across pages when items are added during paging (an item added behind the cursor may be missed; that is fine).

**Locations (admin, online only)**: `POST /v1/locations`, `PATCH /v1/locations/:id` (rename, archive, restore). New permission `locations.manage`, owner preset only (add to `common/auth/permissions.ts`). The default location cannot be archived, and a business always keeps at least one active location (`LAST_ACTIVE_LOCATION`).

## 7. Permissions

| Permission | Attendant | Manager | Owner |
|---|---|---|---|
| Read locations and catalogue | yes | yes | yes |
| `products.edit` (the five commands) | no | yes | yes |
| `costs.view` (read and write cost prices) | no | no | yes |
| `locations.manage` (new) | no | no | yes |

Extra permissions work as in Phase A (the owner can grant `costs.view` to a manager).

## 8. Audit

Use `AuditService.record` in the same transaction as the change (inside each command's transaction). Actions: `product.created`, `product.updated`, `product.archived`, `product.restored`, `pack_type.created`, `pack_type.updated` (include before and after for `sell_price`, `cost_price`, `units_per_pack`, `name`, `archived`), `barcode.added`, `barcode.removed`, `location.created`, `location.updated`, `location.archived`, `location.restored`. Metadata must not contain secrets, phone numbers or contact details. Cost price values in audit rows are business data that only a `costs.view` reader may see; any future audit read endpoint must hide them for everyone else (record this in the results file).

## 9. Lessons from Phase A that apply here

- A test run applies pending migrations to `aberdare_test`. **Do not run any test while a migration waits for review.** Show the SQL first, get approval, apply, then test.
- Hash and parse before the transaction; no network calls and no `Promise.all` on the request's transaction.
- Run the new test files for each step during the step. The full suite takes over 10 minutes on this machine, so run it in the background at the end of each step and not after every small change.
- Replay migrations in the shadow database and read the generated SQL (no drops of custom objects).
- Before reverting a mutation, check the revert worked (a search for leftover mutation markers runs before the final suite).

## 10. Mistakes AI tends to make here (do not)

- Building `POST /products`, `PUT /products/:id` or any REST write for catalogue data. Writes are commands only, because the phone is offline first. (Location admin is the one allowed REST write.)
- Using JavaScript numbers, `parseFloat` or Prisma `Float` for money.
- Hard-deleting products, pack types or locations.
- Making product names unique, or adding categories, brands, variants, images, stock columns or reorder levels.
- Storing barcodes as numbers, validating check digits, or comparing barcodes without normalising.
- Check-then-insert for SKU or barcode uniqueness. Use the unique constraint and map the violation.
- Returning `cost_price: null` instead of omitting the key.
- Putting `business_id` in a request body, query or header.
- `lower(name) LIKE ...` instead of `name ILIKE ...`, or building the search SQL with string concatenation.
- Forgetting the `change_log` trigger for deletes, or writing `change_log` from application code instead of the trigger.
- Running the sync route inside the request transaction.
- Revealing in an error message that something exists in another business.
- Changing a fixed rule to make a test pass. Report and ask.

## 11. Build order and done criteria

Each step ends with passing tests shown in the session and a commit. Present the schema or SQL for each step before applying it, and run no test until it is approved.

- **B1: Schema, triggers, locations.** Columns and tables of section 3, `sync_command` timestamps, change-log triggers, default location at signup, location endpoints, `locations.manage`.
- **B2: Command endpoint and catalogue commands.** The route marker, `POST /sync/commands`, the five commands, money rules, audit.
- **B3: Barcodes and lookup.** Normalisation, add and remove rules, `by-barcode`.
- **B4: Search and listing.** Section 6 reads, permission-aware output, tenant-scope tests.
- **B5: Hardening and handover.** Change-log and audit coverage, log checks, walkthrough, `docs/phase-b-results.md`.

## 12. Test plan

All automated, real Docker database. Never weaken a test to make it pass. Use the injectable `Clock`. Concurrency tests are genuinely concurrent.

**Testing method (from B3 on, set by Ian; B1 and B2 used ten runs per new file and two full-suite runs).** Baseline before B3: the full suite is 240 of 240.
- During a step: run only that step's new test files until they pass. Do not run the full suite after every small change.
- Repeat only the tests that involve concurrency or timing (parallel requests, races, locks), 5 runs in a row. Every other new test runs once: repeating a deterministic test proves nothing new.
- Step gate: run the step's new tests plus every earlier Phase B test file once, and report it as "new N, Phase B cumulative M" (B1 alone; B2 plus B1; B3 plus B1 and B2; and so on). Then run the full suite once, in the background, to catch a break in Phase A or the spike, while Ian reviews.
- End of phase (after B5): run the full suite 3 times in a row, and write in `docs/phase-b-results.md` exactly how many runs were done and how many tests passed in each. Never write a number that was not observed.
- Unchanged: no test runs while a migration waits for review; the mutation checks are still required; a failing test is never weakened.

**B1: schema, triggers, locations**
1. The RLS coverage test passes with `product_barcode` included (forced RLS, `shop_only` policy).
2. A barcode cannot reference a pack type of another product, or of another business (composite foreign key).
3. Duplicate `units_per_pack`, duplicate pack name, and a second `units_per_pack = 1` on one product are refused by the database. A negative price is refused by the database.
4. `sync_command` stores `occurred_at` and `received_at`.
5. Signup creates the default location in the same transaction. A forced failure after the location insert leaves no business, person, membership, device or location.
6. `GET /locations` returns only the caller's own locations. Two businesses with identically named locations never see each other's.
7. `POST` and `PATCH /locations` need `locations.manage` (owner yes, manager and attendant `PERMISSION_DENIED`). Rename works. The default location and the last active location cannot be archived. Archived locations disappear from the default list and come back with `include_archived`.
8. Location changes write `change_log` and audit rows. A rolled-back change writes neither.

**B2: command endpoint and catalogue commands**
1. The route needs a token. A batch over 100 commands, a body over 1 MB, a bad command id, and an unknown type are refused or rejected cleanly. Results come back in request order. A suspended member's batch is refused before any command runs.
2. Each command in a batch has its own transaction: command 3 rejected, 1, 2, 4 and 5 accepted. An unexpected crash in one command is `FAILED` and does not affect the others.
3. An attendant sending `product.create` gets `REJECTED / PERMISSION_DENIED`; a manager succeeds.
4. `product.create` is atomic: a barcode conflict leaves no product and no pack types.
5. The same command id twice (sequential, and 20 concurrent) creates one product and returns the same result.
6. `SKU_TAKEN`: 20 concurrent creates with the same SKU in one business give exactly one `ACCEPTED`. The same SKU in another business is allowed.
7. Money: only valid strings are accepted (`"0.10"`, `"180"`, `"999999999999.99"`); numbers, `"-1"`, `"0.125"`, `".5"`, `"1e3"` and 13 integer digits are rejected. Values round-trip exactly and read back with two decimals.
8. `cost_price` without `costs.view` is `REJECTED / PERMISSION_DENIED`. With the extra permission it is accepted.
9. Pack rules: zero pack types, 7 pack types, duplicate units, duplicate name and a second base unit are rejected with the named reasons. Archiving the last active pack type is `LAST_ACTIVE_PACK`.
10. `product.update` changes only the fields sent. An empty update is rejected. Archive and restore work. An archived product's barcodes still block reuse.
11. `UNITS_LOCKED`: `units_per_pack` can change before any stock movement exists and cannot after (use a movement fixture through the stock repository).
12. Referencing another business's product or pack type returns `PRODUCT_NOT_FOUND` or `PACK_TYPE_NOT_FOUND`, with the same response as an id that does not exist anywhere.
13. `business_id` in a payload is rejected. `occurred_at` more than 24 hours ahead is `OCCURRED_AT_INVALID`; a date three days ago is accepted. Both timestamps are stored.
14. Audit rows exist with before and after values for price, units, name and archive changes. A forced failure after the audit insert leaves no audit row and no data change.

**B3: barcodes**
1. A 12-digit code is stored as 13 digits. Lookup with the 12-digit and the 13-digit form finds the same product. Leading zeros survive. Check digits are not validated.
2. Invalid characters, fewer than 4 or more than 48 characters, and spaces are rejected.
3. `barcode.add`: same code and same pack type is an accepted no-op; same code on another pack type or product is `BARCODE_TAKEN`; 20 concurrent adds of one code to different products give exactly one `ACCEPTED`.
4. `barcode.remove` removes it, a removed code can be added again, removing a missing code is an accepted no-op. Removal writes a `change_log` delete row.
5. The same code in two businesses is allowed, and each sees only its own.
6. `by-barcode` returns the product with the exact pack type, `404 BARCODE_NOT_FOUND` for unknown codes and for another business's codes, and `archived: true` for archived products.
7. Any active member can read; `cost_price` is omitted without `costs.view`.

**B4: search and listing**
1. Order: exact barcode, then exact SKU, then names starting with `q`, then other substring matches.
2. Matching is case-insensitive substring. `%`, `_` and `\` match literally (a search for `%` returns only names containing a percent sign). A 1-character query is `VALIDATION_FAILED`.
3. Archived products are hidden by default and appear with `include_archived`.
4. The `cost_price` key is absent (not null) without `costs.view`, present with it, on list, search, by-id and by-barcode.
5. **Scope:** with identical product names, SKUs, barcodes and pack names seeded in two businesses, list, search, by-id and by-barcode never return the other business's rows. `GET /products/:id` for the other business's id is the same 404 as a missing id. A request that includes a `business_id` query parameter or header is unaffected by it.
6. Paging: pages do not overlap and cover the whole set; `limit` is capped at 50; the cursor is opaque and a tampered cursor is `VALIDATION_FAILED`.
7. Hostile input (quotes, semicolons, `--`, very long text, NUL bytes) returns normally with no error leak.
8. Speed: with 20,000 products in one business, a name search returns under 200 ms in the test environment (a generous bound). Record the `EXPLAIN` plan in the results file and say whether the trigram index was used.

**B5: hardening**
1. `change_log` rows exist for insert, update and delete on `pack_type`, `product_barcode`, `location` and `product`. A rolled-back change writes none. The barcode delete row carries enough to identify the barcode.
2. Every audit action in section 8 is written once, in the same transaction.
3. No log line for a sync request, a failed command, or a 500 contains payload prices, barcodes, names or tokens (log lines carry command types and ids only).
4. The manual walkthrough (section 13) runs end to end.
5. The step gate passes ("new N, Phase B cumulative M"), the concurrency and timing tests pass 5 runs in a row, and the full suite passes 3 runs in a row at the end of the phase, with each run's count written down as observed.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, then revert and confirm the revert:
1. Return `cost_price` regardless of permission: B4 test 4 must fail.
2. Replace the barcode unique constraint handling with check-then-insert: B3 test 3 (concurrent adds) must fail.
3. Stop escaping `%` and `_` in search: B4 test 2 must fail.
4. Remove the `UNITS_LOCKED` check: B2 test 11 must fail.
5. Remove the `product_barcode` delete from the change-log trigger: B3 test 4 and B5 test 1 must fail.
6. Replace the composite barcode foreign key with a plain foreign key on `pack_type_id`: B1 test 2 must fail.
7. Drop `archived_at IS NULL` from search: B4 test 3 must fail.

## 13. Manual walkthrough (for Ian)

At the end of B5, Claude Code writes `docs/phase-b-walkthrough.md`: copy-and-paste requests (curl, and a Bruno collection if Ian prefers) for this story against the local API with the fake senders:

1. Owner signs up and sees a default "Main shop" location. 2. Owner adds a manager and an attendant (Phase A). 3. The attendant tries `product.create` and is rejected. 4. The manager creates "Maize flour 2kg" with a piece and a carton of 24 and two barcodes. 5. Scan the carton barcode: the carton pack type comes back. 6. Search "maize": found, no cost price. 7. The owner sets a cost price and sees it. 8. Try registering the carton barcode on another product: `BARCODE_TAKEN`. 9. Archive the product: it disappears from search and the barcode stays reserved. 10. A second business signs up, searches "maize", and finds nothing; it registers the same barcode without conflict.

Ian runs it and writes down anything that surprised him.

## 14. About the scope of search

Every product read is limited to the caller's own business, and this is enforced twice: by the tenant transaction and RLS in the database, and by the fact that no endpoint accepts a business id. On the phone, search runs on the local database that holds only that business's data (Phase D builds the sync that fills it). The B4 scope test (test 5) exists to prove this with identical data in two businesses.

## 15. Results file

When B5 is finished, Claude Code writes `docs/phase-b-results.md`, in the same style as `docs/phase-a-results.md`: a status line (only Ian marks the phase done, in `CLAUDE.md` section 2), a summary table per step with the new test counts and any workarounds, final patterns (the route marker for per-command transactions, the search SQL, the barcode normalisation, the money handling), the mutation proofs, versions changed, things to know, open risks, the `EXPLAIN` plan and timing for the search, changes to the other docs, and the final suite results (fill in every number, no placeholders).

## 16. Doc updates to make in B1 (show Ian the diff before committing)

- `CLAUDE.md` section 2: the phase table row for B becomes "locations, products, pack types, barcodes, search, and `POST /sync/commands` with the catalogue commands"; the row for D loses `/sync/commands`. Do not touch the status line.
- `docs/architecture.md`: section 5 (the commands list gains `pack_type.upsert`, `barcode.add`, `barcode.remove`, the command endpoint's limits, and the per-command transaction route marker), section 12 (columns for `product`, `pack_type`, `location`, `product_barcode`), section 13 (the new read and location endpoints), section 14 (`locations.manage`), section 7 (the barcode rules above), section 16 (open items below).

## 17. Open items

1. **Carton barcodes.** Ian checks a real carton at the client. If the carton shows the same number as the pieces, change the rule: allow one barcode to map to several pack types of the same product, and the app asks "piece or carton?" on scan. Also check whether cartons carry a 14-digit code (ITF-14); they are accepted as they are.
2. Bulk import (CSV or Excel) of existing products. Likely needed for onboarding real shops.
3. Categories and filters.
4. Reorder levels (needed by the Phase F low-stock digest).
5. Kenya's tax authority e-invoicing (eTIMS) may eventually need a tax class on products. Not verified; confirm with an accountant before launch.
6. Wholesale price tiers or quantity discounts.
7. Label generation and printing for items without barcodes (the in-store EAN-13 range 20 to 29).
8. A future audit read endpoint must hide cost values from anyone without `costs.view`.
9. A location restriction per staff member, if a real client needs it.
