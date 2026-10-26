# Phase C results

**Status: all six steps (C1 to C6) passed. Waiting for Ian's review.** Only Ian marks Phase C done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-c-walkthrough.md`.

**Final suite (end of phase, 3 runs in a row):** 3 runs done, all passed, on the working tree this commit records. Run 1: 26 files, 325 of 325 (421.7 s). Run 2: 26 files, 325 of 325 (346.2 s). Run 3: 26 files, 325 of 325 (374.2 s). Lint, type-check, build and the drift check were clean before the runs. Earlier failed runs during Phase C are recorded in their step sections below, as observed.

## Summary

| Step | What it built | New tests | Phase C cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| C1 | Ledger columns, checks, `approval` table and grants, `stock_balance` change-log trigger, integrity check, approval consumption statement, `errorCode` in logs | 7 | 7 | Spike step 2 raw inserts given the new required columns (a NOT NULL hit before the targeted check); `seedShop` creates a real manager |
| C2 | `stock.receive`, `stock.adjust`, `GET /v1/stock`, `GET /v1/stock/movements`, movement history index | 14 | 21 | `StockCommandsModule` (module cycle); nested audit metadata; read-only joins exception; shared `SignedCursor`; lines applied in the lock order; cap inside the upsert |
| C3 | `stock.count` (counted minus expected, `FLAGGED / NEGATIVE_AFTER_COUNT`) | 8 | 29 | Balance floor added to the upsert (bigint check); one full run failed hashing timing tests under machine load, rerun clean |
| C4 | `stock.convert` for managers and owners | 8 | 37 | Handler checks `stock.convert` itself (dispatcher: `stock.view`); spike `convertOne` replaced by `convert` |
| C5 | Approvals: approvers list, PIN-minted approvals, own counters, the approval path of convert | 10 | 47 | `@OwnTransactions()` on the approvals route (approved); `SyncActor.deviceId` and `receivedAt` for handlers |
| C6 | Randomized workload (3 seeds), logs, audit coverage, grants, walkthrough document and test | 8 | 55 | `DAMAGED` adjust in place of a sale in walkthrough step 7 (no sale endpoint until Phase E) |

