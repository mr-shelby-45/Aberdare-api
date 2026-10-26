# Phase D results

**Status: all four steps (D1 to D4) passed. Waiting for Ian's review.** Only Ian marks Phase D done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-d-walkthrough.md`.

**Final suite (end of phase, 3 runs in a row):** 3 runs done, all passed, on the working tree this commit records. Run 1: 31 files, 355 of 355 (355.3 s). Run 2: 31 files, 355 of 355 (351.2 s). Run 3: 31 files, 355 of 355 (355.8 s). Lint, type-check, build and the drift check were clean before the runs. Earlier failed runs during Phase D are recorded in their step sections below, as observed.

## Summary

| Step | What it built | New tests | Phase D cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| D1 | `change_log.txid`, the finished-transactions query, the changes cursor, the prune and its horizon, device column grants, the device stamp | 7 | 7 | Reused the A1 `device.last_sync_at`; replaced `app_user`'s table-wide device UPDATE with five columns; owner-only policies for the prune (FORCE RLS binds the owner); one full run failed the A3 timing check under load, rerun clean |
| D2 | `GET /v1/sync/snapshot`, the `SyncTables` list | 9 | 16 | Each table reads through its own module's service (no cross-module exception); a held-open transaction needed to show the start-cursor order |
| D3 | `GET /v1/sync/changes` | 9 | 25 | Collapsed changes at the first appearance; `limit` counts log rows; mutation 1 also run in a sharper form; mutation 7 can only fail closed |
| D4 | Randomized sync check (3 seeds), log check, walkthrough document and test | 5 | 30 | A held-open transaction in every seed run forces an out-of-order commit; random renames avoid its row |

New tests count `it` cases as Vitest reports them; the D4 randomized check is one case per seed (three).

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Finished transactions only | `SELECT ... FROM change_log WHERE business_id = $b AND txid < pg_snapshot_xmin(pg_current_snapshot()) AND (txid, id) > ($txid::xid8, $id::bigint) ORDER BY txid, id LIMIT $n`. Every transaction below xmin has finished and any later writer gets a higher txid, so nothing appears behind a returned position | `ChangeLogRepository.finishedAfter` |
| Positions | `(txid, id)` as decimal text, compared in SQL; never JavaScript numbers; never `changed_at` | `change-log.repository.ts` |
| Start cursor | `(pg_snapshot_xmin(pg_current_snapshot()), 0)`, taken before any snapshot row is read, in the same request transaction | `ChangeLogRepository.startPosition`, `SnapshotService.page` |
| Changes cursor | Shared `SignedCursor`, kind `sync-changes`: `{ business_id, txid, id, costs }`. Not genuine or another business's: `422`. Cost visibility changed or older than the horizon: `410 SNAPSHOT_REQUIRED`. Not tied to a device | `ChangesCursor`, `ChangeFeedService.open` |
| Snapshot | No `table` and no `cursor` starts (start cursor, then `location`); keyset by id per table with a page cursor bound to business and table; tables in a fixed order; each request its own short transaction | `SnapshotService`, `SyncTables` |
| Changes | Read `limit + 1` finished log rows (`limit` counts log rows); skip tables the reader cannot see; collapse each record at its first appearance; read the state now (`SyncTables.byIds`); missing = delete (`key: { barcode }` for barcodes) | `ChangesService` |
| Table list | One `SyncTables` entry per table (permission, `page`, `byIds`), each through the owning module's service; one shape function per table for both reads | `src/modules/sync/sync-tables.ts` |
| Prune | `change_log_prune(p_before)`: `SECURITY DEFINER`, owner-only read and delete policies, EXECUTE for `app_user` only; moves the one-row horizon to the newest removed position; the Clock minus `changeLogRetentionDays` (30) from code | migration `*_d1_change_log_prune`, `ChangeLogMaintenance`, `ChangeFeedService.prune` |
| Device stamp | `UPDATE device SET last_sync_at = $now WHERE ... AND (last_sync_at IS NULL OR last_sync_at < $now - 5 minutes)`, after the data is read, in the request's transaction; no log or audit row | `DevicesService.stampSync` |

## Proof the tests catch mistakes

Each design mutation was applied temporarily, the named test was shown failing (or, for 7, shown failing closed), and the change was reverted (checked byte for byte with `cmp`).

