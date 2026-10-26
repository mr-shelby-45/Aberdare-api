# Phase E results

Filled in step by step. The full summary (see `docs/phase-e-design.md` section 15) is written when E6 is finished. Only Ian marks the phase done, in `CLAUDE.md` section 2.

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
