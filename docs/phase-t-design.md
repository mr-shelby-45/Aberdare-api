# Phase T design: Field sales (hawkers)

Status: approved by Ian on 2026-10-27 (all six questions answered with the recommended defaults). This file is the source of truth for Phase T. Where it disagrees with `docs/architecture.md` or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 15). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md` and the results files of Phases A to E (the "Final patterns" and "Things to know" of each). The patterns proven there are the way to do things. Do not invent new ones.

Do not start until Ian has marked Phase E done in `CLAUDE.md` section 2.

## 1. Goal and scope

A shop employee, the field attendant, takes stock from the shop in the morning, sells it on foot or by vehicle, confirms payments by typing the M-Pesa code into the app (the money goes to the shop's till, never to the attendant's number), and settles with a manager in the evening. The shop always knows what stock is with whom and what each attendant owes.

The design reuses what exists. A field attendant's stock is a location of kind `FIELD` assigned to them. Their sales are ordinary `sale.create` commands against that location. Payments are the Phase E manual payments. What is new: location kinds and assignment, a location scope for the `FIELD_ATTENDANT` preset, stock transfers (`stock.issue`, `stock.return`), and the day-end settlement.

In scope:
- `location.kind` and `location.assigned_membership_id`; the owner creates and reassigns field locations through the existing location management.
- The `FIELD_ATTENDANT` preset and the location scope, enforced on commands, reads and sync.
- Commands: `stock.issue`, `stock.return`, `settlement.close`.
- Reads: `GET /v1/field/settlements/preview`, `GET /v1/field/settlements`, `GET /v1/field/settlements/:id`.
- Permissions `stock.transfer` and `field.settle` (managers and owners).
- A sales flag `AFTER_SETTLEMENT`.

Out of scope (do not build): transfers between two shop or warehouse locations (the transfer service is general, but only issue and return are exposed), acknowledgement of received stock by the attendant, a separate hawking price list, GPS or routes or customer visits, customer accounts and credit, a cash accounting ledger or payroll deductions, settlements syncing to phones, M-Pesa verification (Phase M), notifications (Phase F), reports (Phase G).

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Model | Field stock is a `FIELD` location assigned to one attendant. One active field location per attendant. A location can be reassigned (archive the old one, create a new one). |
| Issue and return | One step, by a manager or owner (`stock.transfer`). The attendant sees it after a sync. |
| Scope | The `FIELD_ATTENDANT` preset sells only from, and sees stock only of, the locations assigned to them. Enforced on commands, reads and sync. |
| Settlement | Closed by a manager or owner (`field.settle`). Server-computed figures; the manager enters counted stock and cash received. Shortages become `LOST` adjustments tied to the attendant, surpluses `FOUND`. |
| Payments | No model change. The settlement lists cash, verified M-Pesa and unverified M-Pesa separately. |
| Prices | Same prices as the shop. Price recording is unchanged. |

## 3. Data model

Same rules as before: tenant tables have `id`, `business_id`, `created_at`, forced RLS with the `shop_only` NULLIF policy, composite foreign keys, unique `(business_id, id)`, explicit grants. Claude Code proposes the exact Prisma schema and SQL for each step and waits for approval before applying. Check what exists first (how Phase B manages locations, how presets and extra permissions are stored). Every new table, trigger, function and hand-written index goes into the exact inventories in `test/step4-migrations.spec.ts` and the grants inventory in `test/b5-hardening.spec.ts`.

**location** (exists)
- `kind text not null default 'SHOP'`, check in `SHOP`, `WAREHOUSE`, `FIELD`.
- `assigned_membership_id uuid null` (composite foreign key to `membership`). Check: set exactly when `kind = 'FIELD'`. A `FIELD` location cannot be the default location.
- Partial unique index `(business_id, assigned_membership_id) WHERE kind = 'FIELD' AND archived_at IS NULL`: one active field location per attendant.
- The assigned member must hold the `FIELD_ATTENDANT` preset at the time of assignment (checked by the service). A later preset change does not remove the assignment.
- Location changes keep writing `change_log` and audit rows (kind and assignee added to the audit metadata).

**stock_transfer** (new, tenant, append-only)
- `from_location_id`, `to_location_id` (composite foreign keys, different), `kind` check in `ISSUE`, `RETURN`, `occurred_at`, `created_by_membership_id`, `sync_command_id`, `reference` (at most 60), `note` (at most 200).

**stock_movement**
- Widen the type check with `TRANSFER_OUT` (negative) and `TRANSFER_IN` (positive).
- `transfer_id uuid null` (composite foreign key to `stock_transfer`), required exactly for the two transfer types.
- `settlement_id uuid null` (composite foreign key to `field_settlement`), allowed only on `ADJUST` movements (the settlement's adjustments).

**field_settlement** (new, tenant, append-only)
- `field_location_id`, `attendant_membership_id` (the location's assignee), `closed_by_membership_id`, `occurred_at`, `received_at`, `period_start`, `period_end` (`period_end = received_at`; `period_start` is the previous settlement's `period_end` for that location, or the location's `created_at`).
- `expected_cash numeric(14,2)`, `cash_received numeric(14,2)` (`>= 0`), `cash_variance numeric(14,2)` (received minus expected), `mpesa_verified_total`, `mpesa_unverified_total` (both `numeric(14,2)`), `sale_count integer`, `voided_count integer`, `unpaid_total numeric(14,2)` (sum of balance due of the window's completed sales), `note` (at most 200).

**field_settlement_line** (new, tenant, append-only)
- `settlement_id`, `pack_type_id`, `issued`, `returned`, `sold`, `voided_back` (all integers, from the ledger in the window), `expected_quantity` (the balance at close), `counted_quantity`, `variance` (counted minus expected).

**Permissions and presets:** add `stock.transfer` and `field.settle` to the manager and owner presets. Add the `FIELD_ATTENDANT` preset: `sales.create`, `payments.confirm`, `stock.view`. A `FIELD_ATTENDANT` member accepts no extra permissions (`EXTRA_PERMISSIONS_NOT_ALLOWED` from the staff API, same error shape as the existing rule for `stock.convert`). Follow how Phase A stores presets and effective permissions.

**change_log triggers** (hand-written SQL, one migration per object, reuse the generic function): none new. `stock_transfer` and settlements are not synced.

## 4. The location scope

- A member with the `FIELD_ATTENDANT` preset is **restricted** to the locations whose `assigned_membership_id` is theirs, active or archived (an offline sale into a location that was archived meanwhile must still be accepted). Everyone else is unrestricted.
- One helper (for example `LocationScope`, resolved from the live membership, never copied) answers `allows(locationId)` and returns the allowed ids for queries. Do not scatter ad hoc checks.
- A location outside the scope behaves exactly like a location that does not exist or belongs to another business (`LOCATION_NOT_FOUND`, `404`, or an empty list).
- Enforce it on:
  - `sale.create` (the location), `payment.attach` and `sale.void` (the sale's location, on top of the existing own-sales rule), `stock.convert` (the location, with approval as before).
  - `GET /v1/stock` and `GET /v1/stock/movements` (rows limited to allowed locations; a `location_id` filter outside the scope gives an empty list).
  - Snapshot and changes: the `location` table (only allowed locations) and `stock_balance` (only allowed locations); other rows are skipped, never sent as delete markers. Sale tables already follow the own-sales rule.
  - Location reads, wherever they are exposed.
- A `FIELD_ATTENDANT` with no assigned location cannot sell: `sale.create` is `LOCATION_NOT_FOUND`. They receive no stock rows.
- The changes cursor already binds `costs` and `all_sales`. Bind the scope too: `scope` is `all` or a short digest of the sorted allowed location ids. A change in scope gives `410 SNAPSHOT_REQUIRED`. Old cursors are refused once with `422`, like Phase E.

## 5. Stock transfers

A general `StockService.transfer()` moves lines from one location to another; only issue and return are exposed.

**stock.issue**: `{ from_location_id, to_location_id, reference?, note?, lines: [{ pack_type_id, quantity }] }`.
- Permission `stock.transfer`. Source: an active `SHOP` or `WAREHOUSE` location. Destination: an active `FIELD` location. Pack types active.
- Source decrease is **strict** (`STOCK_INSUFFICIENT`, nothing changes). Destination increase is the capped non-strict statement.

**stock.return**: same payload.
- Permission `stock.transfer`. Source: a `FIELD` location (active or archived). Destination: an active `SHOP` or `WAREHOUSE`. Pack types may be archived.
- Source decrease is strict: the server balance is what the attendant's synced sales left. A return larger than the server balance is `STOCK_INSUFFICIENT` (the attendant syncs first, or the manager counts and settles).

Both: 1 to 50 lines, no repeated pack type, quantity 1 to 1,000,000, all or nothing, every bad line reported (`INVALID_LINES`, the Phase C pattern; reasons `PACK_TYPE_NOT_FOUND`, `PACK_TYPE_ARCHIVED`, `QUANTITY_INVALID`, `DUPLICATE_LINE`); command reasons `LOCATION_NOT_FOUND`, `LOCATION_ARCHIVED`, `LOCATION_KIND_INVALID`, `VALIDATION_FAILED`, `STOCK_INSUFFICIENT`. Result `{ transfer_id, lines: [{ pack_type_id, from_after, to_after }] }`.

Rows: one `stock_transfer`, and per line one `TRANSFER_OUT` and one `TRANSFER_IN` movement with `quantity_after` and `transfer_id`.

**Lock order:** every balance statement of one transfer, on both locations, runs in one global order: by location id, then the shared pack type lock order. An issue and a return running in opposite directions over the same pools must not deadlock. Show Ian the exact ordering.

Audit `stock.issued` and `stock.returned` (locations, kind, lines of `{ pack_type_id, quantity }`), never the note.

## 6. Settlement

**The day-end routine** (documented in the walkthrough): the attendant syncs their phone; the manager issues no more; the attendant hands back unsold stock and the manager records it with `stock.return`; the manager previews the settlement, counts what is left with the attendant (normally nothing), takes the cash, and closes the settlement.

**GET /v1/field/settlements/preview?location_id=** (permission `field.settle`): for the field location, since its last settlement, the figures a close would store: per pack type `issued`, `returned`, `sold`, `voided_back`, `expected_quantity`; and `expected_cash`, `mpesa_verified_total` (0 until Phase M), `mpesa_unverified_total`, `sale_count`, `voided_count`, `unpaid_total`, `last_synced_at` of the attendant's devices. Read only.

**settlement.close**: `{ settlement_id, field_location_id, cash_received, note?, lines: [{ pack_type_id, counted_quantity }] }`. `settlement_id` is the primary key, from the phone.
- Permission `field.settle`. The location must be an active or archived `FIELD` location of the business (`LOCATION_NOT_FOUND` otherwise).
- `lines`: 0 to 50, no repeated pack type, `counted_quantity` 0 to 2,000,000,000. Every pack type with a nonzero balance at the location, or with movements in the window, must appear (`INVALID_LINES`, reason `LINE_MISSING`, so nothing is silently skipped); extra lines with no history are `PACK_TYPE_NOT_FOUND`-style bad lines.
- Block if the attendant's devices have not synced recently: the most recent `last_sync_at` among the assignee's devices must be within 10 minutes of the command's `received_at` (a constant in config), otherwise `REJECTED / ATTENDANT_NOT_SYNCED`. This does not prove an empty outbox; the `AFTER_SETTLEMENT` flag below is the backstop.
- Serialise settlements of one location: lock the location row with `FOR NO KEY UPDATE`. **Not** `FOR UPDATE`: every sale's foreign key takes a key-share lock on its location row, so `FOR UPDATE` would deadlock with sales. Prove it with a forced test.
- One transaction: window and figures from the ledger and payments; per line, one atomic statement that locks the balance row and sets it to `counted_quantity` while returning the old value, so the adjustment `delta = counted - old` is computed in SQL from the locked row (never read in JavaScript and written back; show Ian the exact statement); a nonzero delta writes an `ADJUST` movement (`LOST` when negative, `FOUND` when positive) with `settlement_id` and the attendant as the subject in the note field; then the settlement rows; then the audit row.
- Window rule: sales belong to the first settlement closed at or after their `received_at`, so each sale is counted in exactly one settlement. Use `received_at`, never `occurred_at`. Payments of the window are those of the window's `COMPLETED` sales (reversed payments excluded); `CASH` and `MPESA` totals by method, and verified or not.
- Result: `{ settlement_id, cash_variance, lines: [{ pack_type_id, variance }] }`.
- The settlement is final. No update, no delete, no reopen. A mistake is corrected by the next settlement and a note.

**AFTER_SETTLEMENT flag:** `sale.create` at a field location whose latest settlement has `period_end` at or after the sale's `occurred_at` is saved and flagged `AFTER_SETTLEMENT` (added to the end of the Phase E flag order). It means a sale from the attendant's phone reached the server after their day was closed, and the owner should look at the settlement. Everything else about the sale is unchanged.

**Reads:** `GET /v1/field/settlements?location_id=&limit=&cursor=` (newest first, signed cursor) and `GET /v1/field/settlements/:id` with lines. Permission `field.settle`. Money as strings.

Audit `settlement.closed` (settlement id, attendant, location, sale count, expected cash, cash received, variance, count of lines with a variance). Never the note or any name.

## 7. Sync

- `location` and `stock_balance` follow the scope in section 4. Nothing new joins `SyncTables`.
- Phase D and E rules stay: finished transactions only, cursor binds `costs`, `all_sales` and now `scope`.
- The field attendant's phone needs its issued stock before leaving. The attendant's snapshot or changes sync after the manager's `stock.issue` shows it. Sales never wait for it.

## 8. Lessons from earlier phases that apply

- Do not run any test while a migration waits for review.
- Testing method as in `docs/phase-b-design.md` section 12 (new tests during a step; concurrency tests 5 times; gate with earlier Phase T files once; full suite once in the background; end of phase 3 runs in a row with real numbers).
- A statement that holds a balance row lock until commit queues the others. A race test of anything taken after it must use different pools, or force the overlap with a held-open transaction and a wait for lock waiters.
- Lock order: sale row, stock pools, payments (E6 deadlock fix). Settlement and transfers must not invert it.
- Rows in one transaction share `created_at`; order through ids.
- Generated and hand-written objects need a migration and, where Prisma would drop them, the Prisma declaration. Do not run `prisma format` on the whole schema.
- Verify every mutation revert byte for byte. Search for leftover mutation markers before the final suite.
- Commit after each passing step and check `git status` is clean.
- Never weaken an earlier test. Report and ask.

## 9. Mistakes AI tends to make here (do not)

- Checking the scope in some places and forgetting others (reads, snapshot, changes, payment attach, void, convert). One helper, and tests for every entry point.
- Treating an out-of-scope location differently from a missing one (an existence leak).
- Rejecting a field attendant's sale into a location that was archived or reassigned while they were offline.
- A scope change that does not invalidate the changes cursor.
- Letting the strict return or issue read the balance in JavaScript, or lock the two locations in different orders for opposite directions.
- Locking the location row `FOR UPDATE` in the settlement (deadlocks with sales).
- Computing the settlement variance against a number the phone sent. The expected stock comes from the server, atomically, at close.
- Reading the balance in JavaScript, then writing the counted number. One statement, with the movement delta computed in SQL.
- Counting a sale in two settlements or in none (use `received_at` and the previous `period_end`).
- Changing a closed settlement, or letting a settlement skip a pack type that still has stock.
- Putting names, notes or amounts beyond the audit fields in logs, or notes in audit metadata.
- Giving extra permissions to a `FIELD_ATTENDANT`, which would break the scope and the sales visibility rule.
- Building acknowledgement, a hawking price list, customer credit or Daraja logic "while here".

## 10. Build order

Each step ends with passing tests shown in the session and a commit. Present schema and SQL before applying and run no test until approved.

- **T1: Schema, preset, permissions, doc updates.** Section 3 and the doc updates in section 15.
- **T2: Location scope.** Section 4 and 7, for commands, reads, snapshot, changes, the cursor.
- **T3: Issue and return.** Section 5.
- **T4: Settlement.** Section 6 (preview, close, reads, `AFTER_SETTLEMENT`).
- **T5: Hardening and handover.** Randomized workload, logs, audit, grants, walkthrough (`docs/phase-t-walkthrough.md`), results (`docs/phase-t-results.md`).

## 11. Test plan

Real Docker database, injectable `Clock`, genuinely concurrent concurrency tests.

**T1**
1. Inventories (RLS tables, triggers, indexes) and the grants inventory list the new objects; `app_user` has no UPDATE or DELETE on `stock_transfer`, `field_settlement` or `field_settlement_line`, and no DELETE anywhere new.
2. Database checks refuse: a location kind outside the list; `assigned_membership_id` on a non-`FIELD` location, or missing on a `FIELD` one; a default `FIELD` location; two active `FIELD` locations for one attendant (an archived one plus a new one is fine); a transfer to the same location; a `TRANSFER_*` movement without `transfer_id` or with the wrong sign; `settlement_id` on a non-`ADJUST` movement; a negative `cash_received`.
3. Composite keys: transfer locations, settlement location, assignee, closer and lines must belong to the same business.
4. The `FIELD_ATTENDANT` preset exists with exactly its three permissions; managers and owners gain `stock.transfer` and `field.settle`; attendants gain neither; a `FIELD_ATTENDANT` with extra permissions is `EXTRA_PERMISSIONS_NOT_ALLOWED`; `stock.convert` as an extra is still refused for everyone below manager.
5. The owner creates a `FIELD` location assigned to a `FIELD_ATTENDANT`; assigning a non-field member is refused; location audit rows carry kind and assignee; an unassigned `FIELD` location is refused.
6. Earlier suites pass (changed only mechanically).

**T2**
1. A field attendant can sell from their location. A sale at the main shop, at another field location, and at a location of another business all give `LOCATION_NOT_FOUND`, the same as a missing id. A field attendant with no location cannot sell.
2. A sale into the attendant's location after it was archived is accepted (offline sale); after the location is reassigned to another member it is still accepted for the original assignee.
3. `payment.attach`, `sale.void` (with approval) and `stock.convert` (with approval) at an out-of-scope location are refused as not found.
4. `GET /v1/stock` and `GET /v1/stock/movements` show only the attendant's locations; a `location_id` filter outside the scope gives an empty list identical to a nonexistent one; managers still see all.
5. Snapshot: the attendant gets only their `location` and `stock_balance` rows (and the usual products, pack types, barcodes and own sales); changes send only those; rows of other locations are skipped, never sent as delete markers.
6. Cursor: a change in scope (reassignment, a new field location, preset change to or from `FIELD_ATTENDANT`) gives `410 SNAPSHOT_REQUIRED`; an old cursor without `scope` is `422` once.
7. A suspended member and a revoked device are refused as before.
8. Tenant isolation: another business's locations never appear.

**T3**
1. An issue moves stock: one `stock_transfer`, a `TRANSFER_OUT` and a `TRANSFER_IN` per line with `quantity_after` and `transfer_id`; shop balance down, field balance up; a return reverses it.
2. Strictness: an issue of more than the shop holds is `STOCK_INSUFFICIENT` and nothing changes; a return of more than the field balance is `STOCK_INSUFFICIENT`.
3. Kinds: an issue to a non-field location, from a field location, or between two shop locations is `LOCATION_KIND_INVALID`; an archived destination is `LOCATION_ARCHIVED`; a return from an archived field location works; an issue of an archived pack type is a bad line, a return of one is allowed.
4. All or nothing: several bad lines are all reported with numbers and reasons, nothing is saved; zero lines, 51 lines, duplicates, quantity 0, negative, 1.5, over 1,000,000.
5. Permissions: an attendant and a field attendant are denied; a manager and an owner succeed.
6. Concurrency (5 runs): 20 concurrent issues of 1 against a shop balance of 5 give exactly 5 successes; an issue and a return in opposite directions over the same pools, with concurrent sales on the field pool, never deadlock or time out; ledger sum equals balance for every pool; the same command id 20 times applies once.
7. A location or pack type of another business is the same as a missing one.
8. Audit `stock.issued` and `stock.returned` once each, in the same transaction; a forced failure after the audit insert leaves nothing; metadata has no note.
9. `change_log` rows for the changed balances.

**T4**
1. The preview's figures equal a hand calculation for a day with an issue, sales (cash, M-Pesa, split), a void, a return and an adjustment: `issued`, `returned`, `sold`, `voided_back`, `expected_quantity`, cash and M-Pesa totals, `unpaid_total`; voided sales' payments are excluded; the ledger identity (opening plus issued minus returned minus sold plus voided back plus other changes equals expected) holds.
2. Close with the right counts: the settlement rows are stored; no movement for a zero variance; a shortage of 2 writes an `ADJUST / LOST` of -2 with `settlement_id`, a surplus a `FOUND`; the field balance equals the counted quantity afterwards; `cash_variance` is right.
3. The window: a second settlement covers only what came after the first; a sale received after a close belongs to the next settlement; each sale is counted exactly once over 3 consecutive settlements.
4. A line missing for a pack type with a balance is `INVALID_LINES / LINE_MISSING`; nothing saved.
5. `ATTENDANT_NOT_SYNCED` when the assignee's devices last synced more than 10 minutes before the close (move the Clock); fine just under the limit.
6. A sale reaching the server after a close with an earlier `occurred_at` is `FLAGGED / AFTER_SETTLEMENT` and saved; a sale with a later `occurred_at` is not flagged.
7. Concurrency (5 runs): two closes of one location at once serialise (the second sees an empty window); a close racing 20 sales at the field location neither deadlocks nor loses a sale, and the stock identity holds; a forced test shows `FOR NO KEY UPDATE` does not deadlock where `FOR UPDATE` would.
8. Final means final: `app_user` cannot update or delete a settlement or its lines; the same `settlement_id` with a new command id is `SETTLEMENT_ALREADY_EXISTS`; the same command id twice closes once.
9. Permissions: only `field.settle`; a field attendant and an attendant are denied; the list and detail reads need it; another business's settlement is `404`.
10. Audit `settlement.closed` once, in the same transaction; a crash after the audit insert leaves no settlement, no adjustment and the balance unchanged.

**T5**
1. Randomized, seeded and replayable (`T5_SEED`): one business with a shop, a warehouse, 2 field attendants (each with a field location), 200 operations in waves (issues, returns, field sales with cash and M-Pesa, voids by managers, reassignment of one location, settlements, counts, receives) through the real API. At the end: every balance equals its ledger sum; every sale belongs to exactly one settlement or to none yet; each closed settlement's identity holds; field attendants never saw another location in any read, snapshot or changes; the integrity check is clean; nothing crossed businesses. At least three seeds.
2. Logs: marker names, notes and references; no marker, amount or cursor in any log line.
3. Every audit action of section 5 and 6 exactly once per event.
4. The grants inventory matches section 3.
5. The walkthrough runs as a test and once against the built API on the test database.
6. The results file has no placeholders.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, revert and verify the revert:
1. Skip the scope check in `sale.create`: T2 test 1.
2. Skip the scope check in the stock reads: T2 test 4.
3. Skip the scope filter in `changes`: T2 test 5.
4. Leave `scope` out of the cursor comparison: T2 test 6.
5. Make the strict issue non-strict: T3 test 2.
6. Lock the two transfer directions in different orders: T3 test 6.
7. Use `FOR UPDATE` on the location row in the settlement: T4 test 7.
8. Compute the variance against a phone-sent expected quantity: T4 test 2.
9. Window by `occurred_at` instead of `received_at`: T4 test 3.
10. Drop the `AFTER_SETTLEMENT` flag: T4 test 6.
11. Include reversed payments in the expected cash: T4 test 1.
12. Allow extra permissions for a field attendant: T1 test 4.

## 12. Manual walkthrough (for Ian)

At the end of T5, Claude Code writes `docs/phase-t-walkthrough.md` (curl) running this story against the local API with the fake senders and dev fixed codes:

1. The owner has a manager, a shop stocked with cartons and pieces, and a field attendant, and creates a field location for the attendant. 2. The manager issues 10 pieces and 1 carton to the field location. 3. The attendant syncs and sees only their stock. 4. The attendant sells 6 pieces for cash and 3 with an M-Pesa code, and one sale goes to a wrong location and is refused as not found. 5. The attendant tries to void a sale and needs the manager's PIN approval. 6. The manager returns the unsold pieces, previews the settlement, counts what is left (one piece missing), takes the cash (a little short), and closes the settlement; the piece is written off as `LOST`. 7. A late offline sale from the attendant is saved and flagged `AFTER_SETTLEMENT`. 8. A second business sees none of it.

Ian runs it and writes down anything that surprised him.

## 13. Results file

When T5 is finished, Claude Code writes `docs/phase-t-results.md` in the style of `docs/phase-e-results.md`: status line (only Ian marks the phase done), a summary table per step with "new" and "Phase T cumulative" test counts, final patterns (the location scope helper and where it is used, the transfer lock order, the settlement statement and window rule, the `AFTER_SETTLEMENT` flag), the mutation proofs, versions, things to know, open risks, changes to other docs, and the final suite results with every number filled in (3 runs in a row).

## 14. Open items

1. The attendant's acknowledgement of received stock (disputes about the morning count).
2. A separate hawking price list.
3. Settlement history on managers' phones (today online only).
4. A cash and shortage ledger, and payroll deductions (the settlement stores the variances only).
5. Customer credit: unpaid sales exist, with no customer behind them.
6. Verified payments (Phase M); until then M-Pesa totals are unverified, and typed codes can be fake.
7. Generic transfers between two shop or warehouse locations (the service is ready).
8. Whether a field attendant's offline outbox is empty cannot be known by the server; `ATTENDANT_NOT_SYNCED` and `AFTER_SETTLEMENT` reduce the risk but do not remove it.
9. Settlement in a long offline day: the attendant's phone may need days of sales synced first.
10. Notifying the manager of large variances (Phase F).

## 15. Doc updates to make in T1 (show Ian the diff before committing)

- `CLAUDE.md` section 2: add the phase table row "T: field sales (location kinds and scope, issue and return, settlement)" between E and M. Do not touch the status line.
- `docs/architecture.md`: section 4 (the `FIELD_ATTENDANT` preset and location scope), section 5 (the commands, the `AFTER_SETTLEMENT` flag, scope in the cursor), section 6 (transfers, the lock order across locations, settlement adjustments), section 12 (the new tables and columns), section 13 (the settlement endpoints), section 14 (the new permissions and preset), section 16 (open items above).