| Design mutation | Test that failed | What it caught |
|---|---|---|
| 1. Order and filter by id only, without the finished-transactions condition | D1 test 3, D3 test 8 | rows returned while T1 was open; with only the condition removed, T1's change was lost for good |
| 2. Take `start_cursor` after the first rows are read | D2 test 2 (held-open case) | the change committed between the read and the cursor was lost |
| 3. `cost_price` in changes without `costs.view` | D3 test 4 | the attendant received the cost |
| 4. `costs` not bound into the cursor | D3 test 4 | the promoted manager's old cursor was accepted |
| 5. Prune inside the retention window | D1 test 6 | 10 rows removed instead of 4 |
| 6. State from the log instead of the record now | D3 test 6 | a barcode added and removed came back as an upsert |
| 7. Remove the business filter protection | D3 tests 1 and 7 | without the explicit filter RLS still isolates (tests pass, as intended); without the tenant setting the read failed closed (own changes missing, nothing leaked) |
| 8. Skip the live device check | D2 test 7, D3 test 9 | a revoked device read a snapshot page and changes |
| 9. Stamp without the 5-minute condition | D1 test 5a | a second stamp after 4 minutes wrote |
| 10. No business id in the cursor | D1 test 5 | business A's cursor was accepted by business B |

## Versions

Unchanged. No library was added in Phase D.

## Things to know

1. Only a genuinely held-open transaction shows the gap problem; plain tests pass with or without the finished-transactions condition. Every gap or order test here holds one open on a raw `app_user` connection.
2. Devices have only `ACTIVE` and `REVOKED`; "a revoked or suspended device" is tested as a revoked device or a suspended member.
3. No preset lacks `stock.view`; the empty `stock_balance` case is tested through `SnapshotService.page()` with a reader built directly.
4. Access tokens expire when tests move the fake clock; staff log in again by PIN, a second device for one member comes from the owner's password login.
5. The A3 password-login timing check fails when the machine is overloaded (seen in C3 and D1); such a run is repeated, never loosened.
6. The D4 randomized check prints its seed in the test name; `D4_SEED=<n> pnpm exec vitest run test/d4-hardening.spec.ts -t randomized` replays one.

## Open risks

1. Idle-in-transaction connections hold back `pg_snapshot_xmin`, so `changes` returns nothing newer than the oldest open transaction until it ends (design open item 3: an idle-in-transaction timeout in Phase H).
2. The prune is not scheduled (Phase F); `change_log` grows until it is.
3. Mutation 7 can only fail closed: without a BYPASSRLS role the app cannot leak, which is the design; a role with BYPASSRLS must never be given to the app.
4. `last_sync_at` is written but shown nowhere yet (design open item 6).
5. Snapshot size for very large catalogues on slow connections is unmeasured (design open item 7).
6. Overload still answers 500 instead of 503 (spike open risk 4, unchanged).

## Changes to the other documents

- `CLAUDE.md`: the phase row for D (D1, commit `400065e`); section 8 notes for the change feed, devices, snapshot and changes (D1 to D3). The status line was not touched.
- `docs/architecture.md`: section 5 (the finished-transactions rule, cursor, 410, snapshot, changes, devices, retention, and "as built" notes for D2 and D3), section 12 (`change_log.txid`, `change_log_horizon`), section 13 (the two endpoints), section 16 (open items 42 to 48).
- `docs/phase-d-design.md`: Ian's edits (device stamp, business id in the cursor, device checks), committed with the D1 doc updates.
- `docs/phase-d-walkthrough.md`: new (D4).

# Step details

## D1: Migration, cursor, finished-transactions query, prune, device stamp (passed)

