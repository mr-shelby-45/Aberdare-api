# Phase T results

Filled in step by step. The full summary (see `docs/phase-t-design.md` section 13) is written when T5 is finished. Only Ian marks the phase done, in `CLAUDE.md` section 2.

## T1: Schema, preset, permissions, doc updates (passed)

**Result:** new 5, Phase T cumulative 5 (`test/t1-field-schema.spec.ts`), all passing in the gate run. T1 test 6 is the earlier suites: the changed step 4, B1, B5 and D2 files passed with the other likely-affected files (A4, A5) before the gate. The first full run failed 2 of 415 (39 files): the A3 and B5 walkthrough expectations above, both mechanical consequences of the approved changes. After updating them (both files 32 of 32) the full suite passed: 39 files, 415 of 415 (462.3 s). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-27, with the seven recommended answers):**
- Five migrations, replayed and probed in the shadow database before approval (15 of 15 probes as expected), then applied to dev and test:
  - `*_t1_field_tables` (generated): the `FIELD_ATTENDANT` value of `role_preset`, `location.kind` (`NOT NULL DEFAULT 'SHOP'`, so existing rows are shops) and `location.assigned_membership_id`, `stock_movement.transfer_id` and `settlement_id`, and the `stock_transfer`, `field_settlement` and `field_settlement_line` tables with composite foreign keys. `sync_command_id` is required on transfers and settlements (answer 2); `variance` is BIGINT (answer 3).
  - `*_t1_field_checks`: location kind, assignee exactly on `FIELD`, never a default `FIELD`; transfer kind, different locations, text lengths; movement types `TRANSFER_OUT` (negative) and `TRANSFER_IN` (positive), `transfer_id` exactly on them, `settlement_id` only on `ADJUST`; settlement money never negative, `cash_variance = cash_received - expected_cash`, counts never negative, `period_end = received_at`, `period_start <= period_end`; lines' flows never negative, counted 0 to 2,000,000,000, `variance = counted - expected`.
  - `*_t1_location_one_active_field_per_member`: the partial unique index (archived locations do not count).
  - `*_t1_field_rls`: SELECT and INSERT only on the three tables, forced RLS with `shop_only`.
  - `*_t1_location_update_columns`: `app_user` may update only `name`, `archived_at` and `updated_at` of a location (answer 1, the D1 device pattern), so kind and assignee never change after creation.
- No read indexes for settlements yet; they come in T4 with the queries (answer 4).
- Permissions: `stock.transfer` and `field.settle` for managers and owners; the `FIELD_ATTENDANT` preset (`sales.create`, `payments.confirm`, `stock.view`). `effectivePermissions()` ignores any stored extras for a field attendant; the staff API refuses them with `422 EXTRA_PERMISSIONS_NOT_ALLOWED`, also when a preset change would keep old extras (answer 6).
- Locations (answer 5): `POST /v1/locations` takes `kind` (default `SHOP`) and `assigned_membership_id`. A `FIELD` location without an assignee, or an assignee on another kind, is `422 VALIDATION_FAILED`; an assignee who is not an invited or active `FIELD_ATTENDANT` of the business is `422 ASSIGNEE_INVALID` (the same for a missing member); a member's second active field location, on create or restore, is `409 FIELD_LOCATION_EXISTS`. Responses (REST and the sync row) gain `kind` and `assigned_membership_id`. `LocationsModule` now imports `StaffModule` (a data module).
- Location audit rows carry `kind` and `assigned_membership_id` (answer 7).
- Doc updates of design section 15: the `CLAUDE.md` phase row for T (the status line not touched), and `docs/architecture.md` sections 4, 5, 6, 12, 13, 14 and 16 (open items 60 to 69), edited in place.

