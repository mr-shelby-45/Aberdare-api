# Phase D results

Filled in step by step. The full summary (see `docs/phase-d-design.md` section 13) is written when D4 is finished. Only Ian marks the phase done, in `CLAUDE.md` section 2.

## D1: Migration, cursor, finished-transactions query, prune, device stamp (passed)

**Result:** new 7, Phase D cumulative 7 (`test/d1-change-log.spec.ts`), all passing in the gate run. The gap test (D1 test 3, a genuinely held-open transaction) passed 5 runs in a row. D1 test 1's inventories are in `test/step4-migrations.spec.ts` and `test/b5-hardening.spec.ts` (both passed with the D1 file: 27 of 27). The first full-suite run failed one test (331 of 332): A3's "loose timing sanity check" of password login measured a ratio of 0.497 against 0.5, in a run that took 748.7 s instead of the usual 350 to 420 s (machine load; D1 touches no login or hashing code; the same failure as in C3). Rerun unchanged, the full suite passed: 27 files, 332 of 332 (613.7 s). Lint, type-check, build and the drift check were clean.

**Built (approved by Ian on 2026-10-26, with the eight recommended answers):**
- Doc updates of design section 14 (commit `400065e`), with Ian's design edits (device stamp, business id in the cursor, device checks).
- Three migrations, replayed and probed in the shadow database before approval:
  - `*_d1_change_log_txid` (generated): `change_log.txid xid8 NOT NULL DEFAULT pg_current_xact_id()` (existing rows took the migration's id; the default stays, it is how the triggers fill the column, so the triggers are unchanged), the `(business_id, txid, id)` index, and the `change_log_horizon` table.
  - `*_d1_change_log_prune`: the single horizon row (`app_user` SELECT only), owner-only read and delete policies on `change_log` (`FORCE` RLS applies to the owner too), and the `SECURITY DEFINER` function `change_log_prune(p_before)`, EXECUTE for `app_user` only (answer 1). It removes rows of every business written before the cut-off (answer 2) and moves the horizon to the newest removed `(txid, id)`, never backwards (answer 3).
  - `*_d1_device_update_columns`: `app_user`'s table-wide UPDATE on `device` replaced by UPDATE of `name`, `is_shared`, `status`, `last_seen_at`, `last_sync_at` (answer 7).
- `ChangeLogRepository` (`src/modules/sync/`): `startPosition()` = `(pg_snapshot_xmin(pg_current_snapshot()), 0)`; `finishedAfter(position, limit)`, the finished-transactions query as approved, with the comment on why it removes the gap; `isRetained(position)` against the horizon.
- `ChangesCursor`: the shared `SignedCursor` with kind `sync-changes`, holding `{ business_id, txid, id, costs }`. Tampered, malformed, unsigned, another kind, or another business's: the same `422 VALIDATION_FAILED`. A `costs` mismatch: `410 SNAPSHOT_REQUIRED`.
- `ChangeFeedService`: `startCursor`, `open` (cursor checks plus the horizon: `410`), `finishedAfter`, `sign`, and `prune()` (the Clock minus `changeLogRetentionDays`, a constant 30 in `AppConfig`, answer 4) through `ChangeLogMaintenance` in `src/database/` (non-tenant, answer 5).
- `DevicesService.stampSync(deviceId)`: the existing `last_sync_at` column (answer 6), one conditional `UPDATE` with the Clock, at most once every 5 minutes. Tested directly; the sync endpoints call it from D2 (answer 8).

**Earlier tests changed by D1 (mechanical; no assertion weakened):**
- Step 4's inventory now also lists `change_log_prune` (security definer, `app_user` may run it, PUBLIC may not) and the three `change_log` policies.
- B5's grants inventory lists `change_log_horizon: SELECT` and `device: SELECT,INSERT` plus the five updatable device columns.
- `resetTables()` also resets the prune horizon.

**Proof the tests catch mistakes** (each applied, shown failing, reverted, revert checked with `cmp`):
- Mutation 1, order and filter by id only, without the finished-transactions condition: D1 test 3 failed (rows were returned while T1 was still open).
- Mutation 5, prune inside the retention window (28 days): D1 test 6 failed (10 rows removed instead of 4).
- Mutation 9, the stamp without the 5-minute condition: D1 test 5a failed (a second stamp after 4 minutes wrote).
- Mutation 10, no business id in the cursor: D1 test 5 failed (business A's cursor was accepted by business B).

**Things to know:**
1. Devices have only `ACTIVE` and `REVOKED`; there is no suspended device. D2 test 7 and D3 test 9 read "a revoked or suspended device" as "a revoked device, or a suspended member" (decided in D1, answer 8).
2. Transaction ids and change_log ids are 64-bit; they are carried as decimal text (`txid::text`, `id::text`) and compared in SQL, never as JavaScript numbers. Tests use `BigInt` only to compare them.
3. The prune's horizon is a position, not a time: rows are removed by `changed_at`, but a transaction that started early can write a higher `txid` later, so the horizon is the newest removed position, which can refuse a cursor slightly more often than strictly needed, never less.