**Result:** new 7, Phase D cumulative 7 (`test/d1-change-log.spec.ts`), all passing in the gate run. The gap test (D1 test 3, a genuinely held-open transaction) passed 5 runs in a row. D1 test 1's inventories are in `test/step4-migrations.spec.ts` and `test/b5-hardening.spec.ts` (both passed with the D1 file: 27 of 27). The first full-suite run failed one test (331 of 332): A3's "loose timing sanity check" of password login measured a ratio of 0.497 against 0.5, in a run that took 748.7 s instead of the usual 350 to 420 s (machine load; D1 touches no login or hashing code; the same failure as in C3). Rerun unchanged, the full suite passed: 27 files, 332 of 332 (613.7 s). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the eight recommended answers):**
- Doc updates of design section 14 (commit `400065e`), with Ian's design edits (device stamp, business id in the cursor, device checks).
- Three migrations, replayed and probed in the shadow database before approval:
  - `*_d1_change_log_txid` (generated): `change_log.txid xid8 NOT NULL DEFAULT pg_current_xact_id()` (existing rows took the migration's id; the default stays, it is how the triggers fill the column, so the triggers are unchanged), the `(business_id, txid, id)` index, and the `change_log_horizon` table.
  - `*_d1_change_log_prune`: the single horizon row (`app_user` SELECT only), owner-only read and delete policies on `change_log` (`FORCE` RLS applies to the owner too), and the `SECURITY DEFINER` function `change_log_prune(p_before)`, EXECUTE for `app_user` only (answer 1). It removes rows of every business written before the cut-off (answer 2) and moves the horizon to the newest removed `(txid, id)`, never backwards (answer 3).
  - `*_d1_device_update_columns`: `app_user`'s table-wide UPDATE on `device` replaced by UPDATE of `name`, `is_shared`, `status`, `last_seen_at`, `last_sync_at` (answer 7).
- `ChangeLogRepository` (`src/modules/sync/`): `startPosition()` = `(pg_snapshot_xmin(pg_current_snapshot()), 0)`; `finishedAfter(position, limit)`, the finished-transactions query as approved, with the comment on why it removes the gap; `isRetained(position)` against the horizon.
- `ChangesCursor`: the shared `SignedCursor` with kind `sync-changes`, holding `{ business_id, txid, id, costs }`. Tampered, malformed, unsigned, another kind, or another business's: the same `422 VALIDATION_FAILED`. A `costs` mismatch: `410 SNAPSHOT_REQUIRED`.
- `ChangeFeedService`: `startCursor`, `open` (cursor checks plus the horizon: `410`), `finishedAfter`, `sign`, and `prune()` (the Clock minus `changeLogRetentionDays`, a constant 30 in `AppConfig`, answer 4) through `ChangeLogMaintenance` in `src/database/` (non-tenant, answer 5).
- `DevicesService.stampSync(deviceId)`: the existing `last_sync_at` column (answer 6), one conditional `UPDATE` with the Clock, at most once every 5 minutes. Tested directly; the sync endpoints call it from D2 (answer 8).

**Earlier tests changed by D1 (mechanical; no assertion weakened):**
- Step 4's inventory now also lists `change_log_prune` (security definer, `app_user` may run it, PUBLIC may not) and the three `change_log` policies.
- B5's grants inventory lists `change_log_horizon: SELECT` and `device: SELECT,INSERT` plus the five updatable device columns.
- `resetTables()` also resets the prune horizon.

**Proof the tests catch mistakes** (each applied, shown failing, reverted, revert checked with `cmp`):
- Mutation 1, order and filter by id only, without the finished-transactions condition: D1 test 3 failed (rows were returned while T1 was still open).
- Mutation 5, prune inside the retention window (28 days): D1 test 6 failed (10 rows removed instead of 4).
- Mutation 9, the stamp without the 5-minute condition: D1 test 5a failed (a second stamp after 4 minutes wrote).
- Mutation 10, no business id in the cursor: D1 test 5 failed (business A's cursor was accepted by business B).

**Things to know:**
1. Devices have only `ACTIVE` and `REVOKED`; there is no suspended device. D2 test 7 and D3 test 9 read "a revoked or suspended device" as "a revoked device, or a suspended member" (decided in D1, answer 8).
2. Transaction ids and change_log ids are 64-bit; they are carried as decimal text (`txid::text`, `id::text`) and compared in SQL, never as JavaScript numbers. Tests use `BigInt` only to compare them.
3. The prune's horizon is a position, not a time: rows are removed by `changed_at`, but a transaction that started early can write a higher `txid` later, so the horizon is the newest removed position, which can refuse a cursor slightly more often than strictly needed, never less.

## D2: Snapshot (passed)

**Result:** new 9, Phase D cumulative 16 (`test/d1-change-log.spec.ts` and `test/d2-snapshot.spec.ts`), all passing in the gate run. The held-open-transaction case of D2 test 2 passed 5 runs in a row. The full suite passed once: 28 files, 341 of 341 (354.5 s), with lint, type-check, build and the drift check clean.

**Built (Ian said "proceed to D2"; no migration was needed; defaults chosen as below, open to Ian's review):**
- `GET /v1/sync/snapshot?table=&cursor=&limit=` on `SyncController`, in the request's own short tenant transaction (no `@OwnTransactions`), any active member on an active device (no permission marker; the pipeline loads both live).
  - No `table` and no `cursor`: the start. `start_cursor` is taken first (`ChangeFeedService.startCursor`), then the first page of `location` is read.
  - `table` without `cursor`: that table's first page (no `start_cursor`). `table` with `cursor`: the next page. A `cursor` without `table` is `422`.
  - Response `{ table, rows, next_cursor, next_table, start_cursor? }`; `next_table` only when the table is finished; both null after `stock_balance`.
  - `limit` default 500, above 500 quietly capped, 0 refused (as for the other lists).
- Page cursor: the shared `SignedCursor` (kind `sync-snapshot`) with `{ business_id, table, after_id }`; another table, another business, tampered, or a changes cursor: `422`.
- `SyncTables` (`src/modules/sync/sync-tables.ts`): one entry per table (name, permission, page), in the fixed order. Each entry reads through the owning module's service (`LocationsService.pageForSync`, `ProductsService.productsPageForSync` / `packTypesPageForSync` / `barcodesPageForSync`, `StockService.balancesPageForSync`), so no module reads another's tables and no read-only exception was needed. Adding a table is one entry.
- Row shapes (flat, one row per table): location `{ id, name, is_default, archived_at }`; product `{ id, name, sku, archived_at }`; pack_type `{ id, product_id, name, units_per_pack, sell_price, cost_price?, archived_at }` (`cost_price` key absent without `costs.view`); product_barcode `{ id, barcode, product_id, pack_type_id }`; stock_balance `{ id, location_id, pack_type_id, quantity, updated_at }` (zero and negative rows included; the table is empty without `stock.view`). Archived rows carry `archived_at` (the Phase B reads use an `archived` flag; the design names `archived_at`).
- Every page stamps the calling device with `DevicesService.stampSync()` after the data is read (at most once every 5 minutes).

**Proof the tests catch mistakes** (each applied, shown failing, reverted, revert checked with `cmp`):
- Mutation 2, `start_cursor` taken after the first rows are read: D2 test 2 (the held-open case) failed: the change committed between the read and the cursor was lost. The plain "change during the download" case did not catch it, by nature; the held-open case forces the order.
- Mutation 8, the live device status check skipped: D2 test 7 failed (a revoked device downloaded a page). D3 test 9 will be checked against the same mutation.

**Things to know:**
1. No preset lacks `stock.view`, so "stock_balance empty without stock.view" is tested through `SnapshotService.page()` with a reader built directly.
2. The held-open case commits T1 from inside a spy on the location table's page read, so the commit lands exactly between the read and anything after it.

## D3: Changes (passed)

**Result:** new 9, Phase D cumulative 25 (the D1, D2 and `test/d3-changes.spec.ts` files), all passing in the gate run. D3 test 8 (out-of-order commits with a held-open transaction, polled through the real endpoint) passed 5 runs in a row. The full suite passed once: 29 files, 350 of 350 (329.2 s), with lint, type-check, build and the drift check clean.

**Built (approved by Ian on 2026-10-26, with the six recommended answers):** no migration.
- `GET /v1/sync/changes?cursor=&limit=` on `SyncController` (`ChangesService`), in the request's own short tenant transaction; `cursor` required; `limit` default 200, above 500 quietly capped, 0 refused. Response `{ changes, next_cursor, has_more }`.
- Steps: open the cursor (D1: `422` or `410`), read up to `limit + 1` finished log rows, skip tables the reader cannot see, collapse, read every record's state now through `SyncTables.byIds` (one query per table, through each module's `...ByIdsForSync` service method), turn missing records into deletes, stamp the device, answer.
- Answer 1: a collapsed change sits at the record's first appearance in the page, with its latest state, so a parent stays before its children.
- Answer 2: `limit` counts log rows; the cursor moves by exactly the rows read.
- Answer 3: delete markers are `{ table, op: "delete", id }`, plus `key: { barcode }` (from `row_key`) for barcodes; never other contents.
- Answer 4: rows of tables the reader cannot see (`stock_balance` without `stock.view`) are skipped, upserts and deletes alike; the cursor moves past them.
- Answer 5: an empty page returns the same position, re-signed (identical to the cursor sent).
- `SyncTables` entries gained `byIds`, sharing one shape function per table with the snapshot.

**Proof the tests catch mistakes** (each applied, shown failing, reverted, revert checked with `cmp`):
- Mutation 1, order and filter by id only, without the finished-transactions condition: D3 test 8 failed, at its first poll (the id-only filter also replayed rows from before the snapshot). A second form that keeps the `(txid, id)` order and drops only the finished-transactions condition made test 8 fail on the gap itself: T1's change was lost (`'Main shop'` instead of `'Renamed by T1'`). D1 test 3 caught mutation 1 too.
- Mutation 3, `cost_price` in changes without `costs.view`: D3 test 4 failed (the attendant received `"150.00"`).
- Mutation 4, `costs` not checked in the cursor: D3 test 4 failed (the promoted manager's old cursor was accepted).
- Mutation 6, state taken from the log instead of the record as it is now: D3 test 6 failed (a barcode added and removed in the window came back as an upsert); D3 test 1 still passed under this form, because it has no record that was added and removed in the same window.
- Mutation 7, in the two forms agreed: removing only the explicit `business_id` filter left D3 tests 1 and 7 passing (RLS still isolates, as intended); clearing the tenant setting before the read failed closed (D3 test 1: the business's own changes were missing), while test 7 still passed (nothing from another business appeared). A real leak would need a role with BYPASSRLS, which the app does not have.
- Mutation 8, the live device check skipped: D3 test 9 failed (a revoked device read changes). (D2 test 7 failed too, in D2.)

**Things to know:**
1. The promotion case uses the staff PATCH (`extra_permissions: ['costs.view']`) and back; both cursors issued under the other visibility get `410`.
2. A second device for one member comes from the owner's password login (staff have no password); test 9 revokes the first device through the second.
3. Three first-run problems were in my tests: the cost check had to look for the quoted value (`"150.00"`, since a random id can contain `150`); the suspend call used the owner's token from the device the test had just revoked; and an edit put a comment inside an expression.

## D4: Hardening and handover (passed)

**Result:** new 5, Phase D cumulative 30 (all five Phase D files), all passing in the gate run. The randomized sync check (seeds 11, 22 and 33) passed 5 runs in a row (15 of 15 seed runs). The walkthrough passed as a test, and once over real HTTP against the built API (`node dist/main`, port 3100) on the test database: 21 of 21 checks, and no cursor or cost in the API's 114 log lines.

**Built (approved by Ian on 2026-10-26, with the five recommended answers):** tests and documents only, no production code.
- `test/d4-hardening.spec.ts`, test 1: two businesses (piece, carton, case; two locations; a barcode; opening stock), 150 random operations in waves of 10 through the real API (product create, rename, price and cost change, archive and restore, barcode add and remove, location create and rename, receive, adjust, count, convert, sale-mode decreases) while one phone per business runs at the same time: the attendant in business A (no costs) and the owner in business B (costs) (answer 2). Each phone snapshots in pages of 7, then polls `changes` with a random `limit` (3, 50 or 500), replaces its cursor only after a whole page, pauses a few random milliseconds, and sometimes starts over with a fresh snapshot. A transaction held open from wave 3 to wave 9 renames business A's default location, so every run has an out-of-order commit (answer 1). Checked: every operation ended as accepted, flagged, or an expected stock rejection; no phone request failed; after a final drain each phone's copy equals a fresh snapshot row for row; the held-open change arrived.
- Test 2, logs: marker product name, barcode and cost; paged snapshots, changes, a `410` and a `422`; no marker, no cursor value, no `rows`, `changes`, `cost_price`, `cursor=`, `start_cursor` or `next_cursor` in any log line; the sync request lines carry only the route patterns.
- `docs/phase-d-walkthrough.md` and `test/d4-walkthrough.spec.ts` (test 3): the six steps of design section 12, with the manager's own snapshot in step 2 for the step 5 cursor (answer 3) and one paged table (pack types, `limit=1`) (answer 4).
- Grants: no new test; the D1 inventories pin them (answer 5).
- This results file (test 4).

**Things to know:**
1. A location rename sent while the held-open transaction holds that row would wait on its lock and stall the wave forever; the random renames leave business A's default location alone.
