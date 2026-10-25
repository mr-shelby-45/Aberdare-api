# Phase B results

Filled in step by step. The full summary (see `docs/phase-b-design.md` section 15) is written when B5 is finished. Only Ian marks the phase done, in `CLAUDE.md` section 2.

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
