# Phase E design: Sales and payments

Status: approved by Ian on 2026-10-26 (all seven questions answered with the recommended defaults). This file is the source of truth for Phase E. Where it disagrees with `docs/architecture.md` or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 16). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md` and the results files of Phases A to D (the "Final patterns" and "Things to know" of each). The patterns proven there are the way to do things. Do not invent new ones.

Do not start until Ian has marked Phase D done in `CLAUDE.md` section 2.

This phase handles shopkeepers' money. A wrong total, a lost sale or a double void is a real loss. Take the tests as seriously as the code.

## 1. Goal and scope

A phone can record a sale made offline (`sale.create`), with its payments, and the server stores it, decreases stock, numbers it, and never refuses a sale that really happened. A manager can void a sale, and an attendant can void with a manager's PIN approval. Sales and payments can be read online and flow to phones through snapshot and changes.

In scope:
- Commands: `sale.create`, `payment.attach`, `sale.void`.
- Tables: `sale`, `sale_item`, `payment`, `sale_counter`.
- Reads: `GET /v1/sales`, `GET /v1/sales/:id`.
- Sync: sales, sale items and payments join `SyncTables` (snapshot of the last 30 days; changes with the sale visibility rule).
- Approvals: a second purpose, `SALE_VOID`, on the existing approval mechanism.
- Stock: `SALE` and `SALE_VOID` movements written through `StockService` (sale mode: never refuses, flags a negative balance).

Out of scope (do not build): Daraja callbacks, the `mpesa_transaction` table, STK push, verifying M-Pesa payments (all in a later phase, "Phase M", see section 16); customer accounts, credit sales and debt tracking; partial returns and refunds; discounts as a system (price below list price is just recorded); tax and eTIMS; receipts printing (phone side); reports and profit (Phase G); notifications (Phase F); order inbox; loyalty; sale editing (a wrong sale is voided and re-entered).

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Scope | Sales, cash, manual M-Pesa codes, voids, sync. Daraja callbacks are a separate later phase. |
| Prices | Each line stores the price charged, the list price and the cost price at that moment. The server never refuses a sale over a price. Below-list prices are recorded, not flagged. |
| Totals | The server calculates the total from the lines with exact decimals. A different phone total is saved as the server total and the command is `FLAGGED / TOTAL_MISMATCH`. |
| Payments | `CASH` or `MPESA` (manual code, unverified). Split payments allowed. Less than the total is saved as unpaid with a balance due. No customer credit yet. |
| Reused M-Pesa code | The sale is saved, the payment is marked as a duplicate, the command is `FLAGGED`. |
| Void | Whole sale only. Stock returns through new movements. `sales.void`, or a valid `SALE_VOID` approval. |
| Numbering | The phone shows a local reference. The server assigns `sale_number` per business from a counter row. |
| Visibility | Attendants see only their own sales. Managers and owners see all. Snapshot holds 30 days. |

## 3. Data model

Same rules as before: tenant tables have `id`, `business_id`, `created_at`, forced RLS with the `shop_only` NULLIF policy, composite foreign keys, unique `(business_id, id)`, explicit grants. Claude Code proposes the exact Prisma schema and SQL for each step and waits for approval before applying. Check what exists first. Every new table, trigger, function and hand-written index goes into the exact inventories in `test/step4-migrations.spec.ts` and the grants inventory in `test/b5-hardening.spec.ts`. Money is `NUMERIC(14,2)` and travels as a string. Never a JavaScript number in a calculation.

**sale** (`id` is the phone's UUID)
- `sale_number integer not null` (unique per business), `local_ref text not null` (at most 30 characters, from the phone, not unique), `location_id`, `device_id`, `created_by_membership_id` (composite foreign keys).
- `occurred_at timestamptz not null` (phone), `received_at timestamptz not null` (server Clock).
- `status text not null` check in `COMPLETED`, `VOIDED`.
- `total numeric(14,2) not null` (check `>= 0`), `paid_total numeric(14,2) not null default 0`, `balance_due numeric(14,2) not null` (check `>= 0`; the greater of total minus paid and zero).
- `total_mismatch boolean not null default false`, `note text null` (at most 200).
- Void fields, all null until voided and all set together (check): `voided_at`, `voided_by_membership_id`, `void_reason` (check in `MISTAKE`, `CUSTOMER_CANCELLED`, `WRONG_PRICE`, `OTHER`), `void_note` (at most 200), `void_approval_id` (unique, composite foreign key to `approval`, null when the voider had `sales.void` themselves), `void_approved_by_membership_id` (the voider themselves when they held `sales.void`).
- `app_user`: SELECT, INSERT, and UPDATE of `status`, `paid_total`, `balance_due` and the void columns only. No DELETE. A trigger or check must make a `VOIDED` sale permanent (no update after `VOIDED` except nothing at all; show Ian the choice).

**sale_item**
- `sale_id`, `pack_type_id` (composite foreign keys), `line_no integer` (1-based, unique per sale), `product_name text`, `pack_type_name text` (names as they were at sale time, so receipts survive renames), `quantity integer` (1 to 100,000), `unit_price numeric(14,2)` (`>= 0`), `list_price numeric(14,2)`, `cost_price numeric(14,2) null` (null when the pack type has none), `line_total numeric(14,2)`.
- Append-only: `app_user` has SELECT and INSERT only.

**payment**
- `sale_id`, `method text` check in `CASH`, `MPESA`, `amount numeric(14,2)` (`> 0`), `mpesa_code text null` (present exactly when `method = 'MPESA'`), `verified boolean not null default false` (always false in Phase E), `duplicate_of_payment_id uuid null` (composite foreign key to `payment`), `status text` check in `RECORDED`, `REVERSED`, `occurred_at`, `created_by_membership_id`.
- Partial unique index `(business_id, mpesa_code) WHERE mpesa_code IS NOT NULL AND duplicate_of_payment_id IS NULL`. Reversed payments keep their code (a voided sale does not free it).
- `app_user`: SELECT, INSERT, and UPDATE of `status` only.

**sale_counter**: `business_id` primary key, `last_number integer not null`. `app_user`: SELECT, INSERT, UPDATE of `last_number`.

**stock_movement**: add `sale_id uuid null` (composite foreign key to `sale`) and widen the movement type check with `SALE_VOID` (positive sign check). Check what sign rule `SALE` has today; the spike's tests insert `SALE` rows. Add a negative-sign check for `SALE` only if the spike tests can adapt mechanically; otherwise leave `SALE` unchecked and tell Ian.

**approval**: widen the `purpose` check with `SALE_VOID`.

**change_log triggers** (hand-written SQL, one migration per object, reuse the generic function): `sale`, `sale_item`, `payment` for insert and update.

## 4. Rules

- **Never refuse a real sale.** A sale is rejected only for invalid or unauthorised input. Out-of-stock, price differences, a wrong total, an unknown or reused M-Pesa code and an archived product or location are all accepted (and flagged where the table below says so).
- **Atomic stock, sale mode.** Each line uses the existing sale-mode statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING quantity`), one `SALE` movement per line with `quantity_after`, the `sale_id`, and the same creator and command fields as Phase C. `SalesService` calls `StockService`; it never reads stock tables itself. Lines are applied in the shared lock order (`inLockOrder()`), larger pack first. Two lines for the same pack type are allowed and both applied.
- **Counter last.** Assign `sale_number` after all stock statements, with `INSERT INTO sale_counter ... ON CONFLICT (business_id) DO UPDATE SET last_number = sale_counter.last_number + 1 RETURNING last_number`. This holds the counter lock for the shortest time, and stock locks are always taken before it, so there is no lock cycle. A rolled-back command leaves no gap. Never `max(sale_number) + 1`.
- **Money.** `line_total = unit_price * quantity`, `total = sum(line_total)`, both rounded to 2 places by the database or a decimal type. Compare the phone's total to the server total as decimals. A line total or sale total above the `NUMERIC(14,2)` range is `VALIDATION_FAILED`.
- **Flags.** `FLAGGED` saves everything. The command reason is the first that applies in this order: `TOTAL_MISMATCH`, `STOCK_NEGATIVE`, `DUPLICATE_MPESA_CODE`, `OVERPAYMENT`. `result.flags` lists all that apply.
- **Archived** locations, products and pack types are allowed on sales (the sale already happened). A location or pack type of another business is the same as one that does not exist.
- **Unpaid sales.** Payments below the total are allowed. `balance_due = total - paid_total`. Payments above the total are saved and flagged `OVERPAYMENT` (the phone sends the amount applied, not the cash tendered; change is not tracked).
- **Immutability.** Items are never changed. Payments are never edited; they are reversed only by a void. A voided sale cannot be changed again.

