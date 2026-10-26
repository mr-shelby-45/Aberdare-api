# Phase C design: Stock

Status: approved by Ian on 2026-10-26 (all seven questions answered with the recommended defaults). This file is the source of truth for Phase C. Where it disagrees with `docs/architecture.md` or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 16). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md`, `docs/phase-a-results.md` and `docs/phase-b-results.md` ("Final patterns" and "Things to know" in each). The patterns proven there are the way to do things. Do not invent new ones.

Phase C builds on Phases A and B. Do not start until Ian has marked Phase B done in `CLAUDE.md` section 2.

## 1. Goal and scope

Stock can be received, corrected, counted and converted from cartons to pieces, every change is in an append-only ledger, and the cached balance always equals the ledger. Staff can read balances and history. An attendant can convert a carton only with a manager's or owner's PIN approval.

In scope:
- Commands: `stock.receive`, `stock.adjust`, `stock.count`, `stock.convert` (replacing the spike's minimal receive and adjust handlers).
- Reads: `GET /v1/stock`, `GET /v1/stock/movements`.
- Approvals: `GET /v1/stock/approvers`, `POST /v1/stock/approvals`, and the convert command using an approval.
- Ledger columns, balance change-log trigger, a stock integrity check function.
- Housekeeping: log database error codes as `errorCode`.

Out of scope (do not build): sales decrements (Phase E; the sale-mode repository code from the spike stays as it is), transfers between locations, lots or serials, expiry dates, reorder levels and low-stock alerts (Phase F), stock valuation or average cost, automatic changes to `cost_price` on receipt, suppliers or purchase orders, scheduling the nightly integrity job (Phase F), reports (Phase G), snapshot and changes endpoints (Phase D), push or SMS.

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Approval | Minted online with the approver's PIN (`POST /stock/approvals`), then carried by the convert command, which can be processed later. PIN hashes are never stored on phones. |
| Receive | One command is one delivery: 1 to 50 lines, all or nothing. A rejection lists every bad line. |
| Cost on receipt | `unit_cost` is recorded on the movement only (needs `costs.view`). `cost_price` on the pack type never changes automatically. |
| Count | Applies `counted minus expected` (the phone's expected quantity), never "set to the current server balance". |
| Approval PIN attempts | Own counter per approver. Five wrong attempts stop approvals by that person for 15 minutes. Their own login is never affected. |
| Transfers between locations | Later. |
| Housekeeping | Log database error codes as `errorCode` (the redaction of the field name `code` stays). |

## 3. Data model

Same rules as before: tenant tables have `id`, `business_id`, `created_at`, forced RLS with the `shop_only` NULLIF policy, composite foreign keys, unique `(business_id, id)`, explicit grants. Claude Code proposes the exact Prisma schema and SQL for each step and waits for approval before applying. Check what exists in `schema.prisma` first. Adding a NOT NULL column to a table with rows fails: use the default-then-drop trick, or (for columns with no sensible default) clear local test data with Ian's approval, as in A2. Every new table, trigger, function and hand-written index goes into the exact inventories in `test/step4-migrations.spec.ts`, and the grants inventory in `test/b5-hardening.spec.ts`.

**stock_movement** (exists, append-only: `app_user` keeps SELECT and INSERT only)
- `movement_type text not null`, check in `RECEIVE`, `ADJUST`, `COUNT`, `CONVERT_OUT`, `CONVERT_IN`, `SALE` (`SALE` is already used by the spike's sale-mode code; later phases add more values by migration).
- `quantity_after integer not null`: the balance right after this movement, taken from `RETURNING` on the balance statement.
- `occurred_at timestamptz not null` (phone time).
- `created_by_membership_id uuid null` (composite foreign key to `membership`).
- `sync_command_id uuid null` (composite foreign key to `sync_command`), which also groups the lines of one delivery or count.
- `unit_cost numeric(14,2) null`, check `>= 0`, allowed only when `movement_type = 'RECEIVE'`.
- `reason text null`: required exactly when `movement_type = 'ADJUST'`; check in `DAMAGED`, `EXPIRED`, `LOST`, `FOUND`, `SUPPLIER_RETURN`, `CORRECTION`, `OTHER`.
- `note text null` (at most 200 characters), `reference text null` (at most 60).
- `expected_quantity integer null`, `counted_quantity integer null`: both present exactly when `movement_type = 'COUNT'`, and `quantity_change = counted_quantity - expected_quantity`.
- Sign checks in the database: `RECEIVE` and `CONVERT_IN` positive; `CONVERT_OUT` negative; `ADJUST` with `FOUND` positive and with `DAMAGED`, `EXPIRED`, `LOST`, `SUPPLIER_RETURN` negative (`CORRECTION` and `OTHER` either way). The existing `quantity_change <> 0` check stays.

**stock_balance** (exists): no new columns. Add the `change_log` trigger for insert and update (hand-written SQL, `SECURITY INVOKER`, same pattern as `pack_type`). The balance may be negative (sale mode, counts). No check on `quantity`.

**stock_conversion** (exists)
- Add `created_by_membership_id uuid not null`, `approved_by_membership_id uuid not null` (composite foreign keys to `membership`; a manager or owner converting for themselves is their own approver), `approval_id uuid null` (unique, composite foreign key to `approval`).

**approval** (new, tenant, generic so Phase E can reuse it)
- `purpose text not null` (check in `STOCK_CONVERT` for now), `requester_membership_id`, `approver_membership_id`, `device_id` (all composite foreign keys), `created_at`, `valid_until timestamptz not null` (created plus 15 minutes, from the Clock), `consumed_at timestamptz null`, `consumed_by_sync_command_id uuid null`.
- `app_user`: SELECT, INSERT, and UPDATE only on `(consumed_at, consumed_by_sync_command_id)`. No DELETE.

**membership** (exists): add `approval_failed_count integer not null default 0` and `approval_locked_until timestamptz null`. Updates go through the same narrow statements as the PIN counters (check how A3 did it and follow that).

**Integrity check:** `StockIntegrityService.check()` (tenant scoped) returns every `(location_id, pack_type_id)` whose balance differs from the sum of its movements, including a balance with no movements and movements with no balance. It is a service only. No endpoint, no scheduling (Phase F schedules it per business).

## 4. Stock rules

- **Ledger first.** Every change is one movement row plus one balance statement in the same transaction. Never edit or delete a movement. Corrections are new movements. Never change a balance without a movement.
- **Atomic SQL only.** Strict decrease: one conditional `UPDATE ... WHERE quantity >= $q RETURNING quantity`. Increase and sale mode: one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING quantity`. Never read the balance, check it in JavaScript, then write. Isolation stays READ COMMITTED. (The spike's repository SQL is the starting point; extend it to return and store `quantity_after`.)
- **Quantities** are integers. Per line 1 to 1,000,000. A result above 2,000,000,000 is `VALIDATION_FAILED` (INTEGER guard). No fractional stock.
- **Locations and pack types:** `stock.receive` needs an active location and active pack types. `stock.adjust`, `stock.count` and `stock.convert` also work on archived ones, so old stock can be cleaned up. A location or pack type in another business gives the same answer as one that does not exist.
- **Strictness:** `stock.adjust` decreases and the `stock.convert` source pool are strict (`STOCK_INSUFFICIENT`, nothing changes). `stock.receive` and the count delta are not strict.
- **Lock order for conversions:** always the larger pack first, then the smaller. Conversion only goes from a larger pack to a smaller one, so the order cannot form a cycle. Any future operation touching several balances must use the same rule.

## 5. Commands

All through `POST /v1/sync/commands`, one transaction per command, idempotent, with the existing dispatcher order, `FAILED` logging, and `occurred_at` rule. Payload fields are snake_case like Phase B. Money is a string. IDs come from the phone. `business_id` in a payload is rejected. Replace the spike's payload shapes and update its tests mechanically (the proofs must stay as strong).

When a command with `lines` is rejected for bad lines, `reason` is `INVALID_LINES` and `result` is `{ invalid_lines: [{ line (1-based), reason }] }` listing **every** bad line, not just the first, so the shopkeeper fixes them in one pass. Nothing is saved. A rejected command is final, so the corrected delivery is a new command with a new id (the app's job).

**stock.receive**: `{ location_id, reference?, note?, lines: [{ pack_type_id, quantity, unit_cost? }] }`, 1 to 50 lines, no repeated `pack_type_id`.
- Permission `stock.receive`. A `unit_cost` also needs `costs.view` (otherwise the whole command is `REJECTED / PERMISSION_DENIED`, as for `cost_price`).
- Accepted result: `{ lines: [{ pack_type_id, quantity_after }] }`.
- Line reasons: `PACK_TYPE_NOT_FOUND`, `PACK_TYPE_ARCHIVED`, `QUANTITY_INVALID`, `COST_INVALID`, `DUPLICATE_LINE`. Command reasons: `LOCATION_NOT_FOUND`, `LOCATION_ARCHIVED`, `VALIDATION_FAILED`, `INVALID_LINES`.

**stock.adjust**: `{ location_id, pack_type_id, quantity_change, reason, note? }`.
- Permission `stock.adjust`. The sign must fit the reason (`REASON_SIGN_MISMATCH`). A decrease is strict (`STOCK_INSUFFICIENT`). Result: `{ quantity_after }`.

**stock.count**: `{ location_id, note?, lines: [{ pack_type_id, expected_quantity, counted_quantity }] }`, 1 to 50 lines, no repeats. `counted_quantity >= 0`; `expected_quantity` is any integer (a phone's local balance can be negative).
- Permission `stock.count`. Per line `delta = counted - expected`. A line with delta 0 writes no movement. Otherwise a `COUNT` movement is written and the delta is applied with the non-strict statement.
- If any line ends with a negative balance the command is `FLAGGED` with reason `NEGATIVE_AFTER_COUNT` (still saved). This is the only use of `FLAGGED` in Phase C.
- Result: `{ lines: [{ pack_type_id, delta, quantity_after }] }`.

**stock.convert**: `{ location_id, from_pack_type_id, to_pack_type_id, quantity, note?, approval_id? }`. `quantity` is the number of larger packs (1 to 100,000).
- Rules: both pack types belong to the same product, `from.units_per_pack > to.units_per_pack`, and `from.units_per_pack` divides evenly by `to.units_per_pack` (otherwise `PACK_TYPES_NOT_CONVERTIBLE` or `CONVERSION_RATIO_INVALID`). Pieces added = `quantity * from.units / to.units`.
- Permission: the member has `stock.convert` (managers and owners; the existing rule that an attendant can never hold it stays), **or** the payload has a valid `approval_id`. If the member has the permission, any `approval_id` is ignored and not consumed. Neither: `PERMISSION_DENIED`. A bad approval: `APPROVAL_INVALID` (the same for missing, used, expired, another member's, another business's).
- One transaction: consume the approval (if used), strict decrease of the source pool, increase of the target pool, a `CONVERT_OUT` and a `CONVERT_IN` movement, one `stock_conversion` row with `approved_by`. If anything fails the whole thing, including the approval consumption, rolls back (the approval stays usable).
- Result: `{ from_after, to_after, units_added, approved_by_membership_id }`.

## 6. Approvals

- `GET /v1/stock/approvers` (permission `stock.view`): `[{ membership_id, display_name, role_preset }]` for active members, other than the caller, who currently have `stock.convert`. Names only.
- `POST /v1/stock/approvals` (permission `stock.view`) body `{ approver_membership_id, approver_pin, purpose: "STOCK_CONVERT" }`. Returns 201 `{ approval_id, valid_until }`.
  - The approver must be an active member with `stock.convert`, other than the caller. If the caller already has `stock.convert`: `422 APPROVAL_NOT_NEEDED`.
  - Every failure (wrong PIN, unknown approver, ineligible approver, suspended approver, locked approver) is the same `403 APPROVAL_DENIED`, same body, same amount of work (one scrypt call, outside any transaction), and a locked approver's PIN is not even checked, as for the PIN login lock (Phase A pattern, no oracle).
  - Approval counters are separate from login counters: five wrong attempts set `approval_locked_until` 15 minutes ahead (and write an `approval.locked` audit row); a correct PIN resets the count. This never touches `pin_failed_count`, `pin_locked_until`, or the approver's own login. Counter updates are single atomic statements.
  - Route rate limit: 10 requests per minute per IP, in addition to the global limit.
- **Use:** at command time, one atomic statement consumes the approval:
  `UPDATE approval SET consumed_at = $now, consumed_by_sync_command_id = $cmd WHERE id = $id AND purpose = 'STOCK_CONVERT' AND consumed_at IS NULL AND requester_membership_id = $me AND device_id = $device AND $occurred_at <= valid_until AND $occurred_at >= created_at - interval '5 minutes' AND $received_at <= created_at + interval '24 hours' RETURNING approver_membership_id`.
  Then, in the same transaction, re-check that the approver is still active and still has `stock.convert` (live), otherwise `APPROVAL_INVALID`. Time comes from the Clock.
- Notifications to the approver ("X used your PIN") arrive in Phase F. Record this as an open item.

## 7. Reads

Protected routes, any active member with `stock.view` (attendants have it), always limited to the caller's own business by RLS. No business parameter anywhere (`business_id` as a query parameter is `422`, as a header ignored, as in Phase B).

- `GET /v1/stock?location_id=&product_id=&include_zero=&include_archived=&limit=&cursor=`: balances `{ location_id, location_name, product_id, product_name, pack_type_id, pack_type_name, units_per_pack, quantity, updated_at }`. By default hides rows with quantity 0 and **shows negative ones**. Archived products hidden unless `include_archived=true`. Keyset paging on `(product name, pack_type_id, location_id)` with the signed cursor pattern from B4 (generalise `ProductCursor` instead of copying it). `limit` default 20, max 100.
- `GET /v1/stock/movements?location_id=&pack_type_id=&product_id=&type=&from=&to=&limit=&cursor=`: newest first by `(occurred_at, id)`. Row: `id, movement_type, quantity_change, quantity_after, occurred_at, reason, note, reference, expected_quantity, counted_quantity, location_id, pack_type_id, product_name, pack_type_name, created_by { membership_id, display_name }`. The `unit_cost` key is **absent** without `costs.view`. `limit` default 20, max 100.

## 8. Audit

`AuditService.record` in the same transaction, with the actor passed explicitly (commands run outside the request transaction). Actions: `stock.received` (location, lines of `{ pack_type_id, quantity }`, `with_cost: true/false`), `stock.adjusted` (pack type, change, after, reason), `stock.counted` (lines of `{ pack_type_id, expected, counted, delta }`), `stock.converted` (from, to, quantity, units added, approver, approval id), `approval.granted` (requester, approver, purpose), `approval.locked` (approver). Never record notes (free text), unit costs, PINs or the approval's use of any secret. If `AuditService` rejects a key name, add an exact exception like B2 did and tell Ian.

## 9. Housekeeping: error codes in logs

Error logs record Prisma and Postgres error codes as `errorCode` (for example `"23505"`), next to the error name. The redaction of the field name `code` stays in place (it protects one-time codes). Test: a failing database write logs `errorCode`, and a request containing a one-time `code` field still never shows its value in any log line.

## 10. Lessons from earlier phases that apply

- **Do not run any test while a migration waits for review.** Test runs apply pending migrations to `aberdare_test`. Show the SQL, get approval, apply, then test.
- The testing method is in `docs/phase-b-design.md` section 12 and applies here unchanged (see section 12 below).
- Hash and verify PINs before opening a transaction. No network calls in a transaction. No `Promise.all` on one transaction.
- Race tests must force the overlap (the faster test hasher can make a race disappear). Never widen an assertion to "either answer".
- Generated or hand-written objects need both a migration and the Prisma declaration where Prisma would otherwise drop them. Replay migrations in the shadow database and read the generated SQL.
- Verify every mutation revert (backups compared byte for byte, or a database function's md5 compared). Search for leftover mutation markers before the final suite.
- Run real-API checks against the test database so the dev database stays clean for Ian's walkthroughs.
- Commit after each passing step. Some files were "not in git yet" in earlier phases; that must not recur.

## 11. Mistakes AI tends to make here (do not)

- Reading a balance into JavaScript, checking it, then writing it. Or updating a balance without a movement, or a movement without the balance, or in different transactions.
- Editing or deleting movements, or adding a `CHECK (quantity >= 0)` on `stock_balance`.
- A count that sets the balance to the counted number, or compares to the server balance instead of the phone's expected number.
- Letting conversions touch two pools non-atomically, in the wrong lock order, or leave the approval consumed after a failed conversion.
- Storing, logging or auditing a PIN, or sharing the approver's login counters with the approval counters, or answering differently for a wrong PIN, a locked approver and an unknown approver.
- Letting an approval be reused, used by another member or device, used after the approver lost the permission, or used past its time limits.
- JavaScript numbers or floats for `unit_cost`, or changing `cost_price` on receive.
- Reporting only the first bad line of a delivery, or saving the good lines of a delivery that has a bad one.
- Building REST writes for stock, a sale decrement, transfers, reorder levels, suppliers or valuation.
- Putting notes, costs or names into audit metadata or logs.
- Hiding negative balances in reads, or returning `unit_cost: null` instead of omitting the key.
- Weakening a spike or earlier test to make the new code pass. Report and ask.

## 12. Build order, testing method, and done criteria

Each step ends with passing tests shown in the session and a commit. Present the schema or SQL for each step before applying it and run no test until it is approved.

**Testing method (Ian's):** during a step run only that step's new test files, once, until they pass; repeat only the concurrency and timing tests, 5 times in a row. To finish a step run the step's new tests plus all earlier Phase C test files once (report "new N, Phase C cumulative M"), then the full suite once in the background. At the end of the phase run the full suite 3 times in a row and write exactly how many runs were done and how many tests passed in each. Never write a number you did not observe.

- **C1: Schema, triggers, integrity check, housekeeping.** Section 3 and 9, doc updates (section 16).
- **C2: Receive, adjust, and reads.** Section 5 (receive, adjust) and section 7.
- **C3: Count.**
- **C4: Convert (managers and owners).**
- **C5: Approvals.** Section 6 and the approval path of convert.
- **C6: Hardening and handover.** Randomized workload, logs, audit coverage, grants inventory, walkthrough, results.

## 13. Test plan

All automated, real Docker database, injectable `Clock`, genuinely concurrent concurrency tests. Never weaken a test to make it pass.

**C1: schema, triggers, integrity**
1. The RLS coverage test passes with `approval` included. The exact inventories (RLS tables, triggers, functions, indexes) and the grants inventory list the new objects on purpose.
2. Database checks refuse: a movement type outside the list; wrong signs (negative `RECEIVE`, positive `CONVERT_OUT`, `DAMAGED` positive, `FOUND` negative); `unit_cost` on a non-`RECEIVE`; `reason` on a non-`ADJUST` or missing on `ADJUST`; a `COUNT` without `expected`/`counted` or with the wrong delta; a note over 200 or a reference over 60 characters. `app_user` still cannot UPDATE or DELETE a movement.
3. Composite keys: a movement's creator, command, a conversion's approver, and an approval's members must belong to the same business.
4. The `stock_balance` trigger writes `change_log` for insert and update, through both the strict update and the sale-mode upsert. A rolled-back change writes nothing.
5. The integrity check: consistent data returns nothing; a balance changed as the superuser, a balance with no movements, and movements with no balance are each reported; another business's data is never included.
6. The approval consumption statement: 20 concurrent consumes of one approval give exactly one row; `app_user` cannot update any other approval column.
7. `errorCode` appears in the log for a failing database write; a request with a one-time `code` still never shows it.
8. All earlier stock, sync and spike tests still pass (changed only mechanically).

**C2: receive, adjust, reads**
1. Receive writes one movement per line with type, `quantity_after`, `occurred_at`, creator and command id, updates balances, and returns the lines' `quantity_after`.
2. All or nothing: a delivery with several bad lines saves nothing and lists every bad line (1-based) with its reason. Duplicate lines, zero lines, 51 lines, quantity 0, negative, 1.5, over 1,000,000, and an archived pack type or location are rejected as specified.
3. A location or pack type of another business gives the same answer as one that does not exist.
4. Permissions: an attendant is `PERMISSION_DENIED` (the rest of the batch proceeds); a manager succeeds; `unit_cost` without `costs.view` is `PERMISSION_DENIED`, with the extra permission it is stored on the movement and `cost_price` is unchanged.
5. 20 concurrent receives of 5 on one pool give exactly +100 and ledger sum equals balance. The same command id sent 20 times applies once.
6. Adjust: each reason with the right and wrong sign; balance 10 and 50 concurrent adjusts of -1 give exactly 10 `ACCEPTED`, 40 `STOCK_INSUFFICIENT`, final 0; an attendant is denied.
7. Negative balances: from -3, a receive of 5 gives 2; an adjust of -1 from -3 is `STOCK_INSUFFICIENT`.
8. `GET /stock`: hides zero rows by default, shows negative rows, `include_zero`, filters, paging with a signed cursor (tampered is `422`), `business_id` parameter is `422`; identical names in two businesses never mix; no cost fields.
9. `GET /stock/movements`: filters, newest first, paging, `unit_cost` key absent without `costs.view`, creator display name present, another business's movements never visible; a suspended member is refused.
10. Audit rows for `stock.received` and `stock.adjusted` exist once each, in the same transaction; a forced failure after the audit insert leaves no audit row and no stock change; audit metadata contains no note and no cost.
11. Balance changes through commands appear in `change_log`.

**C3: count**
1. `delta = counted - expected` is applied; a zero-delta line writes no movement; movements store `expected_quantity` and `counted_quantity`.
2. Balance 10; the phone counts expected 10, counted 8; three sale-mode decreases are processed before the count command arrives. The final balance is 5, not 8.
3. Counts and sale-mode decreases running concurrently: final balance equals initial plus all sale deltas plus all count deltas, and ledger sum equals balance (5 runs).
4. A count that ends with a negative balance is `FLAGGED / NEGATIVE_AFTER_COUNT`, still saved.
5. All-or-nothing and the invalid-lines report work as for receive (including duplicates and over 50 lines).
6. An attendant is denied, a manager succeeds. Archived locations and pack types are allowed.
7. Audit `stock.counted`, `change_log`, tenant isolation as for receive.

**C4: convert (managers and owners)**
1. One carton of 24 converts to 24 pieces: one `CONVERT_OUT`, one `CONVERT_IN`, one `stock_conversion` row linking them, `approved_by` is the manager, both balances right.
2. Ratios: 24 to 1 works; 24 to 12 works (2 each); 10 to 4 is `CONVERSION_RATIO_INVALID`; different products, same pack type, and smaller to larger are `PACK_TYPES_NOT_CONVERTIBLE`; a result over 2,000,000,000 is `VALIDATION_FAILED`.
3. Strict source: with too few cartons the command is `STOCK_INSUFFICIENT` and nothing changes (the piece pool, ledger and conversion table are untouched).
4. 20 concurrent conversions of 1 carton against 5 cartons give exactly 5 successes, cartons 0, pieces +120, ledger sum equals balance for both pools. Run alongside concurrent sale-mode decreases on the piece pool, and with a case-to-carton and a carton-to-piece conversion running at the same time, with no deadlock and no timeout. Repeat 5 times.
5. An attendant without an approval is `PERMISSION_DENIED`; a manager and the owner succeed; granting an attendant `stock.convert` as an extra permission is still refused.
6. The same command id twice converts once.
7. Audit `stock.converted`, `change_log` for both balances.

**C5: approvals**
1. `GET /stock/approvers` lists only active members with an effective `stock.convert`, excluding the caller, names only.
2. Minting: the right PIN gives an approval. A wrong PIN, an unknown approver, an attendant as approver, a suspended approver, the caller themselves, and a locked approver all give the same `403 APPROVAL_DENIED` status, body and number of scrypt calls. A caller who already has `stock.convert` gets `422 APPROVAL_NOT_NEEDED`.
3. Counters: five wrong PINs lock approvals by that person for 15 minutes (move the clock); during the lock a correct PIN is also denied identically; their own PIN login still works throughout; the lock ends after the window; a success resets the count; 20 concurrent wrong guesses are counted exactly and cause one lock.
4. An attendant with a valid approval converts; `approved_by` is the approver and the approval is consumed. Reusing it is `APPROVAL_INVALID`. 20 concurrent commands using one approval give exactly one `ACCEPTED`.
5. Binding: an approval minted for member A fails for member B, and from another device; another business's approval id is `APPROVAL_INVALID`, identical to a missing one.
6. Time and state: `occurred_at` more than 15 minutes after creation, a command received more than 24 hours after creation, an approver who was suspended or lost the permission after minting, all give `APPROVAL_INVALID`.
7. A conversion rejected for `STOCK_INSUFFICIENT` leaves the approval unused and still valid.
8. A member who has `stock.convert` and sends an `approval_id`: it is ignored and not consumed.
9. No PIN or approval secret appears in logs or audit metadata. Audit rows `approval.granted`, `approval.locked` and `stock.converted` (with approver) exist. The endpoint rate limit returns 429 on a burst.

**C6: hardening**
1. Randomized mixed workload, reproducible: print the seed; 200 operations (receive, adjust, count, convert, sale-mode decrease) over 3 pack types in 2 businesses, run concurrently. At the end, every balance equals its ledger sum, strict operations never produced a negative balance, nothing crossed between businesses, and the integrity check is clean. Run it with at least three different seeds.
2. No log line from any Phase C request contains a product name, note, reference, unit cost, quantity detail beyond ids, PIN, or approval id.
3. Every audit action in section 8 is written once, in the same transaction as its change.
4. The grants inventory shows `stock_movement` and `stock_conversion` without UPDATE and DELETE, and the approval column grants.
5. The walkthrough in `docs/phase-c-walkthrough.md` runs end to end as a test and once against the built API on the test database.
6. The results file has no placeholders.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, then revert and verify the revert:
1. Commit the valid lines of a delivery that has a bad line: C2 test 2.
2. Replace the strict adjust with read-then-write: C2 test 6.
3. Make the count set the balance to the counted number: C3 test 2.
4. Remove the strict guard on the convert source: C4 test 3.
5. Remove `consumed_at IS NULL` from the approval consumption: C5 test 4.
6. Remove the requester and device binding on approvals: C5 test 5.
7. Accept `unit_cost` without `costs.view`: C2 test 4.
8. Remove the `stock_balance` change-log trigger: C1 test 4 and C2 test 11.
9. Share the approver's login counters with the approval counters: C5 test 3.

## 14. Manual walkthrough (for Ian)

At the end of C6, Claude Code writes `docs/phase-c-walkthrough.md` (curl) running this story against the local API with the fake senders and dev fixed codes:

1. Owner signs up, adds a manager and an attendant, and the manager creates "Maize flour 2kg" with a piece and a carton of 24. 2. The manager receives 10 cartons and 5 pieces in one delivery (with a reference); the attendant tries the same and is denied. 3. A delivery with two bad lines lists both. 4. The manager adjusts -1 piece as DAMAGED. 5. The attendant lists approvers, gets the manager's approval with the manager's PIN, and converts 1 carton to 24 pieces; the history shows who approved. 6. Reusing the approval fails. 7. The manager counts the pieces, with a sale happening in between, and the balance is right. 8. `GET /stock` and the movement history show everything; the attendant sees no cost. 9. A second business sees none of it.

Ian runs it and writes down anything that surprised him.

## 15. Results file

When C6 is finished, Claude Code writes `docs/phase-c-results.md` in the same style as `docs/phase-b-results.md`: status line (only Ian marks the phase done, in `CLAUDE.md` section 2), a summary table per step with "new" and "Phase C cumulative" test counts and workarounds, final patterns (the ledger-and-balance statements as built, the count rule, the conversion lock order, the approval consumption statement, the invalid-lines reporting), the mutation proofs, versions changed, things to know, open risks, changes to other docs, and the final suite results with every number filled in.

## 16. Doc updates to make in C1 (show Ian the diff before committing)

- `CLAUDE.md` section 2: the phase table row for C becomes "receive, adjust, count, convert, approvals, stock reads". Do not touch the status line.
- `docs/architecture.md`: section 5 (command payloads and results, the invalid-lines rule, `FLAGGED` for counts), section 6 (ledger columns, count rule, conversion lock order, approvals replace "PIN override on the attendant's phone"), section 12 (new columns and the `approval` table), section 13 (stock and approval endpoints), section 16 (open items below).

## 17. Open items

1. Transfers between locations (two movements and a lock order, like conversion).
2. Notifying the approver and the owner (Phase F): "your PIN was used", carton broken, flagged counts.
3. Scheduling the nightly integrity check per business (Phase F) and what to do with a mismatch.
4. Stock valuation and cost accounting (average or last cost) and reports of shrinkage and counts (Phase G).
5. Reorder levels and low-stock digest (Phase F).
6. Returns to suppliers as a real document (today they are `ADJUST` with `SUPPLIER_RETURN`).
7. Lots, serials and expiry dates (not planned).
8. The 50-line limit and the 15-minute approval window are defaults; measure and revisit.
9. An approval can be hoarded for 15 minutes of phone time. A phone with a wrong clock can stretch that; the server cap is 24 hours.
10. The approval mechanism is generic. Phase E decides whether voiding a sale reuses it.
