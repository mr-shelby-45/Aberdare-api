# Phase C results

Filled in step by step. The full summary (see `docs/phase-c-design.md` section 15) is written when C6 is finished. Only Ian marks the phase done, in `CLAUDE.md` section 2.

## C1: Schema, triggers, integrity check, housekeeping (passed)

**Result:** new 7, Phase C cumulative 7 (`test/c1-stock-schema.spec.ts`), all passing in the gate run. The concurrency test (20 concurrent consumes of one approval) passed 5 runs in a row. C1 test 1 is the extended inventories in `test/step4-migrations.spec.ts` and `test/b5-hardening.spec.ts`; C1 test 8 is the earlier suites. The first full-suite run failed one test (275 of 276: spike step 2, see below); after the fix the full suite passed once: 20 files, 276 of 276 (285.4 s), with lint, build and the drift check clean.

**Built (approved by Ian on 2026-10-26, with the three recommended answers):**
- Doc updates of design section 16 (commit `b5f1a5f`): the CLAUDE.md phase row for C, and `architecture.md` sections 5, 6, 12, 13 and 16, edited in place.
- Four migrations, replayed and probed in the shadow database before approval:
  - `*_c1_stock_columns` (generated): the ledger columns on `stock_movement` (type, quantity after, phone time, creator, command, unit cost, reason, note, reference, expected and counted quantities), creator, approver and approval on `stock_conversion`, the `approval` table, the approval counters on `membership`, and `sync_command (business_id, id)` as a key target. No default on the new required columns on purpose (both databases had no stock rows).
  - `*_c1_stock_checks`: movement types, signs per type and reason, a reason exactly on `ADJUST`, unit cost only on `RECEIVE`, count quantities exactly on `COUNT` with the delta rule, note and reference lengths; approval purpose, time and consumption checks; the approval counter never negative.
  - `*_c1_approval_rls`: `app_user` SELECT, INSERT, and UPDATE of `consumed_at` and `consumed_by_sync_command_id` only; forced RLS and the NULLIF policy.
  - `*_c1_stock_balance_change_trigger`: the generic `log_product_change()` on `stock_balance` (insert, update, delete; decided).