## 5. Commands

All through `POST /v1/sync/commands` with the existing dispatcher, idempotency, savepoint-per-command, `FAILED` logging and `occurred_at` rules. Payloads are snake_case; money is a string; ids come from the phone; `business_id` in a payload is rejected. The command id and the sale id are separate; the sale id is the primary key, so the same sale id in a second command with a new command id is `REJECTED / SALE_ALREADY_EXISTS`.

Bad lines are reported with the Phase C pattern: reason `INVALID_LINES`, `result: { invalid_lines: [{ line, reason }] }` listing every bad line, nothing saved.

**sale.create**: `{ sale_id, local_ref, location_id, note?, total?, lines: [{ pack_type_id, quantity, unit_price }], payments?: [{ method, amount, mpesa_code? }] }`.
- 1 to 100 lines. 0 to 10 payments. `total` is the phone's total, optional; if present it is only compared.
- Permission `sales.create`. If `payments` is present and non-empty, also `payments.confirm` (otherwise the whole command is `PERMISSION_DENIED`).
- The list price and cost price come from the pack type as it is on the server now; the names likewise.
- Line reasons: `PACK_TYPE_NOT_FOUND`, `QUANTITY_INVALID`, `PRICE_INVALID`. Command reasons: `LOCATION_NOT_FOUND`, `SALE_ALREADY_EXISTS`, `VALIDATION_FAILED`, `INVALID_LINES`, `INVALID_PAYMENTS` (with `result.invalid_payments: [{ payment, reason }]`: `AMOUNT_INVALID`, `METHOD_INVALID`, `MPESA_CODE_MISSING`, `MPESA_CODE_INVALID`, `MPESA_CODE_NOT_ALLOWED`).
- M-Pesa code format: normalise to uppercase and check letters and digits only, 8 to 12 characters. `TODO(verify)`: confirm the real M-Pesa code format with Ian or Safaricom before tightening this. Do not invent a stricter rule.
- Accepted or flagged result: `{ sale_id, sale_number, total, paid_total, balance_due, flags: [...] }`.

