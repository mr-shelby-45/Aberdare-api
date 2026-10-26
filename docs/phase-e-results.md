# Phase E results

**Status: all six steps (E1 to E6) passed. Waiting for Ian's review.** Only Ian marks Phase E done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-e-walkthrough.md`.

**Final suite (end of phase, 3 runs in a row):** 3 runs done, all passed, on the working tree this commit records. Run 1: 38 files, 410 of 410 (450.5 s). Run 2: 38 files, 410 of 410 (721.4 s). Run 3: 38 files, 410 of 410 (719.3 s). Lint, type-check, build and the drift check were clean before the runs. Earlier failed runs during Phase E are recorded in their step sections below, as observed.

## Summary

| Step | What it built | New tests | Phase E cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| E1 | `sale`, `sale_item`, `payment`, `sale_counter`, their checks, grants, RLS and `voided_is_final`, the duplicate-code index, change-log triggers, `SALE`/`SALE_VOID` movement rules, the `SALE_VOID` approval purpose | 6 | 6 | Spike step 2's zero `SALE` row became an `ADJUST`; C1 test 3's unknown purpose example became `REFUND` (missed in the survey, caught by the first full run) |
| E2 | `sale.create`: exact cent totals, sale-mode stock in the lock order, the counter after the stock, item snapshots, `SALE` movements with `sale_id`, flags, audit | 12 | 18 | Two `StockService` methods split the stock work around the sale insert; mutation 4's first catch was only the counter check, so test 4 now spreads sales over 10 pools |
| E3 | Payments in `sale.create`, `payment.attach`, duplicate codes, overpayment | 10 | 28 | No schema change; race tests use attaches (sales queue on the counter) with a held-open transaction |
| E4 | Two read indexes, `GET /v1/sales`, `GET /v1/sales/:id`, sales in snapshot and changes with the attendant visibility rule | 7 | 35 | The changes cursor binds `all_sales` (old cursors refused once); hidden sale rows are skipped, never delete markers; Phase D tests updated mechanically |
| E5 | `sale.void`, the `SALE_VOID` approval purpose, approvers by purpose | 11 | 46 | Mutation 6a needed the `voided_is_final` policy dropped (test database only) to fail: two guards stop a double void |
| E6 | Randomized sales workload (3 seeds), logs, audit coverage, grants, walkthrough document and test; the void lock-order fix and its forced regression test | 9 | 55 | The workload found a deadlock in `sale.void` (payments reversed before the stock); fixed with Ian's approval |

