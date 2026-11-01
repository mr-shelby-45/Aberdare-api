# Phase G1 results

**Status: all six steps (G1a to G1f) built; the end-of-phase "3 full runs in a row" is clean. Waiting for Ian's review.** Only Ian marks Phase G1 done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-g1-walkthrough.md`.

**Final suite (end of phase, 3 runs in a row, with `G1_PERF=1` so the performance test runs too):** run 1: 60 files, 543 of 543 (1719.2 s). Run 2: 60 files, 543 of 543 (1831.5 s). Run 3: 60 files, 543 of 543 (1189.5 s). Lint (no warnings), type-check, build and the drift check were clean before the runs, and no `MUTATION` marker was left. Before them, the five changed test files below passed 5 runs in a row (40 of 40 each).

**An earlier set of 3 runs was not clean.** Run 2 failed two Phase F tests, both flaws in the tests themselves (G1 changed nothing they test). Ian approved fixing them ("Fix tests, rerun"):
1. **F2 test 3** (`test/f2-notifications.spec.ts`) "tampered" a cursor by switching its last character between `A` and `B`. The last character of a 43-character base64url MAC carries only 4 bits, and `A` and `B` differ only in the 2 ignored bits, so in about 6% of runs the "tampered" cursor was the genuine one and the API rightly answered 200 (shown: 244 of 4,000 random MACs). Now it changes the first character, which always changes the signed bytes. The cursor check itself was correct.
2. **F6 test 1, seed 1001** (`test/f6-hardening.spec.ts`, "permanent failures > 0"): the first three pushes got the fixed fates PERMANENT, DEAD_TOKEN, RETRY_THEN_OK. When the first two went to the same member, the dead token was cleared before the PERMANENT push retried, so that push ended `NO_PUSH_TOKEN` and no push ended `PUSH_FAILED`. Now a dead-token fate is never given to the token of the permanent failure, so the test always sees one; its assertions are unchanged.
3. The same fragile tamper, with a much smaller chance (about 0.1% or less), was in `test/b4-search.spec.ts`, `test/d4-hardening.spec.ts` and `test/a5-audit.spec.ts`, and in G1d's own test. All now change the first character. These changes only make the tests stricter.