**payment.attach**: `{ sale_id, payments: [{ method, amount, mpesa_code? }] }`, 1 to 10 payments. Permission `payments.confirm`. The sale must exist in the business (`SALE_NOT_FOUND`) and be `COMPLETED` (`SALE_VOIDED`). Attendants may attach payments only to their own sales (`SALE_NOT_FOUND` otherwise, the same answer as a missing sale); managers and owners to any. Same payment rules, flags and duplicate-code handling as `sale.create`. Result: `{ paid_total, balance_due, flags }`.

**sale.void**: `{ sale_id, reason, note?, approval_id? }`.
- Permission: the member has `sales.void`, or the payload has a valid `approval_id` with purpose `SALE_VOID`. A member who has the permission has any `approval_id` ignored and not consumed. Neither: `PERMISSION_DENIED`. A bad approval: `APPROVAL_INVALID` (the same answer for missing, used, expired, another member's, another business's, wrong purpose).
- One transaction: consume the approval if used; mark the sale `VOIDED` with one conditional `UPDATE sale SET status = 'VOIDED' ... WHERE id = $id AND status = 'COMPLETED'` (zero rows: `SALE_ALREADY_VOIDED` if it exists, `SALE_NOT_FOUND` if not); mark its payments `REVERSED`; write one `SALE_VOID` movement per item (non-strict increase, in lock order) at the sale's location; write the audit row.
- A failed void (any reason) rolls back everything including the approval consumption; the approval stays usable.
- Void can happen any time, however old. Result: `{ sale_id, voided_at, approved_by_membership_id }`.

## 6. Approvals for voids

Reuse the Phase C mechanism; do not copy it.
- The existing routes stay where they are. `GET /v1/stock/approvers` gains an optional `purpose` query parameter (default `STOCK_CONVERT`); `POST /v1/stock/approvals` already has `purpose` in its body and now accepts `SALE_VOID`. Moving the routes to a neutral prefix is not worth the break; note it in `architecture.md`.
- Eligible approvers for `SALE_VOID` are active members, other than the caller, with an effective `sales.void`. A caller who already has `sales.void` gets `422 APPROVAL_NOT_NEEDED`.
- Everything else is as in Phase C: the same `403 APPROVAL_DENIED` for every failure with one scrypt run, the approver's separate approval counters (shared by both purposes: five wrong guesses lock approvals by that person for 15 minutes), 15 minute validity by `occurred_at`, the 24 hour server cap, binding to requester and device, single use, live re-check of the approver, audit `approval.granted` and `approval.locked`.
- The approval's `purpose` must match at consumption (an approval for `STOCK_CONVERT` cannot void a sale, and the other way round).