**Mutation (reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 12, extras allowed for a field attendant: T1 test 4 failed (the staff API created one with an extra, `201` instead of `422`).

**Earlier tests changed by T1 (mechanical; no assertion weakened):**
- Step 4: the RLS list gains `field_settlement`, `field_settlement_line`, `stock_transfer`; `HAND_WRITTEN_INDEXES` gains `location_one_active_field_per_member`, with a check of its definition.
- B5: the grants inventory lists the three tables and replaces `location`'s table-wide UPDATE with its three columns.
- B1 tests 5 and 7, and the `location.updated` audit check: location responses and audit metadata gain `kind` and `assigned_membership_id`.
- D2 test 1: the location sync row's keys gain `kind` and `assigned_membership_id`.
- A3 (`GET /v1/me` for a manager): the exact permission list gains `field.settle` and `stock.transfer`. B5 walkthrough test step 1: the exact location response gains `kind` and `assigned_membership_id`. My survey before the full run missed these two; the first full run failed on exactly them (see below).
- `test/helpers/stock-api.ts`: `activeStaff()` accepts `FIELD_ATTENDANT`.

**Things to know:**
1. Adding an enum value (`ALTER TYPE role_preset ADD VALUE`) works inside Prisma's migration, but Postgres refuses to use the new value in the same transaction; nothing in `*_t1_field_tables` uses it.
2. Audit `occurred_at` comes from the database, not the fake clock, so audit rows of one test still sort in real order. My first draft of test 5 assumed otherwise and was corrected.

## T2: Location scope (passed)

**Result:** new 8, Phase T cumulative 13 (`test/t2-location-scope.spec.ts` plus the T1 file), all passing in the gate run. The earlier files these changes touch (D1 to D4, E3 to E5, C2, B1) passed together before the gate: 10 files, 84 of 84. The full suite passed: 40 files, 423 of 423 (491.3 s). Lint, type-check, build and the drift check were clean. No schema change and no migration.

**Built (approved by Ian on 2026-10-27, with the seven recommended answers):**
- `LocationScope` (`src/modules/locations/location-scope.ts`), the one place that decides: `resolve(membershipId)` reads the live membership in the current transaction, per command and per request (answer 1). A `FIELD_ATTENDANT` gets the ids of every location assigned to them, archived ones included; everyone else gets "all" without a further query. `ResolvedScope` answers `allows(id)`, `ids()` (null for all) and `digest()` (`"all"`, or the first 16 hex characters of a SHA-256 over the sorted ids, answer 3).
- Commands: `LocationsService.findInScope(id, membershipId)` replaces the plain lookup in `sale.create` and in `stock.receive`, `stock.adjust`, `stock.count` and `stock.convert` (answer 6): outside the scope is `LOCATION_NOT_FOUND`, exactly like a missing location. `payment.attach` and `sale.void` answer `SALE_NOT_FOUND` for a sale at a location outside the scope, checked before any approval is used.
- Reads: `GET /v1/stock` and `GET /v1/stock/movements` add `location_id = ANY(<allowed>)` (a filter outside the scope is the same empty list as an unknown id); `GET /v1/locations` shows a field attendant only their own locations, archived ones with `include_archived=true` (answer 4). Sales reads are unchanged (answer 5). `StockModule` now imports `LocationsModule`.
- Sync: `SyncView.locationIds`; the `location` and `stock_balance` tables page and look up only allowed rows, and send no delete markers (`deletes: false`; the app can delete neither, answer 2). `syncView()` resolves the scope and returns both the view and the cursor view.
- The changes cursor binds `scope` next to `costs` and `all_sales`: a different scope is `410 SNAPSHOT_REQUIRED`, a cursor without `scope` is `422`.
- A field attendant with no assigned location cannot sell (`LOCATION_NOT_FOUND`) and receives no location or balance rows (answer 7).

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 1, no scope check in `sale.create`: T2 test 1 failed (a sale at the main shop was accepted).
- Design 2, no scope filter in the stock reads: T2 test 4 failed (all three locations' balances shown).
- Design 3, no scope filter in `changes` (`stock_balance` lookups): T2 test 5 failed (other locations' balances delivered).
- Design 4, `scope` left out of the cursor comparison: T2 test 6 failed (`200` instead of `410`).

**Earlier tests changed by T2 (mechanical; no assertion weakened):**
- D1 and D2: the hand-built cursor views gain `scope: 'all'`.

**Things to know:**
1. Reassigning a van (archive it, create a new field location for someone else) leaves the old location in the original attendant's scope, so their offline sales into it are still accepted; the new member's scope changes, so their cursor is `410`.
2. My first draft of test 2 expected a sale into a new, empty van to be `ACCEPTED`; it is saved and `FLAGGED / STOCK_NEGATIVE`, as for any sale beyond stock.

## T3: Issue and return (passed)

**Result:** new 11, Phase T cumulative 24 (`test/t3-transfers.spec.ts` plus the T1 and T2 files), all passing in the gate run. The three concurrency tests (20 issues against a balance of 5 and 20 copies of one command; opposite issues and returns with sales at the van; the forced opposite-direction test) passed 5 runs in a row. The full suite passed: 41 files, 434 of 434 (507.8 s). Lint, type-check, build and the drift check were clean. No schema change and no migration.

**Built (approved by Ian on 2026-10-27, with the six recommended answers):**
- `StockService.transfer()` (answer 1): the `stock_transfer` row first (the movements point at it), then every balance statement of both locations in one global order, `inTransferLockOrder()` in `src/modules/stock/lock-order.ts` (answer 2): by location id, then larger `units_per_pack` first, then pack type id. The source is the strict decrease (`decreaseIfAvailable`, `STOCK_INSUFFICIENT` rolls the whole command back), the destination the capped non-strict increase; each statement writes its `TRANSFER_OUT` or `TRANSFER_IN` movement with `quantity_after` and `transfer_id`.
- `StockCommandsService.transfer('ISSUE' | 'RETURN', ...)` and the handlers `stock.issue` and `stock.return` (permission `stock.transfer`). Checks before any write, in this order (answer 4): both locations exist and are in scope (`LOCATION_NOT_FOUND`), kinds (`LOCATION_KIND_INVALID`: an issue goes from an active `SHOP` or `WAREHOUSE` to an active `FIELD` location, a return back), archived state (`LOCATION_ARCHIVED`; a return may come from an archived van), then the lines (answer 5: `DUPLICATE_LINE`, `PACK_TYPE_NOT_FOUND`, `PACK_TYPE_ARCHIVED` on an issue only, `QUANTITY_INVALID` for 1 to 1,000,000 whole). `STOCK_INSUFFICIENT` carries no detail (answer 6).
- The note and reference are stored on the transfer row only (answer 3). Audit `stock.issued` and `stock.returned`: transfer id, kind, both locations and the lines; never the note or reference.
- `MOVEMENT_TYPES` gains `TRANSFER_OUT` and `TRANSFER_IN`, so the movements read can filter by them.

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 5, a non-strict issue: T3 test 2 failed (an issue of 21 against 20 was accepted).
- Design 6, source-first lock order: the forced T3 test 6 failed: Postgres reported `deadlock detected` (in its log) and the return ended `FAILED`. The forced test holds the shop's piece pool in an open transaction, starts the issue (it waits), then the return (with source first it takes the van pool and waits); released, the issue gets the shop pool and needs the van pool. With the global order both wait on the same first pool and both succeed.

**Things to know:**
1. The order of the two waiting commands matters in a forced deadlock test: the transaction first in the lock queue gets the released row. The issue must start first, or the mutation lets the return finish and no deadlock forms.
2. A transfer's balance statements sort across both locations, so a source decrease can run after a destination increase; a short source still rolls everything back (one transaction).

## T4: Settlement (passed)

**Result:** new 13, Phase T cumulative 37 (`test/t4-settlement.spec.ts` plus the T1 to T3 files), all passing in the gate run. The four concurrency tests (two closes at once; a close racing 20 sales; the forced sale-still-saving test; the forced `FOR NO KEY UPDATE` test) passed 5 runs in a row. The full suite passed: 42 files, 447 of 447 (783.5 s). Lint, type-check, build and the drift check were clean.

**The window rule changed (Ian's decision before T4, option B):** the design's rule ("a sale belongs to the first settlement closed at or after its `received_at`") lost a sale whose transaction was still running during a close: the close does not see it, and the next window starts after it. Now a sale or stock movement belongs to the settlement whose snapshot first sees its transaction. The design (section 6, section 9 and mutation 9) and `architecture.md` section 6 are updated in this commit.

**Built (approved by Ian on 2026-10-27, rule B and the ten recommended answers):**
- Migration `*_t4_settlement_window` (generated, shown before applying): `sale.txid` and `stock_movement.txid` (`xid8`, default `pg_current_xact_id()`, `Unsupported("xid8")` in Prisma, as `change_log.txid`), `field_settlement.snapshot` (text), and the index `(business_id, field_location_id, period_end DESC, id DESC)`.
- `FieldSettlementsModule` (`src/modules/field-settlements/`, a data module for the two tables) and `FieldModule` (`src/modules/field/`: `FieldService`, `FieldController`, `CloseSettlementHandler`), answer 2. The ledger, sales, payment and device figures come from their own modules: `StockService.windowFlows/balancesAt/lockBalance/settleCount`, `SalesReadsService.inSettlementWindow`, `PaymentsService.totalsForSales`, `DevicesService.lastSyncOf`, `LocationsService.lockForSettlement/createdAt`.
- `settlement.close` (`field.settle`): checks (amount, `SETTLEMENT_ALREADY_EXISTS`, `LOCATION_NOT_FOUND` for anything but a field location of the business, `ATTENDANT_NOT_SYNCED` beyond `FIELD_SYNC_MAX_AGE_MINUTES` = 10 on the attendant's active devices, answer 6); the location row `FOR NO KEY UPDATE`; every balance row at the location locked in the pack order (rows created meanwhile are locked in further rounds), then the snapshot; the figures under it; every line checked (`DUPLICATE_LINE`, `PACK_TYPE_NOT_FOUND` for a pack type with no balance row there, `QUANTITY_INVALID`, and `{ pack_type_id, reason: 'LINE_MISSING' }` for a pack type with a balance or window movements but no line, answer 4); the settlement row; per line the one-statement set to the count with the difference from the locked row (`StockRepository.setCounted`) and an `ADJUST` (`LOST`/`FOUND`) with `settlement_id`, created by the closer, note "Field settlement: <attendant>" (answer 5); the lines; the audit row `settlement.closed`.
- Preview (`GET /v1/field/settlements/preview`, answer 3): the same figures under the current snapshot, no locks, with `last_synced_at`. Reads: `GET /v1/field/settlements` (newest first by `(period_end, id)`, signed cursor bound to `location_id`) and `GET /v1/field/settlements/:id` with lines; all three need `field.settle` (answer 8).
- `AFTER_SETTLEMENT` (answer 7): `sale.create` at a `FIELD` location whose latest settlement's `period_end` is at or after the sale's `occurred_at`; last in the flag order. Settlements are not synced (answer 9).
- `sale_count` counts every sale of the window, `voided_count` the voided ones among them; `period_start` is the previous `period_end`, or the location's creation (if that is after the close's server time, which only a test clock can do, the close's time).

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 7, `FOR UPDATE` on the location: the forced test failed (a deadlock: the sale's foreign key waits for the location row the close holds, the close for the sale's pool).
- Design 8, the expected quantity taken from the phone: T4 test 2 failed (a close with a phone `expected_quantity` was accepted).
- Design 9, the window by `occurred_at`: T4 test 3 failed. Extra: the window by `received_at` (the design's first rule): the forced sale-still-saving test failed (the sale counted in no settlement).
- Design 10, no `AFTER_SETTLEMENT`: T4 test 6 failed.
- Design 11, reversed payments in the expected cash: two guards keep them out (only `COMPLETED` sales' payments are summed, and only `RECORDED` payments). Removing either one alone changed nothing (reversed payments exist only on voided sales); removing both made T4 test 1 fail (expected cash 1000.00 instead of 640.00).

**Earlier tests changed by T4 (mechanical; no assertion weakened):**
- B5 grants inventory: the `sale` INSERT and SELECT column lists gain `txid` (it is in no UPDATE list).
- T1 tests 2 and 3: their raw settlement insert supplies the new `snapshot` column (without it every later row failed on `NOT NULL` instead of the check under test).

**Things to know:**
1. Payments attached to a sale after its settlement closed are in no settlement's expected cash: the window takes the payments of the window's sales (design rule). Recorded as an open risk for T5.
2. A race test that counts the van down can leave it below zero; a count is never negative. My first draft of the 20-sale race counted the remaining balance as is and was refused (`QUANTITY_INVALID`).
3. `pg_visible_in_snapshot(txid, snapshot)` is the whole window rule. Rows written before T4 got the migration's transaction id, visible in every snapshot, so they fall in a location's first settlement.