New tests count `it` cases as Vitest reports them; the E6 workload is one case per seed (three). E6's nine are seven in `test/e6-hardening.spec.ts`, one in `test/e6-walkthrough.spec.ts`, and the regression test added to `test/e5-void.spec.ts`.

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Sale write order | Every check first; then the sale-mode balance statement per line in the lock order (`changeBalance(-q)`, never refuses); then the counter; then the sale and its items; then the `SALE` movements (they need the sale row); then the payments; then the audit row. One transaction (the command's savepoint) | `SalesService.create`, `StockService.saleDecreases`, `recordSaleMovements` |
| Numbering | `INSERT INTO sale_counter ... ON CONFLICT (business_id) DO UPDATE SET last_number = sale_counter.last_number + 1 RETURNING last_number`, after every stock statement; a rollback leaves no gap; never `max() + 1` | `SalesRepository.nextSaleNumber` |
| Money | Whole cents in a `BigInt` (`toCents`, `fromCents`), never a JavaScript number; NUMERIC(14,2) limits checked in code (`MAX_CENTS`) and by SQLSTATE 22003 for running sums | `src/common/money/cents.ts`, `isNumericOverflow()` |
| Flags | `FLAGGED` saves everything; reasons in the order `TOTAL_MISMATCH`, `STOCK_NEGATIVE`, `DUPLICATE_MPESA_CODE`, `OVERPAYMENT`; the first is the command's reason, all are in `result.flags` | `SalesService` (`inFlagOrder`) |
| Duplicate codes | `INSERT ... ON CONFLICT (business_id, mpesa_code) WHERE mpesa_code IS NOT NULL AND duplicate_of_payment_id IS NULL DO NOTHING RETURNING id`; no row: read the original and insert as its duplicate. Codes trimmed and upper-cased | `PaymentsRepository.insertOriginal`, `PaymentsService.record` |
| Attach | Read the sale only to choose the answer; one conditional `UPDATE sale SET paid_total = paid_total + x, balance_due = GREATEST(...) WHERE ... status = 'COMPLETED'` takes the row lock before any payment is written | `SalesService.attachPayments`, `SalesRepository.addPaid` |
| Void | Permission rule, the sale, the approval, then one conditional `UPDATE sale ... WHERE status = 'COMPLETED'` (zero rows: already voided), then `SALE_VOID` movements in the lock order, then payments `REVERSED`, then the audit row. Lock order: sale row, stock pools, payments. The restrictive `voided_is_final` policy is a second guard | `SalesService.void`, `SalesRepository.markVoided`, migration `*_e1_sales_rls` |
| Approvals by purpose | `STOCK_CONVERT` and `SALE_VOID`, each mapped to its permission (eligibility, `APPROVAL_NOT_NEEDED`, live re-check); one consume statement with the purpose in its `WHERE`; counters shared per approver | `approvals.service.ts` (`use(purpose, ...)`), `ApprovalsRepository.consume` |
| Visibility | A member without `sales.void` sees only their own sales in reads, snapshot and changes; another member's sale is the same `404 SALE_NOT_FOUND` as a missing one; sale-table rows not found in changes are skipped, never delete markers; the changes cursor binds `costs` and `all_sales` | `SalesReadsService`, `SyncTables` (`deletes: false`), `ChangesCursor` |

## Proof the tests catch mistakes

Each design mutation was applied temporarily, the named test was shown failing, and the change was reverted (checked byte for byte with `cmp`; the dropped policy by an md5 of `pg_policies`).

| Mutation | Test that failed | What it caught |
|---|---|---|
| 1. Total calculated with JavaScript floating point | E2 test 2 | 120.67999... instead of 120.68 |
| 2. Phone total trusted without the mismatch flag | E2 test 2 | no `TOTAL_MISMATCH` |
| 3. Strict stock decrease on sales | E2 test 3 (both cases) | real sales refused |
| 4. `sale_number` from `max() + 1` | E2 test 4 | duplicate numbers made sales fail (after test 4 was reworked to spread sales over 10 pools) |
| 5. A reused M-Pesa code rejects the sale | E3 test 3 (all four cases) | sales lost |
| 6a. Void without `status = 'COMPLETED'` | E5 test 2 (race), with the `voided_is_final` policy dropped in `aberdare_test` | more than one void accepted; with the policy in place the test passed (the policy alone holds) |
| 6b. Void without restoring stock | E5 test 1 | balances not restored |
| 7. An attendant voids without an approval | E5 test 3 (both cases) | the void accepted |
| 8. The approval purpose not checked | E5 test 4 | a `STOCK_CONVERT` approval voided a sale |
| 9. An attendant sees other members' sales | E4 test 1 (reads), E4 test 5 (changes) | other members' sales listed and synced |
| 10. `cost_price` on items without `costs.view` | E4 test 2 (reads), E4 test 5 (changes) | the key present |
| 11. A payment total that does not update `balance_due` | E3 test 1 | also refused by the E1 check `sale_balance_due` |
| Extra (E3): duplicate detection by "read, then insert" | E3 attach race tests | unique violations made attaches fail |
| Extra (E3): `paid_total` read, added in JavaScript, written back | E3 one-sale attach race | lost updates |
| Extra (E4): hidden sale rows sent as delete markers | E4 test 5 | delete markers reached the attendant |
| Extra (E4): the cursor does not compare `all_sales` | E4 test 6 | no 410 after `sales.void` changed |
| Extra (E5): payments left `RECORDED` on a void | E5 test 1 | payments not reversed |
| Extra (E6): the void's old order (payments before the stock) | E5 forced-deadlock test | the void `FAILED` with `40P01` |

## Versions

Unchanged. No library was added in Phase E (`package.json` and `pnpm-lock.yaml` are as at the end of Phase D).

## Things to know

1. A sale-mode statement holds its balance row lock until commit, and every `sale.create` of a business queues on `sale_counter`. A race test of anything after those locks must use different pools or `payment.attach`, and should force the overlap with a held-open transaction and a wait for lock waiters (`lockWaiters()` in the E3 and E5 tests).
2. Two layers stop a double void (the conditional `UPDATE` and the `voided_is_final` policy). A mutation test of one needs the other removed, only ever in `aberdare_test`, with an md5 check of `pg_policies` after re-creating it.
3. `paid_total` keeps its value on a void (E5 answer 3); E6 checks that it equals the sum of all the sale's payments, with only `RECORDED` payments on a completed sale and only `REVERSED` ones on a voided sale. The design's wording ("the sum of its non-reversed payments") was changed to this with Ian's approval (E6 answer 2).
4. Changes collapse repeats of a record only within one page, and while any transaction is held open nothing committed after it is handed out (Phase D rules); E4's first drafts assumed otherwise.
5. The E6 workload prints its seed in the test name; `E6_SEED=<n> pnpm exec vitest run test/e6-hardening.spec.ts -t randomized` replays one. A `FAILED` command puts its log line (with the SQLSTATE) in the failure message. A deadlock depends on timing, so a replay can pass: repeat the run instead.
6. Phones never send payment ids; payments get server ids and reach phones through sync.

## Open risks

1. The M-Pesa code format (8 to 12 letters and digits) is a placeholder, marked `TODO(verify)` in `payments.service.ts` (design open item 2).
2. Payments are not verified with Safaricom until Phase M (Daraja callbacks, `mpesa_transaction`, reconciliation; design open item 1).
3. Every `sale.create` of a business waits for the previous one at `sale_counter` (architecture open item 56): measure with a busy wholesaler on several phones.
4. The sales snapshot pages by id filtered by date, and payment pages pass the window's visible sale ids (architecture open item 59): measure in Phase H.
5. Balance due exists, but there is no customer behind it (no credit sales; design open item 3).
6. A SALE_VOID approval can be held for up to 15 minutes of phone time, stretched by a wrong phone clock to at most 24 hours after minting (as for conversions).
7. Approvers and owners are not told a PIN approved a void until Phase F (design open item 9).
8. The "another device" approval checks send the command through the dispatcher with a made-up device id; they do not log in on a second phone (as in C5).
9. Overload still answers 500 instead of 503 (spike open risk 4, unchanged).

## Changes to the other documents

- `CLAUDE.md`: the phase table rows for E and the new Phase M (E1, commit `ed3d311`); section 8 notes for the sales schema, `sale.create`, payments, sales reads and sync, approval purposes and the void (E1 to E5), and the E6 workload replay and the void lock order (E6). The status line was not touched.
- `docs/architecture.md`: sections 5, 8, 12, 13, 14 and 16 (E1), "as built" notes for `sale.create`, `payment.attach`, `sale.void` and the sales sync tables (E2 to E6), open item 59 (E4).
- `docs/phase-d-walkthrough.md`: step 2's last page now continues to the sale tables (E4).
- `docs/phase-e-walkthrough.md`: new (E6).

# Step details

## E1: Schema, checks, grants, triggers, doc updates (passed)

**Result:** new 6, Phase E cumulative 6 (`test/e1-sales-schema.spec.ts`), all passing in the gate run. E1 test 1's exact inventories are in `test/step4-migrations.spec.ts` and `test/b5-hardening.spec.ts`; E1 test 7 is the earlier suites (the changed step 2, step 4 and B5 files passed with the E1 file: 40 of 40). The first full-suite run failed one test (360 of 361): C1 test 3 used `'SALE_VOID'` as its example of an unknown approval purpose, which E1 made a known one (see below). After the mechanical fix the full suite passed: 32 files, 361 of 361 (1010.5 s; the machine was slow, nothing failed). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the seven recommended answers):**
- Doc updates of design section 16 (commit `ed3d311`): the CLAUDE.md phase rows for E and the new Phase M; `architecture.md` sections 5, 8, 12, 13, 14 and 16, edited in place.
- Seven migrations, replayed and probed in the shadow database before approval:
  - `*_e1_sales_tables` (generated): `sale`, `sale_item`, `payment`, `sale_counter`, `stock_movement.sale_id`, their unique keys and composite foreign keys.
  - `*_e1_sales_checks`: the sale, item, payment and counter checks of design section 3 (with `balance_due = GREATEST(total - paid_total, 0)` exactly, answer 4, and `verified = false` until Phase M, answer 5); the C1 stock checks widened: `SALE_VOID` known, `SALE` negative and `SALE_VOID` positive (answer 1), `sale_id` required on `SALE_VOID`, optional on `SALE`, forbidden elsewhere (answer 3); `approval.purpose` accepts `SALE_VOID`.
  - `*_e1_sales_rls`: grants (no DELETE; `sale` updatable only in `status`, `paid_total`, `balance_due` and the void columns; `sale_item` append-only; `payment` only `status`; `sale_counter` only `last_number`), forced RLS with `shop_only`, and the restrictive `voided_is_final` policy (the spike's `outcome_is_final` pattern, answer 2): once `VOIDED`, no UPDATE matches the sale.
  - `*_e1_payment_mpesa_code_unique`: one original payment per code per business (duplicates outside the index; reversed payments keep their code).
  - `*_e1_sale_change_trigger`, `*_e1_sale_item_change_trigger`, `*_e1_payment_change_trigger`: the generic `log_product_change()`, insert and update.
- No `updated_at` on `sale` (answer 6); the read indexes come in E4 with the queries (answer 7).

**The SALE sign rule (Ian's question):** before E1, `SALE` had no sign rule (only non-zero and a known type). Adding "must be negative" broke no test: the spike's sale mode always writes a negative change, and C1 test 2's `SALE -4` stays valid. Spike step 2's deliberately zero `SALE` row would still have failed on `stock_movement_quantity_change_nonzero`, because Postgres checks constraints in alphabetical order by name; to stop depending on that order, the row is now an `ADJUST` with reason `CORRECTION` (no sign rule), with the same assertion (answer 1).

**Earlier tests changed by E1 (mechanical; no assertion weakened):**
- Step 4: the RLS coverage list gains `payment`, `sale`, `sale_counter`, `sale_item`; the trigger list gains the three triggers; `HAND_WRITTEN_INDEXES` gains `payment_mpesa_code_unique`, with a check of its definition.
- B5: the grants inventory lists the four tables and their exact column grants.
- Spike step 2: the zero row, as above.
- C1 test 3: its example of an unknown approval purpose was `SALE_VOID`, which E1 makes a known purpose (approved, design section 3); the example is now `REFUND`, with the same assertion (`approval_purpose_known`). My survey before approval looked only for `SALE` movement rows, not for approval purposes, so this showed up only in the first full run.

**Things to know:**
1. This database sorts names in byte order (`void_note` before `voided_at`). The first run of the B5 inventory failed only because I had written the column lists in a different order; the contents were identical, and only the order was corrected.
2. Prisma generated the optional composite foreign keys with `ON DELETE RESTRICT`; nothing is ever deleted from these tables, so it does not matter, but it is not `SET NULL`.
3. The `voided_is_final` policy makes a second void, an un-void or a payment change on a voided sale match zero rows, without an error. E5's void reports `SALE_ALREADY_VOIDED` by checking whether the sale exists after zero rows, as the design says.

## E2: sale.create (passed)

**Result:** new 12, Phase E cumulative 18 (`test/e2-sale-create.spec.ts` plus the E1 file), all passing in the gate run. The concurrency tests (test 3's 50 sales against a balance of 10, test 4's 30 sales and 20 copies of one command, test 6's two commands with one sale id, test 9's sales with a count and conversions) passed 5 runs in a row; test 4 passed 5 more runs after it was reworked (see below). The full suite passed: 33 files, 373 of 373 (435.6 s). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the seven recommended answers):**
- `SalesModule` (`src/modules/sales/`): `CreateSaleDto`, `SalesError`, `SalesRepository` (exists, the atomic `sale_counter` upsert, sale and item inserts), `SalesService.create()`, and `CreateSaleHandler` (`sale.create`, permission `sales.create`), added to `CommandHandlers`.
- Write order (answer 1): every check, then the sale-mode balance statements in the lock order, then the counter, then the sale and items, then the `SALE` movements (they need the sale row for `sale_id`), then the audit row; one transaction. Two new `StockService` methods split the stock work around the sale insert: `saleDecreases()` and `recordSaleMovements()`.
- Money in whole cents as `BigInt` (`src/common/money/cents.ts`, answer 2); a line or total above `NUMERIC(14,2)` is `VALIDATION_FAILED`.
- `payments` must be absent or `[]` until E3 (answer 3).
- `SALE_ALREADY_EXISTS` from an early check plus the `sale_pkey` unique violation for two commands at the same moment (answer 4).
- `inLockOrder()` moved to `src/modules/stock/lock-order.ts`, shared by stock commands and sales (answer 5).
- `STOCK_NEGATIVE` when any line ends below zero (answer 6); flags in the order `TOTAL_MISMATCH`, `STOCK_NEGATIVE`, and the first one is the command's reason.
- A malformed phone total is a command-level `VALIDATION_FAILED` (answer 7).
- `ProductsService.packTypesForSale()` reads names and prices for the snapshots (archived ones too).

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
1. Floating-point total (`Number` sum): test 2 failed.
2. Phone total trusted, no mismatch flag: test 2 failed.
3. Strict stock decrease for sales: both test 3 cases failed.
4. `sale_number` from `max() + 1`: test 4 failed, but at first only on the counter check. All 30 sales sold the same pack type, so the stock row lock queued them one at a time and `max() + 1` never raced. The test now spreads the 30 sales over 10 stock pools; with the mutation it then failed on its first assertion (duplicate numbers made sales fail), and it passes without it.

**Things to know:**
1. Test 6 and test 2 at first assumed a sale without stock is `ACCEPTED`; it is `FLAGGED / STOCK_NEGATIVE` (correct behaviour). Test 2 now receives stock first; test 6 expects `FLAGGED`.
2. Sales of one pool are serialised by its balance row lock, held until commit. A concurrency test of anything taken after the stock statements (the counter) must use different pools, or it does not test the race.
3. Test 8's "no `sales.create`" case calls `SyncService.processCommands()` with a hand-built actor, because every role preset has `sales.create`.

## E3: Payments (passed)

**Result:** new 10, Phase E cumulative 28 (`test/e3-payments.spec.ts` plus the E1 and E2 files), all passing in the gate run. The four race tests (20 concurrent sales with one code, attaches waiting for an uncommitted original, 20 concurrent attaches with one new code, concurrent attaches to one sale) passed 5 runs in a row. The full suite passed: 34 files, 383 of 383 (579.3 s). Lint, type-check, build and the drift check were clean. No schema change and no migration.

**Built (approved by Ian on 2026-10-26, with the eight recommended answers):**
- `PaymentsModule` (`src/modules/payments/`, answer 1): a data module for the `payment` table only. `PaymentsService.validate()` lists every bad payment (`METHOD_INVALID`, `AMOUNT_INVALID`, `MPESA_CODE_MISSING`, `MPESA_CODE_NOT_ALLOWED`, `MPESA_CODE_INVALID`); `record()` saves them and counts duplicates.
- Payments inside `sale.create`: 0 to 10, `payments.confirm` through `extraPermissions()`, lines checked before payments (`INVALID_LINES` wins), `paid_total` and `balance_due` written with the sale.
- `payment.attach` (`AttachPaymentHandler`, `SalesService.attachPayments()`): the sale is read only to choose the answer (`SALE_NOT_FOUND` for unknown, another business's, and for members without `sales.void` another member's sale, answer 4; `SALE_VOIDED`), then one conditional `UPDATE sale SET paid_total = paid_total + x, balance_due = GREATEST(...) WHERE ... status = 'COMPLETED'` takes the row lock before any payment is written.
- Duplicate codes (answer 2): `INSERT ... ON CONFLICT` on `payment_mpesa_code_unique` `DO NOTHING`, then the original is read and the payment saved as its duplicate. Duplicates count toward `paid_total` (answer 3).
- `OVERPAYMENT` whenever `paid_total` ends above the total (answer 5). Codes are trimmed and upper-cased, then 8 to 12 letters and digits, still `TODO(verify)` (answer 6). A `paid_total` beyond `NUMERIC(14,2)` (SQLSTATE 22003, `isNumericOverflow()`) is `VALIDATION_FAILED` (answer 7).
- Audit: `sale.created` gains `payment_count` and `paid_total`; `payment.attached` has `sale_id`, `payment_count`, `amount_total`, `flags`. No codes, no single amounts.

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 5, a reused code rejects the sale: all four test 3 cases failed.
- Design 11, `balance_due` not updated for payments: test 1 failed. The E1 check `sale_balance_due` also refuses such a row, so the sale fails outright instead of being saved wrong.
- Extra a, duplicate detection by "read, then insert" without `ON CONFLICT`: both attach race tests failed (unique violations made attaches fail).
- Extra b, `paid_total` read, added in JavaScript and written back: the one-sale attach race test failed (lost updates).

**Earlier tests changed by E3 (mechanical; no assertion weakened):**
- E2 test 5: its example of a refused payments list was one cash payment ("payments come in E3"). It is now 11 payments (over the limit of 10), still `VALIDATION_FAILED`.
- E2 test 10: the exact `sale.created` metadata gains `payment_count: 0` and `paid_total: '0.00'` (design section 9).

**Things to know:**
1. Sales of one business queue on the `sale_counter` row, so concurrent `sale.create` commands with one code never really race on the code index. The real races are attaches (no counter); E3's race tests use them, with a held-open transaction and a wait for lock waiters to force the overlap (`lockWaiters()` in `test/e3-payments.spec.ts`).
2. Test 5 (no `payments.confirm`) calls `SyncService.processCommands()` with a hand-built actor: every preset has `payments.confirm` and extras only add.
3. My first draft of test 2 sent 12 payments in one command, over the limit; it now uses two commands.

## E4: Reads and sync (passed)

**Result:** new 7, Phase E cumulative 35 (`test/e4-sales-reads-sync.spec.ts` plus the E1 to E3 files), all passing in the gate run. The held-open-transaction test (out-of-order commits) passed 5 runs in a row. The Phase D files, changed mechanically (below), passed together: 5 files, 30 of 30. The full suite passed: 35 files, 390 of 390 (589.3 s). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the eight recommended answers):**
- Migration `*_e4_sale_read_indexes` (generated, exactly the SQL shown before approval; answer 1): `sale (business_id, occurred_at DESC, id DESC)` and `sale (business_id, created_by_membership_id, occurred_at DESC, id DESC)`. Applied to dev and test.
- Reads (`SalesController`, `SalesReadsService`, `SalesReadsRepository`, `sales-view.ts`): `GET /v1/sales` (newest first by `(occurred_at, id)`, filters, signed cursor bound to the filters including the effective `created_by`) and `GET /v1/sales/:id` (items, payments, void details; `cost_price` key absent without `costs.view`). Any active member; a member without `sales.void` sees only their own sales, and anything else is the same `404 SALE_NOT_FOUND` as a missing id or a non-UUID (answer 6). Names come from the new `StaffService.displayNames()` (answer 5).
- Sync: `SyncTables` gains `sale`, `sale_item`, `payment` after `stock_balance`, with one row shape shared with the detail read (answer 7; a payment shows `duplicate: true/false`). `SyncView` carries `allSales` and `membershipId`.
- Snapshot: sales with `occurred_at` within `SALES_SNAPSHOT_DAYS` (30) of the Clock; items and payments of sales within 31 days (answer 4: a snapshot spans many requests while the Clock moves; the phone ignores children of a sale it does not hold).
- Changes: no age filter. Sale tables have `deletes: false`: a row not found is one the reader may not see (sales are never deleted), skipped without a marker, and the cursor still moves past it (answer 3).
- The changes cursor binds `all_sales` next to `costs` (answer 2): gaining or losing `sales.void` gives `410 SNAPSHOT_REQUIRED`. A cursor issued before E4 has no `all_sales` and is refused once with `422`, like a tampered one.

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 9 in reads (an attendant's list ignores the visibility rule): test 1 failed. In changes (sale rows read without the owner filter): test 5 failed.
- Design 10 in reads (`cost_price` always shown in the detail): test 2 failed. In changes (items shaped with costs): test 5 failed (an assertion added to test 5 for this before the mutation ran).
- Extra c, hidden sale rows sent as delete markers: test 5 failed.
- Extra d, the cursor does not compare `all_sales`: test 6 failed.

**Earlier tests changed by E4 (mechanical; no assertion weakened):**
- D1 and D2: `ChangeFeedService.startCursor/open/sign` take a `{ costs, allSales }` view instead of `costs: boolean`; the calls pass `allSales: false` with the same `costs` value as before. D2's hand-built `SyncReader` gains `membershipId`.
- D2 test 1: the snapshot's last table is now `payment`, not `stock_balance`; its expected counts include the three sale tables (zero rows there). D2's "without stock.view" page now has `nextTable: 'sale'`.
- D4 walkthrough test and `docs/phase-d-walkthrough.md` step 2: the `stock_balance` page now has `next_table: 'sale'`.

**Things to know:**
1. Changes collapse repeats of a record only within one page (Phase D3). My first draft of test 5 drained with pages of 3 and expected each sale once; it now checks "once" with one page and checks separately that pages of 3 end in the same state.
2. While any transaction is held open, `changes` hands out nothing committed after it (the finished-transactions rule of D1), not only the held change. My first draft expected a later sale to arrive while the transaction was open.
3. Payments know only payments, so the snapshot's payment pages get the window's visible sale ids from the sales module and query `sale_id = ANY(ids)` (no cross-module join). With item pages (by id, filtered by date) this is fine for 30 days of a normal shop; measure for a busy wholesaler in Phase H (`docs/architecture.md` open item 59).

## E5: Void and approvals (passed)

**Result:** new 11, Phase E cumulative 46 (`test/e5-void.spec.ts` plus the E1 to E4 files), all passing in the gate run, run together with `test/c5-approvals.spec.ts` because the approval code changed (6 files, 56 of 56). The concurrency tests (20 concurrent voids of one sale, 20 voids sharing one approval, an attach racing a void 10 times) passed 5 runs in a row. The full suite passed: 36 files, 401 of 401 (619.1 s). Lint, type-check, build and the drift check were clean. No schema change and no migration.

**Built (approved by Ian on 2026-10-26, with the eight recommended answers):**
- `sale.void` (`VoidSaleHandler`, `SalesService.void()`): dispatcher permission `sales.create`, the real check inside (answer 4): with `sales.void` the member voids and any `approval_id` is ignored and not used; without it an approval is needed (`PERMISSION_DENIED` without one). Order (answer 5): permission rule, the sale (`SALE_NOT_FOUND` for unknown, another business's, and for members without `sales.void` another member's sale even with an approval, answer 1; `SALE_ALREADY_VOIDED`), the approval (`APPROVAL_INVALID`), one conditional `UPDATE sale ... WHERE status = 'COMPLETED'`, payments `REVERSED` (`PaymentsService.reverseForSale()`; moved after the stock in E6, see there), one `SALE_VOID` movement per item at the sale's location in the lock order (`StockService.returnForVoid()`, never refuses; the `MAX_BALANCE` cap is `VALIDATION_FAILED`, answer 8), then the audit row `sale.voided`.
- `voided_at` and the movements' `occurred_at` are the command's `occurred_at` (answer 2). `paid_total` and `balance_due` stay as they were (answer 3).
- Approvals: `SALE_VOID` purpose (`APPROVAL_PURPOSES`), `GET /v1/stock/approvers?purpose=` (default `STOCK_CONVERT`, unknown `422`, answer 7), `APPROVAL_NOT_NEEDED` and eligibility by the purpose's permission, and `ApprovalsService.use(purpose, ...)` replacing `useForConversion()` (stock convert passes `STOCK_CONVERT`). The lock counters stay per approver, shared by both purposes. The `APPROVAL_NOT_NEEDED` message is now purpose-neutral ("You can do this yourself; no approval is needed.").
- `MOVEMENT_TYPES` gains `SALE_VOID`, so `GET /v1/stock/movements?type=SALE_VOID` works.

**Mutations (each reverted and checked with `cmp`; no `MUTATION` marker left):**
- Design 6a, void without `status = 'COMPLETED'` (answer 6): with the E1 policy `voided_is_final` in place, test 2 still passed: the policy alone makes a second void match zero rows. With the policy also dropped in `aberdare_test` only, the race test failed (more than one void accepted). The policy was then re-created with the E1 SQL; an md5 of the sale table's policies from `pg_policies` was `0f9a6143ae0ec2c3f7c0640ac622d967` before and after. The sequential case of test 2 passed even then, because the early status read answers `SALE_ALREADY_VOIDED`; only the forced race reaches the statement.
- Design 6b, no stock returned: test 1 failed.
- Design 7, an attendant voids without an approval (`canVoid` always true): both test 3 cases failed.
- Design 8, the approval purpose not checked at use: test 4 failed.
- Extra, payments left `RECORDED`: test 1 failed.

**Things to know:**
1. Two layers stop a double void: the conditional `UPDATE` and the restrictive `voided_is_final` policy. A test of one alone needs the other removed; dropping a policy is only ever done in `aberdare_test`, with an md5 check of `pg_policies` after re-creating it.
2. My first draft of test 1 expected `balance_due` 4300.00; every line of the test helper is priced 100.00, so the sale is 600.00 with 300.00 due. The expectation was wrong, not the code.
3. The race tests hold the row (`sale` or `approval`) `FOR UPDATE` in an open admin transaction and wait for lock waiters, like E3.

## E6: Hardening and handover (passed)

**Result:** new 9, Phase E cumulative 55 (all seven Phase E files), all passing in the gate run. The randomized workload (seeds 404, 505 and 606) passed 5 runs in a row after the fix below (15 of 15 seed runs); before it, it failed 2 of 6 runs. The forced deadlock test passed 5 runs in a row. The walkthrough passed as a test, and once over real HTTP against the built API (`node dist/main`, port 3100) on the test database: 26 of 26 checks, and none of the M-Pesa code, the PIN, a total or a body key in the API's 121 log lines. Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the six recommended answers):**
- `test/e6-hardening.spec.ts`:
  - Test 1, the randomized workload (answer 1): two businesses (piece, carton of 24, case of 48), 200 operations in waves of 20 through the real API: sales (cash, M-Pesa, split, none; about a fifth of codes reused), attaches, manager voids, attendant voids with a fresh approval, receive, count, convert, and reads and snapshots. Checked: no command `FAILED` and only expected outcomes; integrity clean; `sale_number` exactly 1..N; totals equal items; `paid_total` equals all the sale's payments, with only `RECORDED` on completed and only `REVERSED` on voided sales (answer 2); every void returned exactly what was sold; one original per code; consumed `SALE_VOID` approvals equal accepted approved voids; nothing crossed businesses; the attendant's and the manager's snapshots hold exactly the right sales (answer 3). Seeded (mulberry32), replayable with `E6_SEED`.
  - Test 2, logs: marker text in the product name, `local_ref`, note, void note, M-Pesa code, price and amount; a rejected and a `FAILED` command, a wrong and a right approval PIN, the approved void, the sales reads, snapshot and changes. No marker, code, PIN or approval id in any log line, and none of the keys `lines`, `payments`, `mpesa_code`, `unit_price`, `amount`, `note`, `local_ref`, `approval_id`, `approver_pin`.
  - Test 3, audit: `sale.created` (with payments, no separate `payment.attached`), `payment.attached`, `approval.granted`, `sale.voided` (twice: approved and direct) and `approval.locked`, each exactly once with the right actor; refused commands write nothing. A crash right after the audit insert of `sale.create`, `payment.attach` and an approved `sale.void` leaves no change anywhere, and the approval stays usable.
  - Test 4, grants in practice (answer 5): as `app_user`, no DELETE on any sales table; no change to a total, a note, an item or an amount; a payment's status can change; an update of a voided sale matches zero rows.
- `docs/phase-e-walkthrough.md` and `test/e6-walkthrough.spec.ts` (test 5): the ten steps of design section 14 with the attendant's void approved by the manager's PIN (answer 4). My first draft had eight steps and missed three of the design's points (a wrong phone total, an oversell, a second business); it was rewritten to the ten before the real-API run.
- This results file (test 6), with the open risks of answer 6.

**The deadlock (found by test 1, fixed with Ian's approval):**
- Seen: `sale.void` ended `FAILED` with SQLSTATE `40P01` in 2 of 6 runs; a replay of the seed passed (timing). The Postgres log showed the void waiting at `INSERT INTO stock_balance ... ON CONFLICT` and a `sale.create` waiting at `INSERT INTO payment ... ON CONFLICT (business_id, mpesa_code) ...`.
- Cause: the void reversed the sale's payments (updating the original payment that holds a code) before returning its stock. A sale reusing that code, already holding the same stock pool, waits for the void at the code index (Postgres waits for the transaction that changed the conflicting row); the void then waits for the sale's pool.
- Fix: in `SalesService.void()` the stock is returned before the payments are reversed. Lock order: the sale row, the stock pools, the payments. Same rows, same transaction.
- Proof: E5's new forced test holds `sale_counter` so the sale takes its pool and stops, starts the void, then releases the counter. With the fix both succeed (5 runs); with the old order put back the void `FAILED` (reverted, `cmp`).

**Things to know:**
1. The audit test's last line first compared against `api.auditRows()`, which lists only stock actions; it was removed (the exact list of seven actions above it is the check).
2. The real-API run used a script in the session scratchpad (not in the repo): it wipes `aberdare_test` (it refuses any other database), runs the ten steps with `fetch`, and checks each answer.