## 7. Reads

Protected routes. No business parameter (`business_id` in a query is `422`, in a header ignored). Attendants (members without `sales.void`) see only sales they created; members with `sales.void` see all of the business's sales. A sale of another member is `404` for an attendant, the same as a missing one.

- `GET /v1/sales?from=&to=&location_id=&status=&created_by=&limit=&cursor=`: newest first by `(occurred_at, id)` with the shared `SignedCursor` (which binds the filters). Row: `id, sale_number, local_ref, location_id, occurred_at, status, total, paid_total, balance_due, created_by { membership_id, display_name }, item_count`. `created_by` as a filter is honoured only for members with `sales.void` (an attendant's value is ignored). `limit` default 20, max 100.
- `GET /v1/sales/:id`: the sale with `items` (with names, quantity, `unit_price`, `list_price`, `line_total`; `cost_price` key absent without `costs.view`) and `payments` (method, amount, `mpesa_code`, `verified`, `status`, duplicate flag), plus the void details when voided.

## 8. Sync

`SyncTables` gains `sale`, `sale_item`, `payment` (in that order, after `stock_balance`; parents before children). Each entry goes through the owning module's service (`SalesService`), as in Phase D.
- **Snapshot:** sales with `occurred_at` in the last 30 days (the Clock, constant in config), with their items and payments. Items and payments are paged by their own keyset, restricted to those sales.
- **Changes:** upserts and delete markers follow the Phase D rules. No age filter in `changes` (a void of an old sale must reach the phone). Visibility: a member without `sales.void` receives only their own sales, and an item or payment only when its sale is theirs; others are skipped and the cursor moves past them. `cost_price` on items is absent without `costs.view`; the cursor already binds cost visibility.
- Rows keep the shapes of the reads (snake_case, strings for money).

## 9. Audit

`AuditService.record` in the same transaction, actor passed explicitly. Actions: `sale.created` (sale id, number, location, total, line count, flags), `payment.attached` (sale id, count, total, flags; also written when payments come inside `sale.create`, as part of `sale.created` rather than a second row), `sale.voided` (sale id, number, reason enum, approver, approval id), and the Phase C approval actions for the new purpose. Never record notes, M-Pesa codes, product names, unit prices or costs.

## 10. Lessons from earlier phases that apply

- Do not run any test while a migration waits for review.
- Testing method as in `docs/phase-b-design.md` section 12 (new tests during a step; concurrency tests 5 times; gate with earlier Phase E files once; full suite once in the background; end of phase 3 runs in a row with real numbers).
- Rows written in one transaction share `created_at`; order by `change_log.id`, or compare as a set.
- Race tests must force the overlap (a held-open transaction or a barrier), never rely on luck.
- Keep transactions short (an idle or long transaction holds back `changes` for every shop). No network calls in a transaction.
- Hash and verify PINs before opening a transaction. No `Promise.all` on one transaction.
- Generated and hand-written objects need a migration and, where Prisma would drop them, the Prisma declaration. Read generated SQL. Do not run `prisma format` on the whole schema.
- Verify every mutation revert byte for byte. Search for leftover mutation markers before the final suite.
- Commit after each passing step and check `git status` is clean.
- Never weaken an earlier test. Report and ask.

## 11. Mistakes AI tends to make here (do not)

- Using JavaScript `number` or floating point for prices, totals or payments (0.1 + 0.2 problems).
- Rejecting a real sale because stock is short, a price looks wrong, the phone's total differs, or a code was used before.
- Trusting the phone's total or list price instead of recomputing from the lines and the server's pack type.
- `max(sale_number) + 1`, or taking the counter before the stock statements, or a Postgres sequence (gaps on rollback, wrong scope).
- Reading stock in JavaScript and writing it back. The sale-mode statement is one atomic upsert.
- Editing or deleting sale items, payments or movements. A void is new rows and a status change, never a delete.
- A void that can run twice (restoring stock twice), or that leaves the approval consumed after a failure.
- Leaving a voided sale's payments as `RECORDED`.
- Letting an attendant see, void or attach payments to another member's sale, or leaking existence through a different error.
- Returning `cost_price` to members without `costs.view` in reads, snapshot, changes or delete markers.
- Putting M-Pesa codes, names, prices or notes in logs or audit metadata.
- Inventing M-Pesa code rules or any Daraja field. `TODO(verify)` and tell Ian.
- Building customer credit, refunds, discounts or Daraja callbacks "while here".
- Copying the approval code instead of extending it.

## 12. Build order

Each step ends with passing tests shown in the session and a commit. Present schema and SQL before applying and run no test until approved.

- **E1: Schema, triggers, doc updates.** Section 3 and the doc updates in section 16. The sale-mode statement stays as it is.
- **E2: sale.create (lines, totals, stock, numbering, flags).** Cash payments excluded here except the empty case.
- **E3: Payments.** Payments inside `sale.create`, `payment.attach`, M-Pesa codes, duplicates.
- **E4: Reads and sync.** Section 7 and 8.
- **E5: Void and approvals.** Section 5 (`sale.void`) and 6.
- **E6: Hardening and handover.** Randomized workload, logs, audit coverage, grants, walkthrough (`docs/phase-e-walkthrough.md`), results (`docs/phase-e-results.md`).

## 13. Test plan

Real Docker database, injectable `Clock`, genuinely concurrent concurrency tests.

**E1**
1. Inventories (RLS tables, triggers, functions, indexes) and the grants inventory list the new objects on purpose; `app_user` has no DELETE on any sale table, no UPDATE on `sale_item`, and UPDATE only on the listed columns of `sale`, `payment` and `sale_counter`.
2. Database checks refuse: a status outside the list; a partial set of void fields; a void reason outside the list; a negative total or balance; a payment amount of 0; `mpesa_code` on `CASH` or missing on `MPESA`; a quantity outside 1 to 100,000; a note over 200 or a local reference over 30 characters; `SALE_VOID` movements with a negative change.
3. Composite keys: a sale's location, device and creator, an item's pack type, a payment's sale and creator, a movement's sale, and a void approval must belong to the same business.
4. The partial unique index: two normal payments with one code in a business conflict; a duplicate-marked payment does not; the same code in two businesses is fine.
5. Triggers write `change_log` for insert and update on the three tables; a rolled-back change writes none.
6. A `VOIDED` sale cannot be updated again (the chosen rule).
7. Earlier suites pass (changed only mechanically).

**E2**
1. A sale with three lines creates the sale, items (with names, list price, cost price snapshots), `SALE` movements with `quantity_after` and `sale_id`, decreases balances, assigns `sale_number` 1, and returns the result.
2. Totals use exact decimals: 3 lines such as 3 x 33.33, 7 x 0.10 and 1 x 19.99 give the exact total; a phone total that differs is saved with the server total and the command is `FLAGGED / TOTAL_MISMATCH`; a matching or absent phone total is `ACCEPTED`.
3. Sale mode: balance 2, a sale of 5 is `FLAGGED / STOCK_NEGATIVE`, balance -3, sale fully saved. 50 concurrent sales of 1 against balance 10: all accepted, final -40, exactly 40 flagged, ledger sum equals balance (5 runs).
4. Numbering: 30 concurrent sales in one business get exactly the numbers 1 to 30 once each; a second business starts at 1; a sale that fails and rolls back leaves no gap; the same command id 20 times concurrently makes one sale.
5. Bad lines: zero lines, 101 lines, quantity 0, negative, 1.5, over 100,000, a negative price, an unknown pack type, and a pack type of another business: all bad lines are reported with numbers and nothing is saved; a price of 0 is allowed.
6. A repeated `sale_id` with a new command id is `SALE_ALREADY_EXISTS`.
7. Archived location, product and pack type are accepted. An unknown or another business's location is `LOCATION_NOT_FOUND`.
8. Permissions: no `sales.create` is `PERMISSION_DENIED`; a suspended member is refused.
9. Concurrent sales and a stock count and a conversion on the same pools: ledger sum equals balance, no deadlock (5 runs).
10. Audit `sale.created` once, in the same transaction; a forced failure after the audit insert leaves no audit row, no sale, no stock change and no counter increase; audit metadata has no note, name or price.

**E3**
1. Cash and M-Pesa payments inside a sale: rows created with `verified = false`, `paid_total` and `balance_due` right; split payments; fewer payments than the total leaves a balance; more is `FLAGGED / OVERPAYMENT`.
2. Payment validation reports every bad payment: bad method, amount 0 or negative, `MPESA` without a code, `CASH` with a code, a code that is too short, too long or has other characters; nothing is saved. Lower-case codes are stored upper-case.
3. A reused code (same business) keeps the sale, marks the new payment as a duplicate of the first, and flags the command `DUPLICATE_MPESA_CODE`; the same code in another business is fine. 20 concurrent sales using one code: exactly one original and 19 duplicates, all sales saved.
4. `payment.attach`: pays a balance; unknown sale, another business's sale, and (for attendants) another member's sale all give `SALE_NOT_FOUND`; a voided sale is `SALE_VOIDED`; overpayment flagged; same command id twice attaches once.
5. A member with `sales.create` but without `payments.confirm` is denied when payments are present, and allowed without payments; an attendant sale with payments works.
6. Audit `sale.created` and `payment.attached`; no code or amount detail beyond totals in audit metadata.

**E4**
1. `GET /v1/sales`: newest first, filters, paging with a signed cursor (tampered is `422`), `business_id` parameter `422`. An attendant sees only their own; a manager sees all; `created_by` is ignored for attendants; an attendant asking for another member's sale by id gets `404`.
2. `GET /v1/sales/:id`: items, payments, void details; `cost_price` key absent without `costs.view`; another business's sale is `404`.
3. Identical data in two businesses never mixes.
4. Snapshot: sales within 30 days (move the Clock) with items and payments, paged with a small limit, each exactly once; older sales excluded; attendants get only their own; costs hidden as above.
5. Changes: a new sale, an attached payment and a void reach the phone once each as current state; a manager's sale never reaches an attendant, nor do its items and payments, and the cursor moves past them; a void of a sale older than 30 days still arrives; the out-of-order commit case with a held-open transaction (5 runs).
6. A manager who gains `costs.view` gets `410 SNAPSHOT_REQUIRED` as before and the new snapshot shows item costs.

**E5**
1. A manager voids a sale: status `VOIDED`, void fields set, payments `REVERSED`, one `SALE_VOID` movement per item, balances restored, `approved_by` is the manager.
2. Void twice (two commands): the second is `SALE_ALREADY_VOIDED`, stock restored once. 20 concurrent voids of one sale: exactly one `ACCEPTED`, stock restored once (5 runs).
3. An attendant without an approval is `PERMISSION_DENIED`; with a valid `SALE_VOID` approval the void works, `approved_by` is the approver, the approval is consumed; reuse is `APPROVAL_INVALID`; 20 concurrent commands using one approval give exactly one `ACCEPTED`.
4. Approval rules: an approval for `STOCK_CONVERT` cannot void a sale and a `SALE_VOID` approval cannot convert; another member's, another device's, expired (15 minutes by `occurred_at`), older than 24 hours at receipt, and approver no longer holding `sales.void` all give `APPROVAL_INVALID`; an attendant as approver is refused at minting with the same `403 APPROVAL_DENIED`; a caller with `sales.void` gets `422 APPROVAL_NOT_NEEDED`; approver counters are shared between purposes (three wrong guesses on each purpose lock at five).
5. A void that fails (already voided, unknown sale) leaves the approval unused.
6. An unknown sale and another business's sale are the same `SALE_NOT_FOUND`.
7. A voided sale blocks `payment.attach`.
8. Stock returns for archived pack types. Void restores to the sale's location.
9. Audit `sale.voided` (with approver) once and `approval.granted`; no note in audit; `change_log` rows for the sale, payments and balances.

**E6**
1. Randomized, seeded and replayable (`E6_SEED`): two businesses, 3 pack types, 200 operations in waves (sales with cash and M-Pesa and split payments, payment attaches, voids by managers and by attendants with approvals, receives, counts, conversions) run concurrently through the real API. At the end: every balance equals its ledger sum, `sale_number`s are exactly 1..N per business, each sale's `paid_total` equals the sum of its non-reversed payments, each sale's total equals its items, every voided sale restored exactly its quantities, consumed approvals equal accepted approved commands, the integrity check is clean, nothing crossed businesses. At least three seeds.
2. Logs: marker product name, note, M-Pesa code, reference and prices in requests; no marker, code, amount detail, price, note or approval id in any log line.
3. Every audit action of section 9 exactly once per event, in the same transaction.
4. The grants inventory matches section 3.
5. The walkthrough runs as a test and once against the built API on the test database.
6. The results file has no placeholders.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, revert and verify the revert:
1. Total calculated with JavaScript floating point: E2 test 2.
2. Phone total trusted without the mismatch flag: E2 test 2.
3. Strict stock decrease on sales: E2 test 3.
4. `sale_number` from `max() + 1`: E2 test 4.
5. A reused M-Pesa code rejects the sale: E3 test 3.
6. Void without the `status = 'COMPLETED'` condition, or without restoring stock: E5 test 2 and E5 test 1.
7. An attendant voids without an approval: E5 test 3.
8. The approval purpose not checked: E5 test 4.
9. An attendant sees other members' sales in reads: E4 test 1; in `changes`: E4 test 5.
10. `cost_price` on items without `costs.view`: E4 test 2 and E4 test 5.
11. A payment total that does not update `balance_due`: E3 test 1.

## 14. Manual walkthrough (for Ian)

At the end of E6, Claude Code writes `docs/phase-e-walkthrough.md` (curl) running this story against the local API with the fake senders and dev fixed codes:

1. The owner, a manager and an attendant exist; the manager has stock of a piece and a carton. 2. The attendant sells 3 pieces and 1 carton, paying part cash and part with an M-Pesa code; the receipt data shows the numbers. 3. A sale with a wrong phone total is saved and flagged. 4. A sale bigger than stock is saved and the stock goes negative and is flagged. 5. The same M-Pesa code on a second sale is flagged. 6. The attendant pays off a balance with `payment.attach`. 7. The attendant tries to void a sale and is refused; asks the manager for approval with the manager's PIN; the void works and stock returns. 8. The manager lists all sales; the attendant lists only theirs; costs are hidden from the attendant. 9. A second phone does a snapshot and then `changes` and sees the sales. 10. A second business sees none of it.

Ian runs it and writes down anything that surprised him.

## 15. Results file

When E6 is finished, Claude Code writes `docs/phase-e-results.md` in the style of `docs/phase-d-results.md`: status line (only Ian marks the phase done), a summary table per step with "new" and "Phase E cumulative" test counts, final patterns (sale-mode statement and the sale write order, the counter, the flags, the void statement, the duplicate-code handling, the purpose-aware approvals), the mutation proofs, versions, things to know, open risks, changes to other docs, and the final suite results with every number filled in (3 runs in a row).

## 16. Doc updates to make in E1 (show Ian the diff before committing)

- `CLAUDE.md` section 2: the phase table row for E becomes "sales, manual payments, voids, sales in sync"; add a row "M: Daraja C2B callbacks and M-Pesa verification (after E, needs Safaricom setup)" and keep F to H as they are. Do not touch the status line.
- `docs/architecture.md`: section 5 (the commands, flags and results; sales in the snapshot and changes), section 8 (manual payments as built; Daraja moved to Phase M), section 12 (the new tables and columns), section 13 (the sales endpoints and the approval `purpose`), section 14 (`payments.approve` is not used until Phase M), section 16 (open items below).

## 17. Open items

1. Phase M: Daraja C2B callbacks, `mpesa_transaction`, verification, unmatched payments, reconciliation; needs the Safaricom account, confirmed IP ranges and real field names. `payments.approve` is unused until then.
2. The real M-Pesa code format (the 8 to 12 letters and digits rule is a placeholder).
3. Customer accounts and credit sales for wholesalers (balance due exists, but there is no customer behind it).
4. Partial returns and refunds (today only whole-sale voids).
5. Discount rules and reports of below-list prices (Phase G); the data is recorded.
6. Receipt printing and the exact receipt content (phone side).
7. Tax and eTIMS (unverified, later).
8. Per-business `sale_number` is serialised by the counter row: measure with a busy wholesaler on several phones; if it hurts, revisit.
9. Notifying the approver and the owner when a PIN approves a void (Phase F).
10. Sale-mode stock for sales made while offline for days can swing balances; counts (Phase C) are the correction tool.
