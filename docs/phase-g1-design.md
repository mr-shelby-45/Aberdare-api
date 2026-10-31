# Phase G1 design: Reports

Status: approved by Ian on 2026-11-01 (all six questions answered with the recommended defaults). This file is the source of truth for Phase G1. Where it disagrees with `docs/architecture.md` (the planned `/reports/*` line in section 13) or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 14). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md` and the results files of Phases A to F (the "Final patterns" and "Things to know" of each). The patterns proven there are the way to do things. Do not invent new ones.

Do not start until Ian has marked Phase F done in `CLAUDE.md` section 2.

Phase G has three parts: G1 reports (this file), G2 subscriptions and G3 orders from a website (separate designs later). Nothing in G1 depends on how shops pay for the subscription.

## 1. Goal and scope

Owners and managers can see how the business is doing: sales, profit, stock, shrinkage, exceptions, money owed, and how each field attendant did. Attendants can see their own day. Everything is computed live from the existing tables, in Africa/Nairobi days, with exact decimals. Reports are online only.

The numbers are money. A report that is quietly wrong is worse than no report. The tests compare every report with hand-calculated values and with the other endpoints.

In scope: a `ReportsModule` with the endpoints in section 5, CSV exports of two reports, read indexes if the queries need them, a statement timeout and a rate limit for report routes, audit rows for exports.

Out of scope (do not build): pre-computed or cached summaries, a read replica, scheduled or emailed reports, charts, period-over-period comparison, Excel (`.xlsx`) files, categories (none exist), customer reports (no customers exist), tax or eTIMS reports, a per-business timezone setting, reports synced to phones through `snapshot` and `changes`, subscription or order reports (G2, G3), M-Pesa verification (Phase M).

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Order of Phase G | G1 reports, then G2 subscriptions, then G3 orders from a website. |
| Reports | Sales, top products, profit, stock on hand, shrinkage, exceptions (voids and below-list prices), receivables (unpaid sales and unverified M-Pesa), field attendants, and "my day". |
| Computation | Live queries with proper indexes. No pre-aggregation. Date range capped at 92 days. |
| Days | Africa/Nairobi calendar days. Sales are placed by `occurred_at`. Voided sales are excluded except in the exceptions report. |
| Visibility | `reports.view` for all reports; profit, costs and valuations also need `costs.view`; "my day" needs only `sales.create`. |
| Export | CSV for the sales and stock reports, capped at 50,000 rows. |

## 3. Data used (no new tables)

Read only: `sale`, `sale_item` (names, `quantity`, `unit_price`, `list_price`, `cost_price`, `line_total` as stored at sale time), `payment`, `stock_movement`, `stock_balance`, `stock_conversion` (not needed), `field_settlement`, `field_settlement_line`, `membership` (display names, through the staff service), `location`, `product`, `pack_type` (`units_per_pack` is immutable once a pack type has movements, so the current value is safe to join).

**Module rule exception (to be shown to Ian and approved before building):** `ReportsRepository` runs read-only `SELECT` statements across these tables in one place, through the current tenant transaction (`currentTx()`), so RLS applies to every query. Going through six services for each aggregate would be slow and obscure. This is the same kind of narrow exception as the Phase C stock reads. Record it in `CLAUDE.md` section 4 and `architecture.md`. Writes are impossible: the module never calls a write method, and a test confirms `app_user` grants are unchanged. Display names come from `StaffService.displayNames()` as in Phase E, not from a join on `membership`.

## 4. Rules for every report

- **Money** is `NUMERIC(14,2)` summed in SQL and returned as a string (`::text`). Never a JavaScript number in a calculation. Counts are integers.
- **Dates.** `from` and `to` are `YYYY-MM-DD`, inclusive Africa/Nairobi days, both required. The query range is `[from 00:00 Nairobi, to + 1 day 00:00 Nairobi)`, converted to timestamps, so a sale at 23:59:59 Nairobi belongs to its own day and one at 00:00:00 to the next. Grouping by day uses the Nairobi date. A range of more than 92 days, `from` after `to`, or an invalid date is `422 VALIDATION_FAILED` (`RANGE_TOO_LARGE` for the cap). Kenya has no daylight saving; write that in a comment.
- **What counts.** Sales with `status = 'COMPLETED'`, placed by `occurred_at`. Payments: `RECORDED` ones, of completed sales. Voided sales appear only in the exceptions report.
- **Visibility.** Absent permission is `403 PERMISSION_DENIED`. A member with `reports.view` but without `costs.view` gets every report without cost fields (the key is absent, not null), except the profit report which is refused. A suspended member and a revoked device are refused by the pipeline as before.
- **Business scope.** Always the caller's business by RLS. `business_id` in a query is `422`, in a header ignored.
- **Limits.** Each report runs inside `SET LOCAL statement_timeout` of 8 seconds (a constant in `AppConfig`); a timeout is `503 REPORT_TOO_SLOW`, not a 500. A long report holds back `changes` for every shop while it runs (the finished-transactions rule), so the timeout is a safety rule, not a nicety. Report routes have their own rate limit of 30 requests a minute per member, on top of the global one.
- **Paging.** List-type reports use the shared `SignedCursor` (bound to the filters), `limit` default 20, max 100. Aggregate reports return all their rows (bounded by the 92 days and the grouping).
- **Logs and audit.** No names, amounts, codes or row content in logs. Exports write one audit row each (section 6).
- Reports are not synced to phones.

## 5. Endpoints

All `GET`, protected, any active member on an active device with the permission shown. Names are examples; keep them consistent with the existing REST style (snake_case, `data` shapes as in earlier phases).

**`/v1/reports/sales`** (`reports.view`): `from`, `to`, optional `group_by` = `day` (default), `attendant`, `location`; optional `location_id`, `attendant_id`.
- Response: `{ range, totals, rows, payments }`. `totals`: `sale_count`, `total`, `paid_total`, `balance_due`. Each `rows` entry: the group key (date, attendant id and display name, or location id and name), `sale_count`, `total`, `paid_total`, `balance_due`. `payments`: recorded amounts by method: `cash`, `mpesa_unverified`, `mpesa_verified` (zero until Phase M). Payments are grouped by the sale's day under the same filters.

**`/v1/reports/top-products`** (`reports.view`): `from`, `to`, `by` = `quantity` (default) or `value`, `limit` (default 10, max 50), optional `location_id`.
- Rows per product: product id and name (as stored on the sale line), `pieces` (sum of `quantity * units_per_pack`), `value` (sum of `line_total`). Ordered by the chosen measure, ties by product name then id.

**`/v1/reports/profit`** (`reports.view` and `costs.view`): `from`, `to`, `group_by` = `day` (default), `product`, `attendant`.
- `profit = sum(line_total) - sum(cost_price * quantity)` over lines that have a cost. Lines with no recorded cost are **not** treated as zero cost: they are reported separately as `lines_without_cost` and `revenue_without_cost`, and excluded from the profit figure. Rows: group key, `revenue` (lines with a cost), `cost`, `profit`, plus the two `without_cost` figures at the top level.

**`/v1/reports/stock`** (`reports.view`): optional `location_id`, `include_zero`, `group_by` = `product` (default) or `location`.
- Quantity on hand per group from `stock_balance` (negative balances are shown and counted in `negative_pools`). With `costs.view` only: `value_at_cost` (quantity times the pack type's current `cost_price`, positive balances only) and `pools_without_cost`. The quantity must equal `GET /v1/stock` for the same filters.

**`/v1/reports/shrinkage`** (`reports.view`): `from`, `to`, `group_by` = `reason` (default), `person`, `location`, `product`.
- Counts movements that lose or recover stock: `ADJUST` with reason `LOST`, `DAMAGED`, `EXPIRED` (negative) and `FOUND` (positive); `COUNT` variances; settlement adjustments (`ADJUST` with `settlement_id`). `SUPPLIER_RETURN` is not shrinkage and is excluded. Each row: group key, `units_lost`, `units_found`, `net_units`, and with `costs.view` `value_at_cost` (units times the current cost). `person` means the settlement's attendant for settlement adjustments, otherwise the member who recorded the movement. Quantities are in pieces of the movement's own pack type; do not mix pack types silently: group `product` rolls pack types up in pieces (`quantity * units_per_pack`) and says so.

**`/v1/reports/exceptions`** (`reports.view`): `from`, `to`, `type` = `voids` or `below_list`, paged.
- `voids`: sale number, sale time, voided time, total, reason, who voided, who approved. Voided sales within the range by `voided_at`.
- `below_list`: for completed sales, lines where `unit_price < list_price`: sale number, time, attendant, product, quantity, `unit_price`, `list_price`, `difference` (`(list_price - unit_price) * quantity`). No cost fields.

**`/v1/reports/receivables`** (`reports.view`): `type` = `unpaid` or `unverified_mpesa`, paged, optional `from`, `to`.
- `unpaid`: completed sales with `balance_due > 0`: sale number, time, attendant, total, `balance_due`, `age_days` (Nairobi days since the sale), with totals.
- `unverified_mpesa`: recorded M-Pesa payments with `verified = false`: sale number, time, amount, code, attendant, `duplicate` flag. The code is shown to authorised members but never logged.

**`/v1/reports/field`** (`reports.view`): `from`, `to`, optional `attendant_id`.
- From settlements whose `period_end` falls in the range: per attendant, settlement count, `expected_cash`, `cash_received`, `cash_variance` (sum), `mpesa_unverified_total`, `unpaid_total`, `shortage_units` (sum of negative line variances) and `surplus_units`, and with `costs.view` `shortage_value_at_cost`.

**`/v1/reports/my-day`** (`sales.create`; attendants and field attendants included): optional `date` (a Nairobi day within the last 7 days, default today).
- Only the caller's own sales: `sale_count`, `total`, `paid_total`, `balance_due`, `voided_count`, and recorded payments by method. No other member's data, no costs.

**CSV exports** (`reports.view`):
- `/v1/reports/sales/export.csv`: `from`, `to`, optional `location_id`, `attendant_id`; one row per completed sale (sale number, date and time in Nairobi, location, attendant, total, paid, balance due).
- `/v1/reports/stock/export.csv`: optional `location_id`; one row per pool (product, pack type, location, quantity, and with `costs.view` current cost and value).
- Rules: UTF-8 with a byte-order mark, a header row, `text/csv`, a fixed filename built from the report name and dates only (never user text). Cells that start with `=`, `+`, `-`, `@`, tab or carriage return are neutralised by a leading apostrophe (spreadsheet formula injection). More than 50,000 rows is `422 EXPORT_TOO_LARGE`, with the response saying to narrow the range. Cost columns are absent without `costs.view`. Memory use must be bounded.

## 6. Audit

`AuditService.record` in the same transaction: `report.exported` (report name, range, row count, `with_costs: true/false`). Never the filters' free text, names, amounts or codes. No audit row for ordinary report reads.

## 7. Indexes

Check every report with `EXPLAIN` on realistic generated data (at least 50,000 sales over 90 days, with items and payments) before building the next one. Existing indexes: `sale (business_id, occurred_at DESC, id DESC)`, the sale owner index, `stock_movement (business_id, occurred_at DESC, id DESC)`, the settlement `period_end` index. Propose new indexes (for example `sale_item (business_id, sale_id)` if missing, `payment (business_id, sale_id)`, partial indexes for unverified payments and unpaid sales) through migrations shown to Ian, and only where a query needs them. Report the measured times in the results file.

## 8. Lessons from earlier phases that apply

- Do not run any test while a migration waits for review.
- Testing method as in `docs/phase-b-design.md` section 12 (new tests during a step; concurrency tests 5 times; gate with earlier Phase G1 files once; full suite once in the background; end of phase 3 runs in a row with real numbers).
- Rows written in one transaction share `created_at`; order through ids.
- Generated and hand-written objects need a migration and, where Prisma would drop them, the Prisma declaration. Do not run `prisma format` on the whole schema.
- Verify every mutation revert byte for byte. Search for leftover mutation markers before the final suite.
- Auth routes are rate limited per IP; tests use their own IP and phone range.
- Commit after each passing step and check `git status` is clean.
- Never weaken an earlier test. Report and ask.

## 9. Mistakes AI tends to make here (do not)

- Summing money with JavaScript numbers, or rounding per row instead of in SQL.
- Grouping or filtering by the UTC date, or by `received_at`, instead of the Nairobi day of `occurred_at`.
- Counting voided sales, reversed payments or duplicate-marked payments wrongly.
- Treating a missing cost as zero profit cost.
- Returning cost, value or profit fields to members without `costs.view` (also in CSV columns, in group keys, in error messages).
- A report whose totals disagree with the list endpoints (`/v1/sales`, `/v1/stock`). Tests must cross-check.
- Pooling pack types of different sizes as if they were the same unit.
- Letting a report query run without a statement timeout, or loading 50,000 rows into memory several times.
- Leaving CSV cells unescaped, or putting user text in a file name.
- Logging amounts, names, codes or row content.
- Building caches, pre-aggregation tables, scheduled reports, charts or an `.xlsx` writer "while here".
- Installing a library without asking (CSV is plain text; no library is needed).
- Showing other members' data in "my day".

## 10. Build order

Each step ends with passing tests shown in the session and a commit. Present any migration before applying it and run no test until approved.

- **G1a: Foundation, sales report, my day.** The module and its exception, date handling, the permission and cost rules, timeout, rate limit, `/reports/sales`, `/reports/my-day`, the doc updates in section 14.
- **G1b: Top products and profit.**
- **G1c: Stock and shrinkage.**
- **G1d: Exceptions, receivables and field attendants.**
- **G1e: CSV exports and audit.**
- **G1f: Hardening and handover.** Randomized cross-check, logs, grants, performance numbers, walkthrough (`docs/phase-g1-walkthrough.md`), results (`docs/phase-g1-results.md`).

## 11. Test plan

Real Docker database, injectable `Clock`. Every report is tested against a fixed fixture with hand-calculated expected values written in the test as literals (not recomputed with the same query). Never weaken a test.

**G1a**
1. Date rules: a sale at 23:59:59 Nairobi and one at 00:00:00 the next day land in different days (UTC 20:59:59 and 21:00:00); inclusive `to`; `from` after `to`, a bad date, a missing date and 93 days are `422` (`RANGE_TOO_LARGE` for the cap); 92 days works.
2. `/reports/sales` on the fixture (three attendants, two locations, cash, M-Pesa, split and unpaid sales with cents such as 33.33 and 19.99, a voided sale, a reversed payment): `totals`, every `group_by`, the filters, and the `payments` split equal the literals. Voided sales are excluded.
3. Cross-check: the report's `sale_count` and `total` equal the sum from paging `GET /v1/sales` over the same range as a manager.
4. Exactness: many small amounts sum exactly (for example 1,000 sales of 0.10 give 100.00 with no floating point drift).
5. Permissions: an attendant, a field attendant and a member without `reports.view` are `403`; a manager and an owner succeed; a suspended member and a revoked device are refused; `business_id` in the query is `422`.
6. Tenant isolation: identical data in two businesses never mixes; each sees only its own.
7. `/reports/my-day`: only the caller's own sales for the day, completed and voided counts, no other member's data, `date` outside the last 7 days is `422`, a field attendant works the same; the timeout and rate limit apply (a slow query test returns `503 REPORT_TOO_SLOW`; a burst returns `429`).
8. Earlier suites pass (changed only mechanically).

**G1b**
1. Top products by quantity and by value on the fixture equal the literals, including `pieces` for a carton of 24 and a piece, ties ordered as specified, `limit` rules.
2. Profit on the fixture equals the literals; lines without a cost are excluded from `profit` and reported in the two `without_cost` figures; the identity `revenue - cost = profit` holds in every row.
3. A manager without `costs.view` gets `403` on profit and no cost keys in top products; an owner sees everything.
4. Voided sales and reversed payments never enter these reports.
5. Tenant isolation as before.

**G1c**
1. `/reports/stock` quantities equal `GET /v1/stock` for the same filters (cross-check, including negative balances and `include_zero`); `value_at_cost` appears only with `costs.view` and equals the literal; pools without a cost are counted, not valued.
2. Shrinkage on the fixture: each reason, count variances, settlement adjustments attributed to the attendant (not the closer), `SUPPLIER_RETURN` excluded, `FOUND` as a gain, `group_by` person, location and product (pieces rolled up), and the cost value only with `costs.view`.
3. The date range applies to the movements' `occurred_at` in Nairobi days.
4. Tenant isolation; attendants are `403`.

**G1d**
1. Exceptions: voids list the voided sale, the voider and the approver (when an approval was used); below-list lines show the difference; paging with a signed cursor (tampered is `422`); filters; no cost keys anywhere.
2. Receivables: unpaid sales with `balance_due` and `age_days` in Nairobi days; unverified M-Pesa with the code shown to a manager and the `duplicate` flag; verified or reversed payments excluded; totals right.
3. Field report on a fixture with two settlements: sums match the settlement rows; shortage and surplus units match the line variances; settlements outside the range are excluded; `shortage_value_at_cost` only with `costs.view`.
4. Tenant isolation; permissions as before.

**G1e**
1. The sales CSV equals the sales report for the same range (row count and total); header, byte-order mark and `text/csv` are present; money in plain decimals; times in Nairobi.
2. Formula injection: a product, attendant or location name starting with `=`, `+`, `-`, `@`, tab or carriage return is exported neutralised.
3. The stock CSV has cost columns only with `costs.view`; the file name contains only the report name and dates.
4. 50,001 rows is `422 EXPORT_TOO_LARGE`; 50,000 works; memory stays bounded (the export does not build the full list several times).
5. Each export writes one `report.exported` audit row in the same transaction, with no names, amounts or filters' text; a forced failure after the audit insert leaves no audit row.
6. Permissions and tenant isolation.

**G1f**
1. Randomized, seeded and replayable (`G1_SEED`): two businesses, 200 operations (sales with all payment shapes, voids, receives, adjustments, counts, field issues, returns and settlements) through the real API. At the end every report is compared with a straightforward independent calculation written in the test from the raw data (not the report's SQL), for three seeds. Cross-checks: sales report equals the list endpoints; stock report equals `GET /v1/stock`; profit identity; CSV equals report.
2. Performance: with 50,000 sales over 90 days in one business, each report is measured; each stays under the 8 second limit; the numbers go into the results file. If one does not, add the right index or stop and report.
3. Logs: marker names, codes and amounts in the data; no marker, amount or code appears in any log line.
4. The grants inventory is unchanged (the module reads only).
5. The walkthrough runs as a test and once against the built API on the test database.
6. The results file has no placeholders.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, revert and verify the revert:
1. Group by the UTC date: G1a test 1.
2. Include voided sales: G1a test 2.
3. Floating point sums in JavaScript: G1a test 4.
4. Show cost keys without `costs.view` in the stock report: G1c test 1, and in top products: G1b test 3.
5. Treat a missing cost as zero: G1b test 2.
6. Attribute settlement shrinkage to the closer instead of the attendant: G1c test 2.
7. Count `SUPPLIER_RETURN` as shrinkage: G1c test 2.
8. Remove the statement timeout: G1a test 7.
9. Remove the CSV neutralising: G1e test 2.
10. "My day" without the caller filter: G1a test 7.
11. Pieces computed without `units_per_pack`: G1b test 1.
12. Drop the range cap: G1a test 1.

## 12. Manual walkthrough (for Ian)

At the end of G1f, Claude Code writes `docs/phase-g1-walkthrough.md` (curl) running this story against the local API:

1. The owner, a manager, two attendants and a field attendant exist, with a day of sales (cash, M-Pesa, split, one unpaid, one voided, one below list), stock movements (a damage, a count, a settlement with a shortage). 2. The manager runs the sales report grouped by day and by attendant and compares it with the totals Ian can add up by hand from the listed sales. 3. Top products and profit (the manager is refused profit; the owner sees it). 4. The stock report matches the stock list; shrinkage shows the damage and the field shortage against the right person. 5. Exceptions: the void and the below-list sale. Receivables: the unpaid sale and the unverified M-Pesa. 6. The field report shows the settlement. 7. An attendant's "my day" shows only their own sales. 8. The sales CSV opens in a spreadsheet and its total matches the report; a product named `=1+1` shows as text. 9. A second business sees none of it.

Ian runs it, adds up a few numbers by hand, and writes down anything that surprised him.

## 13. Results file

When G1f is finished, Claude Code writes `docs/phase-g1-results.md` in the style of `docs/phase-f-results.md`: status line (only Ian marks the phase done), a summary table per step with "new" and "Phase G1 cumulative" test counts, final patterns (date range handling, the cost-visibility rule, timeout and rate limit, how each report's SQL is built, the CSV neutralising), the mutation proofs, versions (none expected), measured query times, things to know, open risks, changes to other docs, and the final suite results with every number filled in (3 runs in a row).

## 14. Doc updates to make in G1a (show Ian the diff before committing)

- `CLAUDE.md` section 2: the phase table row for G becomes "G1 reports, G2 subscriptions, G3 orders from a website"; section 4 gains the read-only reports exception. Do not touch the status line.
- `docs/architecture.md`: section 13 (replace the single `/reports/*` line with the endpoints above), section 11 (day and range rules for reports), section 16 (open items below).

## 15. Open items

1. Pre-computed summaries if a large wholesaler's reports get slow (measure first).
2. A read replica for reports. Until then a long report holds back `changes` for every shop while it runs, so the 8 second limit matters.
3. Excel (`.xlsx`) export, charts, comparison with the previous period.
4. Scheduled reports by email or SMS (a daily summary to the owner) once real senders exist.
5. Categories, customers and tax reports (those features do not exist yet).
6. A per-business timezone if the product ever leaves Kenya.
7. Reports of M-Pesa verification status become meaningful after Phase M.
8. Stock valuation uses the current cost price, not a costing method (average or FIFO).
9. Cost-bearing exports leave the system as plain files; the owner is responsible for them. Audit rows record that it happened.
10. Which reports matter most should be confirmed with the client; the order of building within G1 may change after that.
