# Phase T results

**Status: all six steps (T1 to T6) passed. Waiting for Ian's review.** Only Ian marks Phase T done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-t-walkthrough.md`.

**Final suite (end of phase, after T6, 3 runs in a row):** 3 runs done, all passed, on the working tree this commit records (run on 2026-10-28, after the B3 connection reset recorded in the T6 section). Run 1: 45 files, 462 of 462 (882.4 s, cold start). Run 2: 45 files, 462 of 462 (622.9 s). Run 3: 45 files, 462 of 462 (614.8 s). Lint, type-check, build and the drift check were clean before the runs. Earlier failed runs during Phase T are recorded in their step sections below, as observed. The T5 commit's 3 runs (44 files, 454 of 454 each) are recorded in the T5 section.

## Summary

| Step | What it built | New tests | Phase T cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| T1 | `location.kind` and `assigned_membership_id`, `stock_transfer`, `field_settlement`, `field_settlement_line`, transfer and settlement movement columns, checks, grants, RLS, the one-active-van index; the `FIELD_ATTENDANT` preset, `stock.transfer` and `field.settle`; doc updates | 5 | 5 | Location UPDATE limited to three columns (kind and assignee never change); two earlier exact-list tests (A3, B5 walkthrough) missed in the survey, caught by the first full run |
| T2 | `LocationScope`: commands, stock and location reads, snapshot and changes; the cursor binds `scope` | 8 | 13 | No schema change; `location` and `stock_balance` send no delete markers |
| T3 | `StockService.transfer()`, `stock.issue`, `stock.return`, the global transfer lock order | 11 | 24 | No schema change; the forced deadlock test must start the issue first |
| T4 | `settlement.close`, preview, list and detail reads, `AFTER_SETTLEMENT` | 13 | 37 | The window rule changed to the snapshot rule B (Ian's decision); `txid` on `sale` and `stock_movement`; mutation 11 needed both guards removed |
| T5 | Randomized field workload (3 seeds), logs, audit, walkthrough document and test; the settlement order fix (`sequence`, `period_end` after the lock) and its forced regression test | 7 | 44 | The workload found settlements ordered by arrival time instead of commit; fixed with Ian's approval (two migrations) |
| T6 | Payments in the settlement window: a payment counts in the settlement that first sees it, a reversal out; only the attendant's own payments on their personal devices; `earlier_sales_cash`; negative expected cash allowed | 8 | 52 | Added after T5 at Ian's request (open risk 1 of T5); three migrations; three earlier tests changed mechanically; the T5 workload gained `payment.attach` and a cash recomputation |

New tests count `it` cases as Vitest reports them; the T5 workload is one case per seed (three). T5's seven are five in `test/t5-hardening.spec.ts`, one in `test/t5-walkthrough.spec.ts`, and the regression test added to `test/t4-settlement.spec.ts`. T6's eight are all in `test/t6-payment-window.spec.ts`.

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Location scope | One helper decides, from the live membership, per command and per request: a `FIELD_ATTENDANT` is limited to the locations assigned to them (archived ones included), everyone else sees all. Out of scope is exactly "not found" (`LOCATION_NOT_FOUND`, `SALE_NOT_FOUND`, an empty list). Commands use `findInScope()`, reads put `scopeOf().ids()` in the query, sync gets it through `syncView()`; the changes cursor binds the scope digest (`410` on change) | `src/modules/locations/location-scope.ts`, `LocationsService.findInScope`, `syncView()`, `ChangesCursor` |
| Transfer lock order | Every balance statement of one transfer, on both locations, in one global order: location id, then larger pack first, then pack type id. Source strict (`STOCK_INSUFFICIENT` rolls back everything), destination capped. One `stock_transfer` row, then a `TRANSFER_OUT` and a `TRANSFER_IN` per line with `quantity_after` and `transfer_id` | `inTransferLockOrder()` in `src/modules/stock/lock-order.ts`, `StockService.transfer` |
| Settlement close | Lock the location row `FOR NO KEY UPDATE` (never `FOR UPDATE`: every sale's foreign key takes `FOR KEY SHARE` on it); lock every balance row at the location in the pack order; take `pg_current_snapshot()`; compute the figures under it; per line one `UPDATE stock_balance ... FROM (SELECT ... FOR UPDATE) old RETURNING old.quantity` sets the count and gives the difference in SQL; a nonzero difference writes `ADJUST` `LOST` or `FOUND` with `settlement_id`; then the settlement and its lines, then the audit row | `FieldService.close`, `StockRepository.setCounted`, `LocationsService.lockForSettlement` |
| Settlement window and order | A sale or movement belongs to the settlement whose snapshot first sees its transaction (`pg_visible_in_snapshot(txid, snapshot)` true now, false for the previous one); never a time window. Settlements of a location are ordered by `sequence` (previous + 1 under the location lock, unique per location); `period_end` is the server time after the lock, never before the previous one | `FieldSettlementsRepository.latest`, `SalesReadsService.inSettlementWindow`, `StockService.windowFlows` |
| Payments in settlements (T6) | A payment counts + in the settlement whose snapshot first sees `payment.txid`, and - in the one that first sees `payment.reversed_txid` (set by the void with `REVERSED`); never the status now. Only payments with `created_by_membership_id` = the attendant and `recorded_by_device_id` among their personal devices (`device.registered_by_membership_id` = the attendant, `is_shared = false`, any status). `earlier_sales_cash` is the cash of sales outside the window | `PaymentsRepository.windowTotals`, `DevicesService.personalDeviceIdsOf`, `FieldService.figures` |
| `AFTER_SETTLEMENT` | A sale at a `FIELD` location whose latest settlement's `period_end` is at or after the sale's `occurred_at` is saved and flagged, last in the flag order; it counts in the next settlement | `SalesService` (`afterSettlement`) |

## Proof the tests catch mistakes

Each design mutation was applied temporarily, the named test was shown failing, and the change was reverted (checked byte for byte with `cmp`; no `MUTATION` marker left).

| Mutation | Test that failed | What it caught |
|---|---|---|
| 1. No scope check in `sale.create` | T2 test 1 | a field attendant's sale at the main shop accepted |
| 2. No scope filter in the stock reads | T2 test 4 | all three locations' balances shown |
| 3. No scope filter in `changes` | T2 test 5 | other locations' balances delivered |
| 4. `scope` left out of the cursor comparison | T2 test 6 | `200` instead of `410` |
| 5. A non-strict issue | T3 test 2 | an issue of 21 against 20 accepted |
| 6. Source-first lock order | forced T3 test 6 | `deadlock detected`, the return `FAILED` |
| 7. `FOR UPDATE` on the location row | forced T4 test 7 | a deadlock between the close and a sale |
| 8. The expected quantity taken from the phone | T4 test 2 | a phone `expected_quantity` accepted |
| 9. The window by `occurred_at` | T4 test 3 | sales in the wrong settlement |
| 10. No `AFTER_SETTLEMENT` | T4 test 6 | a late sale not flagged |
| 11. Reversed payments in the expected cash | T4 test 1, with both guards removed | expected cash 1000.00 instead of 640.00; either guard alone holds |
| 12. Extra permissions for a field attendant | T1 test 4 | `201` instead of `422` |
| Extra (T4): the window by `received_at` (the design's first rule) | forced T4 sale-still-saving test | a sale counted in no settlement |
| T6-1. Payments counted by their sale's window (the T4 rule) | T6 tests 1 and 3 (forced) | the late payment and the payment still saving during the close counted nowhere |
| T6-2. Reversals not subtracted | T6 test 2 | the late refund missing from the next settlement |
| T6-R1. `created_by_membership_id` not checked | T6 test 6 | a manager's payment on the hawker's phone counted |
| T6-R2. `registered_by_membership_id` not checked (any non-shared device) | T6 test 8 | the hawker's payment on the manager's phone counted |
| T6-R3. `is_shared` not checked | T6 test 4 | the hawker's payment on a shared tablet they registered counted |
| T6-R4. Active devices only | T6 test 5 | the payment on the later revoked phone dropped |
| T6-R1 and R2 together | T6 test 7 | a manager's payment on their own device counted; with either rule alone in place test 7 passed (two guards) |
| Extra (T5): the previous settlement by `period_end`, and `period_end = received_at` (the T4 code) | forced T4 test "7. ... arrives first but commits second" | the early close `FAILED` on the period check |

## Versions

Unchanged. No library was added in Phase T (`package.json` and `pnpm-lock.yaml` are as at the end of Phase E).

## Things to know

1. A forced race test holds a row in an uncommitted admin transaction and waits for lock waiters in `pg_stat_activity` (`lockWaiters()`); the transaction first in the lock queue gets the released row, so start the commands in the order the test needs.
2. The test clock moves only when told, so two commands often carry the same time. Never order business events by a time column where a tie is possible; settlements now use `sequence`.
3. `pg_visible_in_snapshot(txid, snapshot)` is the whole window rule. Rows written before T4 carry the T4 migration's transaction id, visible in every snapshot, so they fall in a location's first settlement.
4. A settlement close needs the attendant's phone synced within 10 minutes; a sync read stamps `last_sync_at` at most once every 5 minutes.
5. The T5 workload prints its seed in the test name; `T5_SEED=<n> pnpm exec vitest run test/t5-hardening.spec.ts -t randomized` replays one. It uses a new IP and phone range per test, because the auth routes are rate limited per IP.
6. A failed migration on the test database (for example a `NOT NULL` column added while rows are left over from the last test) stays recorded as failed: wipe `aberdare_test` (tests only wipe before each test, not after), run `prisma migrate resolve --rolled-back <name>` against it, then deploy again.

## Open risks

1. Fixed in T6 (was: payments attached after a sale's settlement, and refunds of settled sales, were counted in no settlement). What remains: whether a device is personal is read at the close (`is_shared` now), so a phone changed to shared after it took cash no longer counts that cash; the owner changes it only through the audited device API.
2. The server cannot know whether a field attendant's offline outbox is empty (design open item 8). `ATTENDANT_NOT_SYNCED` and `AFTER_SETTLEMENT` reduce the risk but do not remove it.
3. The sync stamp moves at most every 5 minutes, so "synced within 10 minutes" can be up to 5 minutes older than the last real sync.
4. The close locks balance rows created while it is locking in further rounds, at most 5, then goes on with the rows it holds. A pool created after that (a new pack type issued to the van during the close) may be left out of this close's counted lines (not tested). Only a location gaining new pack types continuously during the close could reach this.
5. M-Pesa codes are unverified until Phase M; settlement M-Pesa totals are all `mpesa_unverified_total`, and typed codes can be fake (design open item 6).
6. Every `sale.create` of a business still queues on `sale_counter` (architecture open item 56); field sales add phones to that queue.
7. Overload still answers 500 instead of 503 (spike open risk 4, unchanged).
9. A command from an actor the API cannot produce (a manager on a hawker's personal phone, the hawker on someone else's) was tested only through the dispatcher; through the API a personal phone only ever logs in its owner.
10. One full run after T6 lost a database connection (`read ECONNRESET`) in B3's 20-request concurrency test, with nothing in the Postgres log; probably Docker Desktop's port forwarding on this laptop under load. Watch for it on the hosted database in Phase H.
11. Design open items 1 to 5, 7, 9 and 10 (stock acknowledgement, hawking prices, settlement history on phones, a cash and shortage ledger, customer credit, generic transfers, long offline days, variance notifications) are not built.

## Changes to the other documents

- `CLAUDE.md`: the phase table row for T (T1); section 8 notes for the field schema, the location scope, transfers, settlements, and the settlement order with the T5 workload replay and walkthrough (T1 to T5). The status line was not touched.
- `docs/architecture.md`: sections 4, 5, 6, 12, 13, 14 and 16 (T1), "as built" notes for the scope, transfers and settlements (T2 to T4), the window rule B (T4), the settlement `sequence` and `period_end` after the lock (T5).
- `docs/phase-t-design.md`: the window rule B in sections 6, 9 and 11 (T4); `sequence` and `period_end` in sections 3 and 6 (T5).
- `docs/phase-t-walkthrough.md`: new (T5).
- T6: `docs/phase-t-design.md` sections 3 and 6 (the payment rule, `earlier_sales_cash`, negative totals), `docs/architecture.md` (the payment table and the settlement "as built" note), and a `CLAUDE.md` section 8 note.

# Step details

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

## T5: Hardening and handover (passed)

**Result:** new 7, Phase T cumulative 44 (all six Phase T files: 44 of 44, 145.7 s), all passing in the gate run. The randomized workload (seeds 707, 808 and 909) passed 5 runs in a row after the fix below (15 of 15 seed runs); before it, every seed failed. The T4 concurrency tests, with the new forced one, passed 5 runs in a row. The walkthrough passed as a test, and once over real HTTP against the built API (`node dist/main`, port 3100) on the test database: 30 of 30 checks, and none of the names, the reference, the note, the M-Pesa code, the cash received, the phones, the PINs or the fixed code in the API's 137 log lines (and no error line). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-27, with the six recommended answers):**
- `test/t5-hardening.spec.ts`:
  - Test 1, the randomized workload (answer 1): two businesses (A with a shop, a warehouse and two field attendants; B with one), 10 waves of 20 operations through the real API: field sales (cash, M-Pesa, split, none; sometimes into the attendant's older van), issues from the shop or warehouse, returns, manager voids, settlements (the phone syncs first; counts near the balance, never below zero), receives and counts, phone syncs; in wave 5 the first attendant's van is archived and they get a new one. Checked: no command `FAILED` and only expected outcomes per kind; every kind succeeded at least once; integrity clean for both businesses; every sale in exactly the settlement whose snapshot first sees it, or in none yet (answer 3, checked in SQL with the stored snapshots and `sequence`); each settlement's lines satisfy the ledger identity (opening plus issued minus returned minus sold plus voided back plus other equals expected, and counted minus expected equals the variance); every location an attendant ever received was assigned to them; settlements ran; nothing crossed businesses (answer 2). Seeded (mulberry32), replayable with `T5_SEED`.
  - Test 2, logs: marker text in a product name, a van name, the transfer reference and note, the settlement note, a price, the M-Pesa code and the cash received; an issue and a return, a field sale, a close, a refused close, the preview, list, detail, movements and locations reads, and changes. No marker, cursor or PIN in any log line, and none of the keys `lines`, `note`, `reference`, `cash_received`, `counted_quantity`, `mpesa_code`.
  - Test 3, audit: `stock.issued`, `stock.returned`, `settlement.closed` and `location.archived` (with kind and assignee) exactly once each, by the acting member; a short issue, a return to a field location and a close of a shop write nothing; settlements are not a sync table.
  - Test 4 (grants) is the B5 inventory and T1 test 1; the crash-after-audit checks are T3 test 8 and T4 test 10 (answer 4; not duplicated).
- `docs/phase-t-walkthrough.md` and `test/t5-walkthrough.spec.ts` (test 5): the eight steps of design section 12 with phones `0712000601` to `0712000603` and `0712000609` (answer 5). In step 7 the late offline sale is the piece counted as missing in step 6, so it is flagged `STOCK_NEGATIVE` and `AFTER_SETTLEMENT` and counts in the next settlement.
- This results file (test 6), with the open risks of answer 6.

**The settlement order bug (found by test 1, fixed with Ian's approval):**
- Seen: sales in the wrong number of settlements in every seed (35, 51 and 14 sales).
- Cause: the close found the previous settlement by the latest `period_end`, and `period_end` was the command's `received_at`, taken when the command arrived, before it waited for the location lock. With the test clock two closes often had the same time (the tie broken by id, at random). In production a close that arrives first but waits for the lock commits second, yet looked older. Either way a close could take the wrong previous snapshot, and its window counted sales already counted, or left some out.
- Fix: `field_settlement.sequence` (1, 2, 3... per location, previous + 1, assigned while holding the location lock, unique per location); the previous settlement is the highest `sequence`. `period_end` is the clock time after the lock, never earlier than the previous `period_end`, so the times shown to people also follow the commit order.
- Migrations (shown to Ian before applying): `20261027190000_t5_settlement_sequence` (`sequence INTEGER NOT NULL` and the unique index `field_settlement_business_id_field_location_id_sequence_key`) and `20261027190001_t5_settlement_period_check` (the check becomes `period_end >= received_at AND period_start <= period_end`; new check `sequence >= 1`). Dev had no settlements and took them as written. The test database still held settlement rows from the last test run (tests wipe before each test, not after), so the first migration failed there on `NOT NULL`; I wiped `aberdare_test` (truncate), marked the migration rolled back (`prisma migrate resolve --rolled-back`) and deployed both again. The migration has no default on purpose: there are no real settlements yet.
- Proof: a new forced test in `test/t4-settlement.spec.ts` holds an early close at its command claim (an uncommitted `sync_command` row with its command id), lets a later close finish, then releases the early one: the sequences are later 1, early 2; the early close's `period_start` is the later close's `period_end`; over a third close the sale counts are 1, 0, 1. With the old ordering and `period_end` put back, the test failed (the early close `FAILED` on the period check); reverted, `cmp`.

**Earlier tests changed by T5 (mechanical; no assertion weakened):**
- T1 tests 2 and 3: the raw settlement insert supplies `sequence` (next per location).

**Things to know:**
1. My first T5 audit test logged many staff in from one IP and hit the auth rate limit (`RATE_LIMITED`); each test now uses its own IP and phone range.
2. The real-API run used a script in the session scratchpad (not in the repo): it wipes `aberdare_test` (it refuses any other database), runs the eight steps with `fetch`, and checks each answer.

## T6: Payments in the settlement window (passed)

**Result:** new 8, Phase T cumulative 52 (all seven Phase T files: 52 of 52, 120.8 s), all passing in the gate run. The forced test (an attach still saving during a close) passed 5 runs in a row, and the extended T5 workload passed 5 runs in a row (15 of 15 seed runs). Lint, type-check, build and the drift check were clean.

**Why:** T5's open risk 1, raised by Ian: a hawker sells on credit in the morning, the customer pays at 6pm, the settlement closed at 5pm, and that cash was expected at no settlement. Checking the code showed the other half: a void after a sale's settlement refunded the customer from the hawker's cash, and nothing took it off the next settlement.

**Built (approved by Ian on 2026-10-27, with the four recommended answers and his device rule):**
- Migrations (shown to Ian before applying; replayed in the shadow database first, 11 of 11 probes as expected):
  - `20261027200000_t6_payment_window` (generated): `payment.location_id` with the foreign key `(business_id, sale_id, location_id)` to the new unique key `sale (business_id, id, location_id)` (the copy can never differ from the sale's), `payment.recorded_by_device_id` (foreign key to the device), `payment.txid` (`xid8`, default `pg_current_xact_id()`), `payment.reversed_txid`, the index `(business_id, location_id)`, and `field_settlement.earlier_sales_cash`. The `NOT NULL` columns have no default: dev and test held no payments or settlements, and the migration role could not backfill under forced RLS anyway.
  - `20261027200001_t6_payment_window_checks`: `payment_reversed_txid_with_status` (`reversed_txid` set exactly when `REVERSED`); `field_settlement_cash_not_negative` now covers only `cash_received` and `unpaid_total` (answer 1: negative expected cash is stored as it is).
  - `20261027200002_t6_payment_reversed_grant`: `app_user` may update `reversed_txid` (besides `status`).
- Payments record the sale's location and the actor's device (`sale.create` and `payment.attach`); the void sets `REVERSED` and `reversed_txid` in one statement.
- `PaymentsRepository.windowTotals()` replaces `totalsForSales()`: per payment, + when the snapshot first sees `txid`, - when it first sees `reversed_txid`; by method and verified or not; `earlier_sales_cash` is the cash of sales outside the window.
- The device rule (answer 2 as Ian refined it): a payment counts only when `payment.created_by_membership_id` is the attendant and `payment.recorded_by_device_id` is one of their personal devices. A device is personal to the attendant by two columns of `device`: `registered_by_membership_id` = the attendant and `is_shared = false`, in any status. `device_membership` (links) applies only to shared devices and plays no part. Refunds follow the same rule (answer 3). `DevicesService.personalDeviceIdsOf()` supplies the ids, so the payments module never reads the device table.
- `earlier_sales_cash` is stored, and shown in the preview, list and detail (answer 4).

**Tests (`test/t6-payment-window.spec.ts`):**
1. A credit sale, close; the payment after the close: the next settlement expects 360.00, all of it `earlier_sales_cash`; a third settlement expects nothing; the first is unchanged.
2. A cash and M-Pesa sale settled, then voided: the next settlement has expected cash -300.00, M-Pesa -240.00, a variance of +300.00 for nothing received; both payments have `reversed_txid`; the database refuses a reversal without it and a payment at another location than its sale.
3. Forced: an admin transaction holds the sale row, so `payment.attach` has claimed its command and waits; the close runs meanwhile and does not count it; released, the payment counts in the next settlement.
4. Ian 1: the hawker records payments on the owner's shared tablet and on a tablet they registered that was then made shared: neither is expected; their phone's 50.00 is.
5. Ian 2: a payment on the hawker's phone, then the phone is revoked (the close uses a second personal phone for the sync check): still expected.
6. Ian 3: a manager's payment on the hawker's personal phone: not expected.
7. Ian 4: a manager attaches a payment from their own phone to a hawker's sale: not expected.
8. The hawker's payment on the manager's personal phone: not expected.
- Tests 6 and 8 send the command through `SyncService.processCommands()` with a hand-built actor: through the API a PIN login on a personal phone is always its registrant, so neither can happen today. They prove the rule holds in the query (Ian's "each rule has a mutation").
- The T5 workload gained `payment.attach` (by the attendant, counted, or by the manager, not) and a check that recomputes every settlement's expected cash, M-Pesa total and `earlier_sales_cash` in independent SQL from the stored snapshots; every seed must produce at least one settlement with late payments or refunds.

**Runs after the fixes below, as observed:** the workload passed 5 more runs in a row (15 of 15 seed runs), then the gate. Of the next 3 full runs, runs 1 and 2 passed (462 of 462); run 3 failed 1 test: B3 test 3 (20 concurrent barcode adds) ended with `read ECONNRESET`, the database connection dropped on the client side. Postgres logged no crash, `FATAL` or restart, the container stayed up, and free memory was 4.7 GB; nothing in that test touches payments or settlements. B3 then passed alone 5 runs in a row (8 of 8 each), and the 3 full runs in the final suite line were run again from the start. Open risk: a dropped connection under concurrent load on this laptop (Docker Desktop port forwarding), not explained further.

**Mutations:** see the proof table above (T6-1, T6-2, T6-R1 to R4, and R1 with R2). Each was reverted and checked with `cmp`; no `MUTATION` marker left.

**Earlier tests changed by T6 (mechanical; no assertion weakened):**
- E1: the raw payment insert supplies `location_id` and `recorded_by_device_id`; the three raw reversals set `reversed_txid` with the status (the new check refused the status alone); the cross-business payment's expected constraint name is now the three-column foreign key.
- E3: the held-open original payment is inserted with its sale's location and device.
- B5 grants inventory: payment's INSERT and SELECT columns gain the four new columns, UPDATE gains `reversed_txid`.
- T5 workload: the reassignment issue at wave 5 now first receives the shop's shortfall (read from the balances). Adding attaches changed the random sequence, and the fixed issue was refused (the assertion did not print the reason; it now does): a random `stock.count` applies the phone's difference (counted minus its expected, as designed in C3), so the shop can be far below zero. A first fix received a fixed 20 pieces and 3 cartons; the gate after it still failed once on seed 707 (passed 4 replays alone: the shortfall depends on how earlier waves interleave), so it was replaced by the exact shortfall. A test setup problem, not a fault.
- `test/helpers/stock-api.ts`: `call()` accepts `DELETE`.
- T1 tests 2 and 3: the raw settlement insert supplies `earlier_sales_cash` (0).
- E6 test 4: the raw reversal sets `reversed_txid` with the status (same as E1).
- The first gate (50 of 52) and the first 3 full runs (459 of 462 each, the same 3 tests every run) failed on exactly these two: my survey before the runs missed them. After the fix both files passed (12 of 12), and the gate and the 3 full runs were run again from the start.

**Things to know:**
1. My first draft of T6 tests 4, 6 and 7 paid more than a sale's total (flagged `OVERPAYMENT`) or less (a balance due in `unpaid_total`); the amounts were corrected.
2. A field settlement's cash figures now never depend on a sale's status at the close: only on which transactions each snapshot sees.
