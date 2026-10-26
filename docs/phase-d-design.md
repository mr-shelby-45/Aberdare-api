# Phase D design: Sync reads (snapshot and changes)

Status: approved by Ian on 2026-10-26 (all six questions answered with the recommended defaults). This file is the source of truth for Phase D. Where it disagrees with `docs/architecture.md` (section 5, the overlap-window idea) or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 15). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md`, `docs/phase-a-results.md`, `docs/phase-b-results.md` and `docs/phase-c-results.md` (the "Final patterns" and "Things to know" of each). The patterns proven there are the way to do things. Do not invent new ones.

Do not start until Ian has marked Phase C done in `CLAUDE.md` section 2.

## 1. Goal and scope

A phone can download everything it needs to work offline (snapshot), and later ask "what changed since I last synced?" (changes). Nothing a phone needs is ever missed, even when transactions commit out of order. Cost fields never reach a member without `costs.view`.

Terms used in this file:
- **Cursor**: a signed bookmark the server gives the phone, meaning "you have everything up to here". The phone stores it and sends it back on the next call.
- **Snapshot**: the full copy of the business's data, delivered in pages. The phone stores it in its local database. The server never stores anything per phone.

In scope: `GET /v1/sync/snapshot`, `GET /v1/sync/changes`, a `change_log` migration for the transaction id, the 410 rule, a prune function (not scheduled), a `last_synced_at` stamp on the device, tests, walkthrough, results.

Devices: every access token carries a `device_id` and the request pipeline loads the device live, so a revoked or suspended device is already refused on every route. Phase D must prove this for the sync routes (tests below) and must not add per-device server state beyond `last_synced_at`. The cursor itself is not tied to a device: it is a position in the business's change log and lives on the phone. (A reinstall is a new device and takes a fresh snapshot anyway.)

Tables covered: `location`, `product`, `pack_type`, `product_barcode`, `stock_balance`. Sales and payments are added in Phase E, orders and subscription state later. Design the table list so adding a table later means adding one entry, not new machinery.

Out of scope (do not build): scheduling the prune (Phase F), push or WebSocket notification of changes (a later phase; phones poll), per-phone server state, delta compression, stock movement history in the snapshot (phones read history online with `GET /v1/stock/movements`), staff lists, audit data, sales.

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Missed changes | Each `change_log` row stores the id of its transaction. The server only returns rows from transactions that have finished, so there are no gaps and no overlap window. |
| Snapshot while writes happen | The first snapshot page returns a starting cursor taken before any data is read. After the snapshot the phone calls `changes` from that cursor, and anything that moved during the download is picked up. |
| Change contents | `changes` returns each row's current state read at request time, or a delete marker. Row copies are never stored in `change_log`. |
| Too old or different view | A cursor older than the retained history, or issued under a different cost visibility, gets `410 SNAPSHOT_REQUIRED`. |
| Page sizes | Snapshot 500 rows per page. Changes default 200, max 500, with `has_more`. |
| Who | Any active member on an active device with a valid token; content depends on their permissions. |
| Device freshness | `snapshot` and `changes` stamp `last_synced_at` on the calling device, at most once every 5 minutes. Used later to show the owner which phones are stale. |

## 3. Data model

Same rules as before. Claude Code proposes the exact SQL and waits for approval before applying. Check the existing `change_log` table, its triggers and `log_product_change()` first, and change only what is listed here.

- `change_log` gains `txid xid8 not null default pg_current_xact_id()`. Existing rows (test and dev data only) get a value by the default-then-drop-default approach or by clearing local data with Ian's approval. Check the real table definition and the trigger function, and keep them consistent (the trigger must keep working for all covered tables, including deletes).
- An index supporting `(business_id, txid, id)` ordering.
- `app_user` keeps only the grants it has; the prune function is the only thing that deletes `change_log` rows, and it is a `SECURITY DEFINER`-style function or a migrator-only operation (choose the smaller privilege change and show Ian). Add it to the exact inventories in `test/step4-migrations.spec.ts` and `test/b5-hardening.spec.ts`.
- Retention: 30 days. A constant in config, not hard-coded in SQL.
- The device table (check its real name and columns first) gains `last_synced_at timestamptz null`. `app_user` gets UPDATE on that column only (add to the grants inventory). The stamp is one atomic statement using the Clock, of the form `UPDATE device SET last_synced_at = $now WHERE id = $device AND (last_synced_at IS NULL OR last_synced_at < $now - interval '5 minutes')`. It runs inside the request's tenant transaction, after the data is read. Zero rows updated is normal and not an error. It writes no `change_log` row and no audit row (check that the device table's existing triggers do not log it; if one would, exclude this column and tell Ian). Do not expose it in any endpoint in Phase D.

## 4. The cursor

- Signed with the existing `SignedCursor` helper (generalise, do not copy). Contents: the business id (so a cursor from one business is refused by another with `422 VALIDATION_FAILED`, the same answer as a tampered one), the last position returned `(txid, id)`, and `costs` (true or false: whether the member could see cost fields when it was issued). Opaque to the phone.
- A tampered, malformed or unsigned cursor: `422 VALIDATION_FAILED`, as for other cursors.
- Position order is `(txid, id)`. Use `txid` as the primary order; `id` breaks ties inside one transaction. Never order by `created_at` (rows in one transaction share it).
- **Finished transactions only.** A query returns only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())`, so a row from a transaction that is still open, or that started before another open one, is never returned until it is safe. Show Ian the exact query. Write and keep a comment explaining why this removes the gap problem.
- Retained history: the oldest allowed cursor is the oldest retained `change_log` position. A cursor older than that gets `410 SNAPSHOT_REQUIRED`. Also `410` when `costs` in the cursor differs from the member's current `costs.view` (either direction).
- A brand new business with no changes: the starting cursor is still valid and `changes` returns an empty list.