New tests count `it` cases as Vitest reports them; the C6 workload is one case per seed (three).

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Ledger and balance | One movement row plus one balance statement per change, in the same transaction. Movements record type, `quantity_after` (from `RETURNING`), phone time, creator and sync command. Never updated or deleted (`app_user` has SELECT and INSERT only) | `stock.repository.ts`, `stock.service.ts` |
| Strict decrease | `UPDATE stock_balance SET quantity = quantity - $q ... WHERE ... AND quantity >= $q RETURNING quantity`; no row means `STOCK_INSUFFICIENT` | `StockRepository.decreaseIfAvailable` |
| Non-strict change | `INSERT ... ON CONFLICT DO UPDATE SET quantity = stock_balance.quantity + EXCLUDED.quantity ... WHERE stock_balance.quantity::bigint + EXCLUDED.quantity BETWEEN -2000000000 AND 2000000000 RETURNING quantity`; no row means `VALIDATION_FAILED` | `StockRepository.changeBalance` |
| Count rule | `delta = counted - expected` (the phone's number), applied non-strictly; a zero delta writes nothing; any counted pool below zero flags the command | `StockService.count`, `StockCommandsService.count` |
| Lock order | Every multi-balance operation changes the larger pack first, then by pack type id (`inLockOrder()`); a conversion goes larger to smaller, so no cycle is possible | `stock-commands.service.ts`, `StockService.convert` |
| Invalid lines | Every line checked before any write; a bad line rejects the whole command with `INVALID_LINES` and `result.invalid_lines` listing every bad line (1-based, first problem per line); malformed shapes are `VALIDATION_FAILED` | `stock-commands.service.ts`, `commands/stock-rejection.ts` |
| Approval minting | Outside the request transaction: short read, scrypt outside any transaction, short write. Every refusal the same `403 APPROVAL_DENIED` after one scrypt run; a locked approver's PIN is not checked; only real approvers are counted; counters read `FOR UPDATE` | `approvals.service.ts`, `StaffService.recordApprovalAttempt` |
| Approval use | One atomic `UPDATE approval ... WHERE consumed_at IS NULL AND requester ... AND device ... AND time limits RETURNING approver`, then the approver re-checked live; inside the command's savepoint, so a failed conversion leaves it unused | `ApprovalsRepository.consume`, `ApprovalsService.useForConversion` |
| Reads | Keyset paging with the shared `SignedCursor`, which also binds the filters; `unit_cost` key absent without `costs.view`; read-only joins for names (the one approved exception) | `stock-reads.service.ts`, `stock-reads.repository.ts`, `src/common/paging/signed-cursor.ts` |
| Integrity | `StockIntegrityService.check()`: balances against ledger sums, both directions, for the current business | `stock-integrity.service.ts` |

## Proof the tests catch mistakes

Each design mutation was applied temporarily, the named test was shown failing, and the change was reverted (checked byte for byte with `cmp`, or the trigger definition's md5).

| Design mutation | Test that failed | What it caught |
|---|---|---|
| 1. The valid lines of a bad delivery saved | C2 test 2 | the bad delivery was `ACCEPTED` |
| 2. Adjust reads the balance, checks it in JavaScript, then writes | C2 test 6 | 18 of 50 decreases accepted against a balance of 10 |
| 3. The count sets the balance to the counted number | C3 test 2 | the sales between the count and its arrival were lost |
| 4. No strict guard on the conversion source | C4 test 3 | a conversion of two cartons was accepted with one |
| 5. `consumed_at IS NULL` removed from the consumption | C5 test 4 | a used approval was accepted again |
| 6. Requester and device binding removed | C5 test 5 | another member's use was accepted |
| 7. `unit_cost` accepted without `costs.view` | C2 test 4 | the manager's cost lines were accepted |
| 8. The `stock_balance` change-log trigger removed | C1 test 4 and C2 test 11 | no `change_log` rows for balances |
| 9. Approval attempts written to the PIN login counters | C5 test 3 | the approval count stayed 0 |

## Versions

Unchanged from Phase B. No library was added in Phase C.

## Things to know

1. Rows written in one transaction share `created_at` (Postgres `now()` is the transaction start), so ordering them by `created_at, id` is random. Check order through `change_log.id`, or compare them as a set.
2. Access tokens expire when a test moves the fake clock; log the member in again by PIN on the same device.
3. Password-hashing timing tests fail when the machine is overloaded (seen once, in C3: the run took 1085 s). They are never weakened; such a run is repeated.
4. Product list cursors issued before C2 are refused once (the shared cursor changed the format).
5. Scratchpad scripts load project packages with `createRequire(process.cwd() + '/package.json')`; there is no Python on this machine; scripts with backticks are written with the editor, not a shell heredoc.
6. The C6 workload prints its seed in the test name; `C6_SEED=<n> pnpm exec vitest run test/c6-hardening.spec.ts -t workload` replays one.

## Open risks

1. Overload still answers 500 instead of 503 (spike open risk 4, unchanged).
2. An approval can be hoarded for up to 15 minutes of phone time; a phone with a wrong clock can stretch that, capped at 24 hours after minting (design open item 9).
3. Approvers are not told their PIN was used until Phase F (design open item 2).
4. The "another device" approval test sends the command through the dispatcher with another device id; it does not log in on a second phone.
5. No sale endpoint yet: sale-mode decreases are exercised through the spike's repository code until Phase E.
6. Later items from the design (section 17): transfers between locations, the nightly integrity schedule, valuation, reorder levels, supplier returns as documents.

## Changes to the other documents

- `CLAUDE.md`: the phase table row for C (C1); section 4's module rule notes the one approved read-only exception (C2); section 8 notes for the ledger, approvals, `errorCode`, `prisma format`, the stock commands module, the balance limits, the shared cursor, test helpers and gotchas (C1 to C5). The status line was not touched.
- `docs/architecture.md`: sections 5, 6, 12, 13 and 16 (C1), then "as built" notes in sections 5 and 6 for each step (C2 to C5).
- `docs/phase-c-walkthrough.md`: new (C6).

# Step details

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

## C5: Approvals (passed)

**Result:** new 10, Phase C cumulative 47 (C1 to C4 and `test/c5-approvals.spec.ts`), all passing in the gate run. The two race tests (20 concurrent wrong PINs held together at the PIN check; 20 concurrent commands using one approval) passed 5 runs in a row. The changed earlier files (B2's marker test, spike step 3, B1, C4) passed once on their own. The full suite passed once: 24 files, 317 of 317 (561.7 s; the machine was slower than usual, nothing failed), with lint, type-check, build and the drift check clean.

**Built (approved by Ian on 2026-10-26, with the five recommended answers):** no migration (C1 had the table, grants and counters).
- `GET /v1/stock/approvers`: active members other than the caller with an effective `stock.convert`, names and roles only.
- `POST /v1/stock/approvals` in `ApprovalsModule`: 201 `{ approval_id, valid_until }` (15 minutes, Clock); `422 APPROVAL_NOT_NEEDED` for a caller who can convert; every refusal the same `403 APPROVAL_DENIED` after exactly one scrypt run (checked by counting scrypt runs per request).
- Answer 1: the route has `@OwnTransactions()` (the second route with it; the B2 marker test lists both), so the PIN is checked outside any transaction, as in PIN login.
- Answer 2: counters as decided; the counter row is read `FOR UPDATE` first, so concurrent attempts are counted exactly (20 wrong guesses: count 20, one lock, one `approval.locked` row).
- Answer 3: only real approvers are counted; naming anyone else locks nobody.
- Answer 4: `SyncActor.deviceId` (from the token) and `CommandContext.receivedAt` (Clock).
- Answer 5: the approver's own login PIN.
- `stock.convert` approval path: a member without `stock.convert` and with an `approval_id` uses it once (the C1 statement), then the approver is re-checked live; any failure is `APPROVAL_INVALID`. The use rolls back with a failed conversion. Audit `approval.granted`, `approval.locked`, and `stock.converted` with the approver and approval id.

**Earlier tests changed by C5 (mechanical; no assertion weakened):**
- B2's marker test expects the two marked routes (approved).
- Spike step 3 and B1 test 4 pass a device id on hand-built actors.
- C4 test 5: an attendant's made-up `approval_id` is now `APPROVAL_INVALID` (was `PERMISSION_DENIED` "until C5"); without an approval it is still `PERMISSION_DENIED`.

**Proof the tests catch mistakes** (each applied, shown failing, reverted, revert checked with `cmp`):
- Mutation 5, `consumed_at IS NULL` removed from the consumption: C5 test 4 failed (a reused approval was `ACCEPTED`).
- Mutation 6, the requester and device binding removed: C5 test 5 failed (another member's use was `ACCEPTED`).
- Mutation 9, approval attempts written to the PIN login counters: C5 test 3 failed (the approval count stayed 0).

**Things to know:**
1. The "another device" case is sent through the app's own `SyncService` with a different `deviceId`, as the dispatcher would receive it from another phone's token; the "another member" case goes through the real API.
2. Three first-run failures were in my tests: the approvals module needed `DatabaseModule` for `TenantRunner`; access tokens expire when the fake clock moves (tests now log in again by PIN on the same device); staff PATCH answers 204, not 200.
3. Notifying the approver ("your PIN was used") stays for Phase F (design open item 2).

## C6: Hardening and handover (passed)

**Result:** new 8, Phase C cumulative 55 (all seven Phase C files), all passing in the gate run. The randomized workload (seeds 101, 202 and 303) passed 5 runs in a row (15 of 15 seed runs). The walkthrough passed as a test, and once over real HTTP against the built API (`node dist/main`, port 3100) on the test database: 16 of 16 checks, and none of the PIN, the reference or the note in the API's 108 log lines.

**Built (approved by Ian on 2026-10-26, with the four recommended answers):**
- `test/c6-hardening.spec.ts`:
  - Test 1, the randomized workload: two businesses (piece, carton of 24, case of 48), 200 operations in waves of 20 through the real API (receive, adjust, count, convert, and sale-mode decreases through the spike's code), about a tenth of the conversions by the attendant with a fresh approval (answer 2). Checked: no command `FAILED`, only expected outcomes; integrity clean; no strict movement below zero; nothing crossing businesses; consumed approvals equal accepted approved conversions. Seeded (mulberry32) and replayable with `C6_SEED`.
  - Test 2, logs: marker text in every free-text field, a rejected and a `FAILED` command, a wrong and a right approval PIN, the approved conversion and the reads; no marker, PIN, approval id, or `lines`, `quantity`, `note`, `reference`, `unit_cost`, `approver_pin`, `approval_id` key in any log line.
  - Test 3, audit: each action exactly once with the right actor; a crash right after the audit insert leaves no audit row and no change for every stock command and the approval mint (which answers 500), and the approval stays unused.
  - Test 4, grants: `stock_movement` and `stock_conversion` SELECT and INSERT only; on `approval` only `consumed_at` and `consumed_by_sync_command_id` are updatable.
- `docs/phase-c-walkthrough.md` and `test/c6-walkthrough.spec.ts` (test 5), with a `DAMAGED` adjust in place of the sale in step 7 (answer 1), explained in the document.
- This results file (test 6), with the open risks of answer 4.

**Things to know:**
1. The first run of the logs test failed on its own order: the crash mock caught the next `receive`, which was the rejected command. The crashing command now goes first.
2. The real-API run used a script in the session scratchpad (not in the repo): it wipes `aberdare_test` (it refuses any other database), runs the nine steps with `fetch`, and checks each answer.