While checking the F6 fix, its replays failed with `ECONNRESET` (the test's connection to Postgres dropped), not on an assertion. Postgres logged nothing, memory was fine and the container had not restarted. `docker compose restart postgres` (data kept) cured it; every run since passed. It looks like the long-running Docker container's port forwarding on this machine, not the code.

## Summary

| Step | What it built | New tests | Phase G1 cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| G1a | `ReportsModule` and its read-only exception; Nairobi day and range handling; the 8 second statement timeout and a 10 second report transaction (`@TransactionTimeout`); the per-member report rate limit; `GET /v1/reports/sales` and `/v1/reports/my-day`; the doc updates of design section 14 | 12 | 12 | No schema change. Prisma's 5 second transaction limit made a slow but successful report fail at commit (found by a mutation, test 7e added). The rate-limit plugin's in-memory store refuses a whole burst that arrives at once |
| G1b | `GET /v1/reports/top-products` and `/v1/reports/profit` | 6 | 18 | No schema change. A product's name is the one on its latest line in the range |
| G1c | `GET /v1/reports/stock` and `/v1/reports/shrinkage` | 5 | 23 | No schema change. Settlement adjustments get their own reason key `SETTLEMENT`; shrinkage is always in pieces |
| G1d | `GET /v1/reports/exceptions`, `/v1/reports/receivables`, `/v1/reports/field`; paged lists with totals | 5 | 28 | No schema change. A regular expression lost its backslash in an edit script (caught by the test) |
| G1e | The two CSV exports with one `report.exported` audit row each; `CsvWriter` | 6 | 34 | No schema change. Names the API trims (leading tab, carriage return) are tested with names set as the migrator |
| G1f | Randomized cross-check (3 seeds), performance at 50,000 sales, logs, read-only source check, walkthrough document and test, a run against the built API | 7 | 41 | No code change. The performance seed needed `ANALYZE` before a join (first run over 15 minutes) |

New tests count `it` cases as Vitest reports them; the G1f workload is one case per seed (three). The performance test (1 case) runs only with `G1_PERF=1`; a normal `pnpm test` shows it as skipped.

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| The read-only exception | `ReportsRepository` is the one place that reads across modules' tables, with `SELECT` only, through `currentTx()` so RLS applies; display names come from `StaffService.displayNames()`, never a join on `membership`. A source check (G1f test 4) fails on any write statement, Prisma write call or `set_config` other than the timeout | `src/modules/reports/reports.repository.ts`, CLAUDE.md section 4 |
| Days and ranges | `from` and `to` are inclusive Nairobi days (fixed UTC+3; Kenya has no daylight saving) turned into the half-open instants `[from 00:00, to + 1 day 00:00)`; SQL groups by `(occurred_at AT TIME ZONE 'Africa/Nairobi')::date`; at most 92 days | `src/common/time/nairobi.ts`, `reportRange()` |
| One statement per report | CTEs, `ROLLUP` for the totals row, `UNION ALL` for side figures, `LEFT JOIN LATERAL` for a page: the statement timeout bounds the whole report, and every figure comes from one snapshot | `ReportsRepository` |
| Timeout and transaction | `set_config('statement_timeout', 8000, true)` before the report; SQLSTATE 57014 is `503 REPORT_TOO_SLOW`. Report routes get a 10 second transaction (`@TransactionTimeout`), since Prisma's 5 second limit is only noticed at commit | `ReportsService.timed()`, `TenantInterceptor` |
| Rate limit | 30 a minute per member, checked by a controller guard after the token is verified, with the plugin's own `createRateLimit()` | `ReportRateLimitGuard`, `configureApp()` |
| Cost visibility | Cost, value and profit keys are absent (not null) without `costs.view`; profit is refused (`403`); CSV cost columns are absent. A missing cost is never counted as zero: lines, pools and movements without a cost are counted apart | `ReportsService`, `ReportsController` |
| Pieces | Product and shrinkage figures roll pack types up as `quantity * units_per_pack`; a carton is never added to a piece as if they were the same unit | `ReportsRepository` |
| Paged lists | `SignedCursor` bound to the list (`CURSOR_KINDS`) and the range; `limit` 1 to 100; totals of the whole filtered set on every page | `ReportsService.readAfter()` |
| CSV | UTF-8 with a byte-order mark, CRLF, RFC 4180 quoting; text cells starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading apostrophe, the server's own numbers, money and dates never; at most 50,000 rows (one statement asks for 50,001); the audit row is written in the request's transaction before the file is built | `CsvWriter`, `ReportsService.salesExport()` |

## Proof the tests catch mistakes

Each mutation was applied temporarily, the named test was shown failing, and the change was reverted (checked byte for byte). No `MUTATION` marker was left after any step.

| Mutation (design section 11 where numbered) | Test that failed | Notes |
|---|---|---|
| 1. Group by the UTC date | G1a test 1; G1f test 1 (all 3 seeds) | |
| 2. Include voided sales | G1a test 2 | also G1b test 4 (voided lines in products and profit) and G1d test 1 (below-list) |
| 3. Floating point sums | G1a test 4 | |
| 4. Cost keys without `costs.view` | G1c test 1 (stock), G1b test 3 (top products) | also G1d test 3 (field) and G1e test 3 (stock CSV) |
| 5. A missing cost counted as zero | G1b test 2; G1f test 1 (all 3 seeds) | |
| 6. Settlement shrinkage against the closer | G1c test 2 | |
| 7. `SUPPLIER_RETURN` counted as shrinkage | G1c test 2; G1f test 1 (all 3 seeds) | |
| 8. No statement timeout | G1a test 7c (500 instead of 503) | |
| 8b. No 10 second report transaction | G1a test 7e (a 6 second report failed at commit) | added in G1a; mutation 8 alone missed it |
| 9. No CSV neutralising | G1e test 2 | |
| 10. "My day" without the caller filter | G1a test 7a | |
| 11. Pieces without `units_per_pack` | G1b test 1 | also G1c test 2 (shrinkage) and G1d test 3 (field) |
| 12. No range cap | G1a test 1 | |
| Extra (G1a): no report rate limit guard | G1a test 7d | |
| Extra (G1b): profit without the `costs.view` requirement | G1b test 3 | |
| Extra (G1c): stock value including negative balances | G1c test 1 | |
| Extra (G1c): shrinkage by received time instead of the phone's `occurred_at` | G1c test 3 | |
| Extra (G1d): voids ranged by the sale's time instead of `voided_at` | G1d test 1 | |
| Extra (G1d): `approved_by` without the approval check | G1d test 1 | |
| Extra (G1d): reversed payments in unverified M-Pesa | G1d test 2 | two guards (the payment's and the sale's status), both removed |
| Extra (G1d): `age_days` from the UTC date | G1d test 2 | |
| Extra (G1d): the cursor not bound to the filters | G1d test 1 | |
| Extra (G1e): the 50,000 cap off by one | G1e test 4 | |
| Extra (G1e): the export's audit row not written | G1e test 5 | replaced the planned "audit outside the transaction", which is not a small code change (`AuditService` always writes in the current transaction); the rollback itself is G1e test 5's forced failure |
| Extra (G1e): a filter value in the audit metadata | G1e test 5 | |
| Extra (G1e): UTC in the CSV date and time columns | G1e test 1 | |
| Extra (G1f): unpaid sales including voided ones | G1f test 1 (all 3 seeds) | |
| Extra (G1f): the CSV reply logging its first row | G1f test 3 | |
| Extra (G1f): a write statement in `ReportsRepository` | G1f test 4 | |

## Versions

No library was added in Phase G1 (CSV is written by hand). Node 26.12.1, NestJS 12.2.0, Prisma 7.10.1, PostgreSQL 18.6, Vitest 4.1, TypeScript 6.0, pg-boss 12.38.0, as before.

## Measured query times

EXPLAIN (as `app_user` under RLS, on generated data in `aberdare_test`), during each step; no step needed a new index:

| Step | Query | Time |
|---|---|---|
| G1a | sales by day, 92 days (50,000 sales) | 154 ms |
| G1a | sales by attendant, 1 day; by location for one attendant, 92 days; my day | 20 ms; 77 ms; 2.7 ms |
| G1b | top products by quantity, 92 days (250,000 lines) | 0.63 to 0.65 s |
| G1b | profit by day; by product, 92 days | 0.31 s; 0.88 to 0.96 s |
| G1c | stock by product (2,400 pools); shrinkage by person, 92 days (264,000 movements) | 6 ms; 50 to 85 ms |
| G1d | below-list page, 92 days; all-time unpaid; all-time unverified M-Pesa; field | 117 to 133 ms; 31 to 46 ms; 80 to 100 ms; 2 to 8 ms |
| G1e | sales export statement, 47,500 rows | 0.6 to 0.9 s |

Through the API at 50,000 sales over 90 days in one business (G1f test 2), in the gate run and the three final runs after the test fixes (ms; the laptop was busier than in the earlier set, so they are higher, all under 1.1 s; the 8 second limit is 8,000):

| Route | Gate | Final 1 | Final 2 | Final 3 |
|---|---|---|---|---|
| sales by day, 92 days | 270 | 346 | 278 | 193 |
| sales by attendant, 92 days | 244 | 439 | 207 | 143 |
| sales by location, 1 day | 49 | 85 | 34 | 30 |
| my day | 31 | 42 | 21 | 19 |
| top products by quantity, 92 days | 625 | 1069 | 533 | 351 |
| top products by value, 92 days | 627 | 588 | 409 | 338 |
| profit by day, 92 days | 475 | 516 | 522 | 306 |
| profit by product, 92 days | 875 | 964 | 721 | 513 |
| profit by attendant, 92 days | 580 | 542 | 412 | 282 |
| stock by product | 76 | 66 | 63 | 40 |
| stock by location | 45 | 33 | 32 | 22 |
| shrinkage by reason, 92 days | 97 | 98 | 98 | 53 |
| shrinkage by person, 92 days | 97 | 78 | 73 | 49 |
| shrinkage by product, 92 days | 84 | 83 | 85 | 46 |
| voids, 92 days | 96 | 95 | 69 | 57 |
| below list, 92 days | 246 | 159 | 120 | 101 |
| unpaid, all time | 95 | 109 | 64 | 46 |
| unverified M-Pesa, all time | 284 | 144 | 136 | 97 |
| field, 92 days | 124 | 35 | 74 | 53 |
| sales export, 92 days (47,500 rows, 3.0 million characters) | 1099 | 953 | 1025 | 713 |
| stock export | 55 | 59 | 57 | 40 |

## Things to know

1. Report days are Nairobi days; never group or filter a report by the UTC date or by `received_at`. A sale at 23:59:59 Nairobi is that day's; one at 00:00:00 is the next day's.
2. Prisma's interactive transaction limit (5 seconds) is separate from the pool wait and is only noticed at the next statement or the commit. Report routes have 10 seconds; the 8 second statement timeout fires first.
3. The report rate limit (30 a minute per member) counts in each API process's memory and refuses a whole burst that arrives in the same tick (architecture open item 90). Test files spread their report calls over several members.
4. A product's name in a report is the one on its latest sale line in the range; lines keep the name they were sold under.
5. Settlement adjustments are `ADJUST` rows with `LOST` or `FOUND` and a `settlement_id`; shrinkage gives them the key `SETTLEMENT` and counts them against the settlement's attendant.
6. Rows written in the same transaction, and audit rows written in the same test minute, share their time; order through ids, or move the test clock.
7. The randomized check (`G1_SEED`) recomputes every report from raw rows: a new report field must be added to its arithmetic.
8. The performance test runs only with `G1_PERF=1` (about 3 minutes). Bulk seeds must `ANALYZE` fresh tables before joining them.
9. CSV files with costs leave the system as plain files; the audit row records who exported what (design open item 9).

## Open risks

1. Reports are live queries on the primary database: a long report holds back `GET /v1/sync/changes` for every shop while it runs (design open item 2). The 8 second limit bounds it.
2. All-time receivables grow with a business's history (architecture item 91); partial indexes are the remedy when measured.
3. The timings were measured on the dev laptop; Phase H measures again on the hosted database (architecture item 92).
4. Stock valuation and shrinkage value use the current cost price, not a costing method (design open item 8).
5. The report rate limit is per API process (architecture item 90).
6. Which reports matter most is still to be confirmed with the client (design open item 10).
7. Overload still answers 500 instead of 503 outside reports (spike open risk 4, unchanged).

## Changes to the other documents

- `CLAUDE.md`: the phase row for G and the read-only reports exception in section 4 (G1a); section 8 notes on reports and dates, Prisma's 5 second limit, the report rate limit, slow-report tests (G1a), product reports and the route inventory (G1b), stock reports (G1c), list reports (G1d), CSV exports (G1e), the randomized check, the performance test and bulk seeding (G1f). The status line was not touched by Claude Code.
- `docs/architecture.md`: section 2 (the exception), section 11 (days and ranges in reports), section 13 (every report endpoint, as built), section 16 items 80 to 92.
- `docs/phase-g1-walkthrough.md`: new (G1f).

# Step details

## G1a: Foundation, sales report, my day (passed)

**Result:** new 12, Phase G1 cumulative 12. The file passed 5 runs in a row; the full suite passed: 53 files, 514 of 514. Committed as `91b230b`.

**Found:** a 6 second report that succeeded failed at commit with a 500: Prisma's own 5 second transaction limit. Report routes now get 10 seconds (`@TransactionTimeout`, approved). Test 7e was added because mutation 8 alone missed it. The rate-limit plugin's store hands every caller one shared counter, so 31 requests arriving at once were all refused; the burst test sends its requests one after another.

## G1b: Top products and profit (passed)

**Result:** new 6, Phase G1 cumulative 18. 5 runs in a row; the full suite passed: 54 files, 520 of 520. Committed as `500cad8`.

**Decisions (approved):** the latest line's product name; cost keys in top products with `costs.view`; per-row without-cost figures and rows for groups whose lines all lack a cost; a `totals` object in profit. **Found:** the first run hit the report rate limit (429 instead of 422); requests are spread over two members.

## G1c: Stock and shrinkage (passed)

**Result:** new 5, Phase G1 cumulative 23. 5 runs in a row; the full suite passed: 55 files, 525 of 525. Committed as `3e44a97`.

**Decisions (approved):** pieces for every shrinkage grouping; the `SETTLEMENT` reason key; lost, found and net cost values plus `movements_without_cost`; `CORRECTION` and `OTHER` excluded; `include_archived` on the stock report.

## G1d: Exceptions, receivables and field (passed)

**Result:** new 5, Phase G1 cumulative 28. 5 runs in a row; the full suite passed: 56 files, 530 of 530. Committed as `fcf2b31`.

**Decisions (approved):** totals on every page; voids and below-list newest first, receivables oldest first; receivables all time unless a range is given; `approved_by` null without an approval; field units in pieces. **Found:** the below-list cursor was refused on its own next page: an edit script had written its line-number check inside a JavaScript template string, which turned `\d` into `d`.

## G1e: CSV exports and audit (passed)

**Result:** new 6, Phase G1 cumulative 34. 5 runs in a row (the 50,000-row export about 1 s and 52 to 58 MB of heap each time); the full suite passed: 57 files, 536 of 536. Committed as `4bac4cc`.

**Decisions (approved):** neutralise text cells only; the stock export keeps the stock report's filters and defaults; empty `value_at_cost` for non-positive balances and missing costs; the forced failure through `vi.spyOn()` on the app's `CsvWriter`; a coarse heap ceiling; dates allowed in audit metadata.

## G1f: Hardening and handover (passed)

**Result:** new 7, Phase G1 cumulative 41 (all eight Phase G1 files: 41 of 41 in the gate run, 481.2 s, with `G1_PERF=1`). The hardening and walkthrough files passed 5 runs in a row (6 of 6 each time, about 115 s). The full suite passed once without `G1_PERF`: 59 files and 1 skipped, 542 passed and 1 skipped (1236.4 s). Lint (no warnings), type-check, build and the drift check were clean.

**Built (approved by Ian):**
- `test/g1f-hardening.spec.ts`:
  - Test 1, the randomized cross-check (seeds 4111, 5222, 6333; `G1_SEED` replays one): two businesses, a fixed opening each (a duplicate M-Pesa code, a below-list line, a void, a supplier return), then 200 random operations through the real API: sales of every payment shape by attendants, a manager and field attendants, payments attached later, voids by a manager and by attendants with an approval, adjustments with all seven reasons, counts, receives, issues, returns and settlements. Every report (the sales report by every grouping and both filters, my day, top products, profit, stock, shrinkage, every page of both exceptions and both receivables lists, the field report, both CSVs) is compared with an independent calculation in TypeScript from the raw rows (plain SELECTs as the superuser, BigInt cents, its own Nairobi day). Cross-checks: the sales report equals paging `GET /v1/sales`; the stock report equals `GET /v1/stock`; `revenue - cost = profit` in every row; each CSV equals its report. About 40 to 50 sales, 75 to 100 lines and 180 to 200 movements per business, 28 report checks each.
  - Test 3, logs: marker names (business, staff, locations, product, pack type), amounts with unusual cents, an M-Pesa code and notes; every report and both exports, then the error paths (403, 422, the range cap, a 503 from a held lock, a forced 500). No marker, amount or code in any log line or `error_event`.
  - Test 4, read-only: the repository source has no write statement, no Prisma write call, one `$executeRaw`, and `set_config` only for the statement timeout. The grants inventory itself (G1f test 4 of the design) is `test/b5-hardening.spec.ts`, unchanged since Phase G1 started (no diff since `34539d3`, and no new migration).
- `test/g1f-performance.spec.ts` (test 2, `G1_PERF=1`): one business with 50,000 sales over 90 days (125,000 lines, payments, 125,000 `SALE` movements, 4,900 adjustments and counts, 1,200 balances, 100 settlements), seeded as the migrator; 21 report routes and exports timed through the API.
- `docs/phase-g1-walkthrough.md` and `test/g1f-walkthrough.spec.ts` (test 5): the nine steps of design section 12, phones `0712000801` to `0712000805` and `0712000809`.

**Found:**
1. The first seeded runs of the randomized check passed every comparison but failed the "did it exercise everything" check: with some seeds one business had no duplicate code or no supplier return. A fixed opening per business now guarantees each rare case.
2. The performance seed spent over 13 minutes on one statement and hit the 15-minute hook limit: without statistics the planner joined 50,000 fresh sales to their lines in a nested loop. `ANALYZE` before the join fixed it (the seed now takes about 2 minutes). The stuck query was stopped in `aberdare_test` only.
3. In the walkthrough test two M-Pesa payments with the same time came back in id order; the test compares them by sale number. A below-list price is not a sale flag (the sale is `ACCEPTED`).

**Real-API run:** the built API (`node dist/main`, port 3100) on the test database with the real clock (2026-11-01): 37 of 37 walkthrough checks. Its log (166 lines) holds no staff name, M-Pesa code, amount, phone number, PIN or fixed code, and no error line.