## 5. GET /v1/sync/snapshot

`GET /v1/sync/snapshot?table=&cursor=&limit=` (limit default 500, max 500). Protected, any active member. The phone fetches the tables one after another.

- Without `cursor` it starts the snapshot: the response includes `start_cursor` (the changes cursor, taken inside the same request before reading any rows, from the transaction's own snapshot position) and the first page of the first table.
- Response: `{ table, rows: [...], next_cursor | null, next_table | null, start_cursor? }`. `start_cursor` is returned on the first page only; the phone keeps it. `next_cursor` pages inside one table with the signed cursor (keyset by `id`); when a table is finished `next_table` names the next one. After the last table both are null.
- Table order is fixed: `location`, `product`, `pack_type`, `product_barcode`, `stock_balance` (parents before children).
- Rows use the same shapes as the Phase B and C reads (`product-view.ts` style; snake_case, money as strings). `cost_price` is absent without `costs.view`. `stock_balance` rows need `stock.view`; without it the table is returned empty, not an error. Archived products and pack types are included (flagged `archived_at`) so old references resolve on the phone.
- The snapshot is a sequence of ordinary requests, each in its own tenant transaction. It is not one big transaction.

## 6. GET /v1/sync/changes

`GET /v1/sync/changes?cursor=&limit=` (cursor required; limit default 200, max 500).

- Response: `{ changes: [...], next_cursor, has_more }`. `next_cursor` is always returned, also when the list is empty (it may equal the one sent). The phone replaces its stored cursor with `next_cursor` only after it has applied the whole page.
- Each change: `{ table, op: "upsert" | "delete", id, row? }` (`row` for upsert; for `delete` the key identifying the row, which for barcodes carries enough to identify the barcode, as Phase B recorded). Several log rows for one record in the page collapse into one change (the latest state wins), so the phone applies each record once.
- The row is the current state read now, with the same shapes and permission filtering as the snapshot (`cost_price` absent without `costs.view`; `stock_balance` changes omitted without `stock.view`). If the record no longer exists, the change is a delete. If the log says upsert but the row has since been archived, it is still an upsert (archived is a state, not a delete).
- Changes from tables the member cannot see are skipped, and the cursor still moves past them.
- Idempotent and repeatable: the same cursor always returns the same data plus anything newer. Phones may call it twice.
- Ordering of the final list follows `(txid, id)`; a phone that applies changes in order never sees a child before its parent for rows created in the same transaction.

## 7. Prune function

`pruneChangeLog()` removes `change_log` rows older than the retention period for the whole database (or per business: choose the simpler, show Ian). Nothing calls it yet (Phase F). It must never remove a row newer than the retention period, and it must never make a still-valid cursor unsafe: after pruning, the oldest allowed position moves forward, and the 410 rule then applies to cursors older than it. Store the "oldest retained position" so the rule is a simple comparison (a small table or derived from the remaining rows; show Ian the choice).

## 8. Lessons from earlier phases that apply

- Do not run any test while a migration waits for review.
- The testing method is in `docs/phase-b-design.md` section 12 (new tests during a step; concurrency tests 5 times; gate with earlier Phase D files once; full suite once in the background; end of phase 3 runs in a row with real numbers).
- Rows written in one transaction share `created_at`. Order by `(txid, id)` only.
- Race tests must force the overlap: use a held-open transaction, not luck.
- Generated and hand-written objects both need a migration and, where Prisma would drop them, the Prisma declaration. Read generated SQL.
- Verify every mutation revert byte for byte. Search for leftover mutation markers before the final suite.
- Commit after each passing step, and check `git status` is clean.
- No weakening of earlier tests. Report and ask.

## 9. Mistakes AI tends to make here (do not)

- Ordering by `id` alone or `created_at`, which re-creates the missed-change gap.
- Returning rows from a transaction that has not finished, or filtering by time instead of by transaction id.
- Storing row copies in `change_log` (leaks costs, goes stale).
- Returning cost fields to members without `costs.view`, including inside the cursor-bound paths and in delete markers.
- Letting a snapshot run as one long transaction or hold locks.
- Taking `start_cursor` after reading the first rows instead of before.
- Putting `business_id` in a query parameter or response key the phone must send back. The tenant comes from the token only.
- Per-phone server state (last synced tables, device cursors). The cursor lives on the phone. The only per-device value is `last_synced_at`.
- Writing `last_synced_at` on every poll (write storm), or logging that update as a change or audit event.
- Skipping the device check because "sync is just a read", or tying the cursor to a device id.
- Scheduling the prune, or deleting `change_log` from application code outside the prune function.
- Building push, WebSocket, sales or staff sync.
- Writing a cursor format that does not bind `costs`, so a promoted manager keeps stale data.

## 10. Build order

Each step ends with passing tests shown in the session and a commit. Show SQL before applying it.

- **D1: Migration, cursor, prune function.** Section 3, 4 (cursor helper and the finished-transactions query as a tested service method), 7.
- **D2: Snapshot.** Section 5.
- **D3: Changes.** Section 6.
- **D4: Hardening and handover.** Randomized sync check, logs, grants, walkthrough (`docs/phase-d-walkthrough.md`), results (`docs/phase-d-results.md`).

## 11. Test plan

Real Docker database, injectable `Clock`, genuinely concurrent concurrency tests. Never weaken a test.

**D1**
1. Inventories (tables, triggers, functions, indexes) and the grants inventory list the new objects on purpose. `app_user` cannot update or delete `change_log` directly.
2. The `txid` is set on every `change_log` row, for insert, update and delete, on every covered table, including through the stock strict update and the sale-mode upsert.
3. **Gap test.** Open transaction T1 and make a change (not committed). Commit T2 (later, higher id). The finished-transactions query returns neither. Commit T1: now both are returned, in `(txid, id)` order, and a phone using the cursor from before sees both exactly once. Repeat 5 times.
4. A rolled-back transaction leaves no `change_log` row.
5. Cursor: tampered, unsigned, malformed are `422`; a cursor issued to business A used by business B is `422`, identical to a tampered one; one issued with `costs: true` fails the check when the member lacks `costs.view`, and the other way round.
5a. Device stamp: the first sync call sets `last_synced_at`; a second call within 5 minutes (move the Clock) does not change it; after 5 minutes it does; 20 concurrent calls leave one valid value and no error; it writes no `change_log` or audit row; `app_user` can update no other device column.
6. Prune: rows older than 30 days (by the Clock) go, newer stay; after pruning, a cursor older than the oldest retained position is rejected; one at or after it is accepted; pruning leaves other businesses' newer rows untouched.

**D2**
1. A new member of a business with products, pack types, barcodes, locations and balances downloads the whole snapshot in pages (use a small `limit`) and gets every row exactly once, in table order, with the same shapes as the Phase B and C reads.
2. `start_cursor` is only on the first page, and a change made during the download is delivered by `changes` from it, none lost, none required twice (apply with dedupe by id).
3. `cost_price` absent without `costs.view`, present with it; `stock_balance` empty without `stock.view`.
4. Archived rows included with `archived_at`.
5. Another business's rows are never visible; identical names never mix; `business_id` as a query parameter is `422`, as a header ignored.
6. A tampered page cursor is `422`; a cursor for table A used with `table=B` is `422`.
7. A suspended member, a revoked or suspended device, and a request without a token are refused. A device revoked between two snapshot pages: the second page is refused.
8. The first page of a snapshot stamps `last_synced_at` on the calling device and not on another device of the same business.

**D3**
1. After the snapshot, each kind of change (new product, edit, archive, barcode add and remove, location change, stock receive, adjust, count, convert, sale-mode decrease) appears once in `changes`, as upsert or delete, with current state.
2. Several changes to one record in a page collapse to one change with the latest state.
3. Pages: `limit` respected, `has_more` right, following `next_cursor` to the end delivers everything exactly once; an empty result still returns a valid `next_cursor`.
4. Permissions: an attendant never receives `cost_price` or a cost-bearing delete marker; a manager who gains `costs.view` gets `410 SNAPSHOT_REQUIRED` on the next call and recovers by a snapshot; the same in the other direction.
5. A cursor older than the retained history is `410 SNAPSHOT_REQUIRED`.
6. A change to a record that was deleted before the request is returned as a delete.
7. Tenant isolation: another business's changes never appear and never move a cursor.
9. A revoked or suspended device is refused on `changes`, with its valid cursor; a different, active device of the same member can use the same cursor value (the cursor is not tied to a device).
8. **Out-of-order commit.** With a held-open transaction as in D1 test 3, a phone polling `changes` while transactions commit out of order ends with every change, none skipped (5 runs).

**D4**
1. Randomized: a seeded run of 150 mixed operations (catalogue edits, stock commands, archive, barcode add and remove) in two businesses while a simulated phone alternates snapshot, changes and random pauses. At the end the phone's rebuilt local copy equals a fresh snapshot, row for row, for both businesses, for three seeds. Print the seed; allow replay with an environment variable.
2. Logs: no product name, barcode, cost, cursor value or row content in any Phase D log line.
3. The walkthrough (`docs/phase-d-walkthrough.md`) runs as a test and once against the built API on the test database.
4. The results file has no placeholders.

**Proof the tests catch mistakes** (apply each temporarily, show the named test failing, revert, verify the revert):
1. Order and filter by `id` only, without the finished-transactions condition: D1 test 3 and D3 test 8.
2. Take `start_cursor` after the first rows are read: D2 test 2.
3. Return `cost_price` without `costs.view` in `changes`: D3 test 4.
4. Do not bind `costs` into the cursor: D3 test 4.
5. Prune deletes rows inside the retention window: D1 test 6.
6. Return a row copy stored at log time instead of the current state: D3 tests 1 and 6.
7. Remove the business filter protection (run a read outside the tenant transaction): the tenant isolation tests.
8. Skip the device check on the sync routes (for example by marking them public or skipping the live device load): D2 test 7 and D3 test 9.
9. Stamp `last_synced_at` on every call without the 5 minute condition: D1 test 5a.
10. Leave the business id out of the signed cursor: D1 test 5.

## 12. Manual walkthrough (for Ian)

`docs/phase-d-walkthrough.md` (curl), run against the local API:

1. A manager creates products, a carton and a piece pack, a barcode, and receives stock. 2. A new attendant downloads the snapshot page by page and keeps the starting cursor; no cost shown. 3. The manager edits a price, adds a barcode, converts a carton. 4. The attendant calls `changes` with the saved cursor and receives exactly those changes; calling it again with the new cursor returns nothing. 5. The manager is given `costs.view`; the attendant's old cursor still works, but a manager's old cursor gets 410 and a fresh snapshot shows costs. 6. A second business sees none of it.

Ian runs it and writes down anything that surprised him.

## 13. Results file

When D4 is finished Claude Code writes `docs/phase-d-results.md` in the style of `docs/phase-c-results.md`: status line (only Ian marks the phase done), summary table per step with "new" and "Phase D cumulative" test counts, final patterns (the finished-transactions query as built, the cursor contents, the snapshot start cursor, the prune function), the mutation proofs, versions, things to know, open risks, changes to other docs, and the final suite results with every number filled in (3 runs in a row).

## 14. Doc updates to make in D1 (show Ian the diff before committing)

- `CLAUDE.md` section 2: phase table row for D becomes "snapshot and changes reads". Do not touch the status line.
- `docs/architecture.md`: section 5 (replace the overlap-window description with the finished-transactions rule, describe cursor and 410), section 12 (`change_log.txid`), section 13 (the two endpoints), section 16 (open items below).

## 15. Open items

1. Pushing "something changed" to phones (a later phase; phones poll for now).
2. Scheduling the prune and watching `change_log` size (Phase F).
3. Idle-in-transaction connections delay what `changes` can return. Add a database idle-in-transaction timeout in Phase H and measure.
4. Stock movement history is online-only. Decide in the mobile phase whether phones need a local copy.
5. Sales, orders and subscription state join the snapshot in later phases (one entry in the table list each).
6. Showing `last_synced_at` to the owner (devices list endpoint) and warning about stale phones: Phase F or G.
7. Snapshot size for a very large catalogue (tens of thousands of products) on a slow connection: measure with the Flutter app, then consider compression.
