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