- `StockService` and `StockRepository` record every movement's type, `quantity_after` (from `RETURNING`), phone time, creator and command (`MovementContext`). The conversion stores its creator and approver. The command context carries the claimed `sync_command` row id.
- `StockIntegrityService.check()`: every pool whose balance differs from its ledger sum, including a balance with no movements and movements with no balance, for the current business only.
- `ApprovalsRepository.consume()`: the consumption statement of design section 6, built now so C5 reuses the tested code (decided).
- Housekeeping (section 9): error logs and the `sync command failed` line carry `errorCode` (SQLSTATE or the error's own code). The redaction of the field name `code` stays.

**Spike code and tests changed by C1 (mechanical; no assertion weakened):**
- The spike's minimal adjust records `ADJUST` with reason `CORRECTION`, sale mode records `SALE`, and the spike conversion records the actor as creator and approver, until C2 and C4 replace them (decided).
- `seedShop` creates a real MANAGER member (`shop.member`): the new composite keys refuse the random actor id the spike step 3 tests used. A manager rather than an owner, because other tests add their own owner and a business has one.
- Spike step 2's check-constraint test inserted raw rows without the new required columns, so after C1 they were refused by a NOT NULL error before reaching the check under test (`stock_movement_quantity_change_nonzero`, `stock_conversion_movements_differ`). Because the test names the check it expects, the first full run caught this (275 of 276) instead of passing for the wrong reason. The raw inserts now give every required column a valid value (the zero movement uses type `SALE`, which has no sign rule), so the targeted check is again the only rule broken. My regex update had covered `stock.*()` calls only, not raw SQL.
- Step 2's 27 stock calls pass a movement context. In the cross-business test the creator is the acting business's own member, so the refusal still comes from the other business's location or pack type, not from a foreign creator. Step 3's actors and B2 test 11's fixture name real members.

**Proof the tests catch mistakes:**
- Design mutation 8, the `stock_balance` change-log trigger removed (test database only): C1 test 4 failed (no balance rows in `change_log`). The trigger was recreated from its migration and its definition checked identical. C2 test 11 will be checked against the same mutation in C2.

**Things to know:**
1. `prisma format` re-aligns unrelated models; the first C1 schema diff was 223 lines for a 75-line change. The schema was restored and edited without formatting.
2. The approval consumption statement takes all times from the caller (the Clock), and the time limits are inclusive at their edges.

**Open for later steps:**
- The real `stock.receive`, `stock.adjust`, `stock.count` and `stock.convert` handlers, the reads and the approval minting (C2 to C5).

## C2: Receive, adjust and reads (passed)

**Result:** new 14, Phase C cumulative 21 (`test/c1-stock-schema.spec.ts` plus `test/c2-stock-commands.spec.ts`), all passing in the gate run. The two concurrency tests (C2 test 5: 20 concurrent receives and 20 copies of one command; C2 test 6: 50 concurrent adjusts of -1 against 10) passed 5 runs in a row. The mechanically changed earlier files (spike step 3, B1) passed once on their own (25 of 25) before the gate. The first full-suite run failed one test (290 of 291: C2 test 10, a test bug, see below); after the fix the gate passed again (21 of 21) and the full suite passed once: 21 files, 291 of 291 (219.1 s), with lint and type-check clean. Build and the drift check were clean in the first run, and only a test file changed after it.

**Built (approved by Ian on 2026-10-26, with the six recommended answers):**
- One migration, generated and declared in `schema.prisma`: `*_c2_stock_movement_history_index`, `stock_movement (business_id, occurred_at DESC, id DESC)` for the movement history. Replayed in the shadow database first; the drift check was clean.
- `stock.receive` and `stock.adjust` (design section 5) in `StockCommandsModule` (answer 1: a module above stock, products and locations, because `ProductsModule` already imports `StockModule`). They replace the spike's minimal handlers and their camelCase payloads.
- Every delivery line is checked before anything is written; a bad delivery lists every bad line and saves nothing. A malformed command is `VALIDATION_FAILED` as a whole, a bad value is a line reason, and an archived product's pack type is `PACK_TYPE_ARCHIVED` (answer 4).
- Lines are applied larger pack first, then by pack type id: the conversion lock order, so deliveries cannot deadlock each other or a conversion. Found while building; not in the design text, now in `architecture.md` section 6.
- The 2,000,000,000 cap is a `WHERE` on the upsert's conflict branch (answer 5): one atomic statement, `VALIDATION_FAILED` when it stops the change.
- `GET /v1/stock` and `GET /v1/stock/movements` (design section 7), with the read-only joins documented as the one exception to the module rule (answer 3), and the shared `SignedCursor` (answer 6), which also binds the filters.
- Audit `stock.received` and `stock.adjusted`, actor passed explicitly. Audit metadata may now nest objects and arrays (answer 2); the forbidden-key check runs at every level.
- `CommandRejectedError` can carry `data` (the `result` of `INVALID_LINES`), and `CatalogueHandlers` became `CommandHandlers`.

**Spike and earlier tests changed by C2 (mechanical; no assertion weakened):**
- Spike step 3 now uses the app's own `SyncService` and stock handlers with the C2 payloads (`location_id` plus `lines`; adjust as a negative `quantity_change` with reason `CORRECTION`), and expects the C2 result shapes.
- Two expected codes changed because the design changed them: a quantity of 0 or 2.5 is now `INVALID_LINES` (with `QUANTITY_INVALID` for line 1, now also asserted), and another business's location is now `LOCATION_NOT_FOUND`. The string `"5"` and an unknown `business_id` are still `VALIDATION_FAILED`.
- The dispatcher's foreign-key backstop (`INVALID_REFERENCE`) was only reached through the spike's receive. To keep that proof, step 3 gained a test with a test-only handler that writes a foreign reference without checking, and still expects `INVALID_REFERENCE` with nothing stored.
- B1 test 4 uses the app's dispatcher and fake clock (the expected `received_at` is the app clock's time instead of a second clock's).

**Proof the tests catch mistakes** (each applied, shown failing, reverted, revert checked with `cmp` or the trigger definition's md5):
- Mutation 1, the valid lines of a bad delivery saved: C2 test 2 failed (the command was `ACCEPTED`).
- Mutation 2, adjust reads the balance, checks it in JavaScript, then writes: C2 test 6 failed (`[18, 32]` instead of `[10, 40]`: 18 adjusts accepted against a balance of 10).
- Mutation 7, `unit_cost` accepted without `costs.view`: C2 test 4 failed (the manager's cost lines were `ACCEPTED`).
- Mutation 8, the `stock_balance` change-log trigger dropped (test database only): C2 test 11 failed (no `change_log` rows). The trigger was recreated from its migration; definition md5 `7ee6bf7f6b6e7c07f8e75f3804871667` before and after.

**Things to know:**
1. Rows written in one transaction share `created_at`, so two first runs of my tests failed on order, not on behaviour (an audit order by time and name, and a movement time measured after the clock had moved). The tests were corrected, not loosened: the lock order is checked through `change_log.id`, and same-transaction rows are compared as a set.
2. The first full run failed C2 test 10 on its own check: "the audit text never contains 177" (from the cost 177.25) matched a random UUID containing 4177. It now looks for the exact value 177.25 and for quoted key names (`"unit_cost"`, `"note"`, ...); a first try with `cost"` matched the approved `with_cost` flag and was corrected too. The audit row never held a cost.
3. Product list cursors issued before C2 are refused once (the cursor format changed).

**Open for later steps:**
- `stock.count` (C3), `stock.convert` (C4), approvals (C5), hardening (C6).

## C3: Count (passed)

**Result:** new 8, Phase C cumulative 29 (C1, C2 and `test/c3-stock-count.spec.ts`), all passing in the gate run. The concurrency test (C3 test 3: 10 counts over two pools and 20 sale-mode decreases at once) passed 5 runs in a row. The first full-suite run failed 3 tests (296 of 299) during a machine slowdown: it took 1085 s instead of about 220 s, and only password-hashing timing tests failed (two hit Vitest's 5 s limit, one timing ratio was 0.37 against 0.5); C3 touches no hashing code. Rerun unchanged, the full suite passed: 22 files, 299 of 299 (287.0 s). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the four recommended answers):** no migration (C1 had the count columns and checks).
- `stock.count` (`CountStockHandler`, `StockCommandsService.count()`, `StockService.count()`): per line `counted minus expected`, the phone's expected number, with the non-strict statement. All lines are checked first; a bad line rejects the whole count with every bad line listed (`DUPLICATE_LINE`, `PACK_TYPE_NOT_FOUND`, `QUANTITY_INVALID`). Archived locations and pack types may be counted. Lines are applied in the shared lock order (`inLockOrder()`, now used by receive too).
- Answer 1: a zero-delta line writes no movement, but is in the result (`quantity_after` by a plain read) and in the audit row.
- Answer 2: counted 0 to 2,000,000,000; expected and the delta within -2,000,000,000..2,000,000,000.
- Answer 3: the balance statement got a floor: `WHERE stock_balance.quantity::bigint + EXCLUDED.quantity BETWEEN -2000000000 AND 2000000000` (bigint so the sum cannot overflow before the compare). This is the one change to C2 code; the C2 cap test still passes.
- Answer 4: `FLAGGED / NEGATIVE_AFTER_COUNT` when any counted pool ends below zero, including a zero-delta line that was already negative. A flagged count is saved and a retry gets the same answer.
- Audit `stock.counted` with lines of `{ pack_type_id, expected, counted, delta }`, never the note.
- Test helpers for C3 on: `test/helpers/stock-api.ts`. The C2 file keeps its own copy (unchanged).

**Proof the tests catch mistakes:**
- Mutation 3, the count sets the balance to the counted number (read the balance, then change it to `counted`): C3 test 2 failed (the sales between the count and its arrival were lost). Reverted; `cmp` identical.

**Things to know:**
1. Timing tests of the password hasher fail when the machine is overloaded (see the first full run). They are not weakened; a full run that takes several times longer than usual is rerun.

## C4: Convert for managers and owners (passed)

**Result:** new 8, Phase C cumulative 37 (C1 to C3 and `test/c4-stock-convert.spec.ts`), all passing in the gate run. Both concurrency tests (C4 test 4: 20 conversions against 5 cartons with 20 piece sales at once; case-to-carton and carton-to-piece conversions with sales at once) passed 5 runs in a row. The mechanically changed spike step 2 and C1 files passed once on their own (21 of 21). The full suite passed once: 23 files, 307 of 307 (247.2 s), with lint, type-check, build and the drift check clean.

**Built (approved by Ian on 2026-10-26, with the four recommended answers):** no migration (C1 had the conversion columns).
- `stock.convert` (`ConvertStockHandler`, `StockCommandsService.convert()`, `StockService.convert()`): `quantity` larger packs (1 to 100,000) become `quantity x ratio` smaller packs of the same product, at one location, in one transaction: strict source decrease, `CONVERT_OUT`, capped target increase, `CONVERT_IN`, one `stock_conversion` row with creator and approver. Larger pack first (the lock order). Reasons: `LOCATION_NOT_FOUND`, `PACK_TYPE_NOT_FOUND`, `PACK_TYPES_NOT_CONVERTIBLE`, `CONVERSION_RATIO_INVALID`, `STOCK_INSUFFICIENT`, `VALIDATION_FAILED` (over the cap, or a malformed payload). Archived locations and pack types are allowed.
- Answer 1: the dispatcher permission is `stock.view`; the handler requires `stock.convert` itself (C5 adds "or a valid approval").
- Answer 2: the spike's `convertOne` is replaced; spike step 2 and C1 call `convert(…, 1, …)`, step 2 expects `PACK_TYPES_NOT_CONVERTIBLE` (was `STOCK_CONVERSION_INVALID`) and reads `unitsAdded` (was `toQuantity`). Same refusal, same proofs.
- Answer 3: `approval_id` is accepted now; a member with `stock.convert` has it ignored and not consumed; an attendant is `PERMISSION_DENIED` until C5.
- Answer 4: `stock.convert` written into an attendant's extras as the superuser (test setup) is still refused by the live check.
- Audit `stock.converted` (location, from, to, quantity, units added, approver, `approval_id: null`), never the note.

**Proof the tests catch mistakes:**
- Mutation 4, no strict guard on the source (the non-strict statement instead): C4 test 3 failed (the conversion was `ACCEPTED` with one carton for two). Reverted; `cmp` identical.

**Things to know:**
1. The first C4 run failed one test on its own setup (a superuser `INSERT` of a balance row the first conversion had already created); the setup now raises the existing row with a matching movement.
