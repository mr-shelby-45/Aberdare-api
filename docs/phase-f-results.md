# Phase F results

**Status: all six steps (F1 to F6) passed. Waiting for Ian's review.** Only Ian marks Phase F done, in CLAUDE.md section 2. The manual walkthrough for Ian is `docs/phase-f-walkthrough.md`.

**Final suite (end of phase, 3 runs in a row):** 3 runs done, all passed, on the working tree this commit records. Run 1: 52 files, 502 of 502 (1380.0 s). Run 2: 52 files, 502 of 502 (1035.0 s). Run 3: 52 files, 502 of 502 (784.2 s). Lint (no warnings), type-check, build and the drift check were clean before the runs, and no `MUTATION` marker was left. Earlier failed runs during Phase F are recorded in their step sections below, as observed.

## Summary

| Step | What it built | New tests | Phase F cumulative | Workarounds and notable changes |
|---|---|---|---|---|
| F1 | `notification` and `error_event` tables, checks, RLS and grants; `list_business_ids` and the two purge functions; the `pgboss` schema and the `queue_user` role; pg-boss and the worker skeleton (`src/worker.ts`, `createWorker()`, `JobQueue`) | 7 | 7 | `error_event` has no RLS (exception approved by Ian); an ineffective per-schema `REVOKE` was found and removed; `identity_owner` needed `CREATE` on `public` for the hand-over (A1 pattern) |
| F2 | `NotificationsService.notify()` in the caller's transaction with a failure guard; `ErrorEventLog`; `GET /v1/notifications`, unread count, mark read | 6 | 13 | No schema change. `ErrorEventLog` first used the Clock, which broke the self-contained `DatabaseModule` (two spike tests); it now uses the database time |
| F3 | Push delivery: `PushSender` and its fake, the atomic claim with a lease, retries, dead tokens, the sweeper, the `pg_notify` wake-up, `PUT /v1/devices/me/push-token` | 9 | 22 | No schema change. Committed in two parts (`bf38aa3`, `0d7f41c`) at Ian's request. A claim mutation needed a new assertion (the status condition and the lease are two guards) |
| F4 | The events: `sale.flagged`, `stock.converted`, `approval.used`, `settlement.variance` (`NotificationEvents`) | 7 | 29 | No schema change. A dedupe mutation is caught by F2 only: a repeated command never re-runs |
| F5 | The scheduled jobs: change-log prune, stock integrity, stale devices, the two purges; schedules registered once; per-business fan-out | 6 | 35 | No schema change. The integrity `error_event` holds short pool ids (the 200-character detail cannot hold 20 pools) |
| F6 | Randomized notification workload (3 seeds), logs, walkthrough document and test, a real-API run with the worker; `pnpm job:run`, a per-push log line, a test-only fake decision hook | 5 | 40 | The workload's own model needed three fixes (see F6) |

New tests count `it` cases as Vitest reports them; the F6 workload is one case per seed (three).

## Final patterns

| Concern | Pattern | Where |
|---|---|---|
| Worker and privileges | One extra process from the same codebase. Business data as `app_user` through `TenantRunner`, one business per short transaction, never bypassing RLS. The queue as `queue_user`, which can reach only the `pgboss` schema. pg-boss's tables are created and upgraded by `pnpm queue:migrate` as the migration role; the worker starts with `migrate: false` and runs no DDL (queues are never partitioned) | `src/create-worker.ts`, `JobQueue`, migration `*_f1_queue_schema`, `src/jobs/queue-schema.ts` |
| The business list | `list_business_ids(after, limit)`: ids only, in id order, `SECURITY DEFINER` owned by `identity_owner`; every id is then processed in its own tenant transaction | `BusinessDirectory` |
| Notifying | In the event's transaction, one `INSERT ... ON CONFLICT DO NOTHING` (`createMany` with `skipDuplicates`) per event, recipients from live memberships, a dedupe key per event. Inside `withSavepoint()`: any error becomes one `error_event` and never fails the command; the savepoint is paid only when an event fires | `NotificationsService.notify()`, `NotificationEvents` |
| The atomic claim | One `UPDATE ... WHERE status = 'PENDING' AND id IN (... FOR UPDATE SKIP LOCKED)`, attempts + 1, a 5-minute lease in `next_attempt_at`; commit before sending; results saved only if the row is still in that claim (`status = 'SENDING' AND attempts = <claimed>`) | `NotificationsRepository.claimDuePush()`, `NotificationDeliveryService` |
| Retries | 3 attempts, 30 seconds and then 2 minutes apart; the last failure makes the row `DEAD` with one `error_event`; a dead token is cleared and the row `DEAD` without one; a member without a token: `NO_PUSH_TOKEN` | `NotificationDeliveryService.decide()` |
| The sweeper and the wake-up | `pg_notify('notification_due', business_id)` in the event's transaction (delivered only on commit) wakes the worker within seconds; every minute the sweep takes back expired leases and enqueues a dispatch for any business with due pushes. Dispatch jobs: a stately queue, the business id as `singletonKey` | `NotificationDueListener`, `NotificationJobs` |
| Schedules and fan-out | Schedules are rows in pg-boss's table, one per name: registered once however many workers run. A fan-out enqueues one job per business on a stately queue (3 at a time, 5-minute expiry); a failing business writes an `error_event` and never stops the others | `ScheduledJobs` |

## Proof the tests catch mistakes

Each mutation was applied temporarily, the named test was shown failing, and the change was reverted (checked byte for byte with `cmp`; database changes only in `aberdare_test`, with the privileges or RLS state compared with before). No `MUTATION` marker was left after any step.

| Mutation (design section 11 where numbered) | Test that failed | Notes |
|---|---|---|
| 1. The notification written in its own transaction after the command | F2 test 1, F4 test 1 | |
| 2. No dedupe (`ON CONFLICT` removed) | F2 test 1 (and F2 concurrency) | F4 test 1 passed: a repeated command is answered from its stored result and never re-runs, so in the command path the dedupe key is a second guard |
| 3. The claim without `status = 'PENDING'` | F3 test 5 | F3 test 4 (the concurrent race) passed: the lease alone also stops a double claim. With the lease removed as well, test 4 failed. Test 5 gained the check that a dispatch never claims an expired lease itself (that would be a 4th attempt) |
| 4. Mark read without the recipient condition | F2 test 4 | |
| 5. The sender called inside the claim's transaction | F3 test 1 | the fake records any call inside a transaction |
| 6. No sweeper | F3 test 5 | |
| 7. Retries without a cap | F3 test 2 | |
| 8. The converter notified when an owner | F4 test 2 | |
| 9. Schedules registered per worker instance | F5 test 5 | its extra schedule rows were removed from `aberdare_test` afterwards (one row per name again) |
| 10. A business job without its tenant transaction | F5 tests 2 and 3 (integrity, stale devices) | for the reads: F2 test 5 needed both RLS and the recipient filter removed (two guards); either alone left it passing |
| 11. A notification failure fails the command | F4 test 5 | |
| Extra (F1): `stop()` without graceful | F1 test 5c | |
| Extra (F1): job data in the log line | F1 test 5a | |
| Extra (F1): `queue_user` given `business` | F1 test 1 | |
| Extra (F1): `identity_owner` keeps `CREATE` on `public` | F1 test 1 | |
| Extra (F2): the list without the recipient condition | F2 test 3 | |
| Extra (F3): no wake-up signal | F3 test 8 | |

## Versions

pg-boss **12.38.0** was added (pinned exactly, released 2026-10-13; it needs Node 22.12 or later). pnpm installed its required peer `@opentelemetry/api` **1.10.0** with it (not a direct dependency). No other library was added. Node 26.12.1, NestJS 12.2.0, Prisma 7.10.1, PostgreSQL 18.6, Vitest 4.1, TypeScript 6.0, as before.

## Things to know

1. `queue_user` is a role: it comes from `docker/postgres/init/01-roles.sql` on a fresh volume, and by hand (as the superuser) on an existing volume or a hosted database. After every `prisma migrate deploy`, run `pnpm queue:migrate`.
2. Per-schema default privileges only add: a `REVOKE ... FROM PUBLIC` per schema silently does nothing. The gate for pg-boss's functions is the schema's USAGE, which only `queue_user` has.
3. `error_event` may only be inserted by `app_user`, so it is written with a plain `INSERT` (no `RETURNING`, no Prisma `create()` that returns the row).
4. The worker logs through the API's pino options from a Fastify instance that never listens (no direct pino dependency). Each push is logged as `push delivered` with the notification id, device id and outcome only.
5. Windows cannot send a real SIGTERM to a child process; the graceful-shutdown test calls the same `shutdown()` the signal handler uses. A real-signal test waits for the Linux container (Phase H).
6. pg-boss's schedule table is not emptied by `resetTables()`: a test that adds schedule rows must remove them.
7. Tests build the worker with `startTestWorker(t.clock, ...)` (the API test app's fake clock); `configurePush` sets up the fake push sender before the worker fetches jobs (jobs left queued by an earlier worker run at once).
8. The fake push sender records every push with the answer it gave, and any call made inside a database transaction.
9. `pnpm job:run <name>` enqueues one run of a scheduled job for the running worker (only the scheduled jobs' names are accepted).

## Open risks

1. Only fake senders exist (push, SMS, email) until the provider accounts exist (Firebase, Africa's Talking, an email provider and sending domain). Login codes and pushes are not really sent yet.
2. Push delivery is at least once: a worker that dies after the provider accepted a push and before the result was saved sends it again after the 5-minute lease (shown, not hidden, by F3 test 5).
3. Nothing notices a dead worker yet (no health check or alert; Phase H).
4. The per-business fan-out and the every-minute sweep loop over all businesses; fine for hundreds, to be measured before thousands (Phase H).
5. The integrity `error_event` lists the pool count and short ids for about 10 pools; the full list needs the check run again by support.
6. Retention of `sync_command` and `audit_log` is undecided (`change_log` 30 days, notifications and error events 90 days).
7. A real SIGTERM is untested on this Windows machine.
8. A phone registers its push token only while online and logged in; a token that changes while offline is picked up at the next registration.
9. A busy shop with many flagged sales makes many notifications; there is no grouping or throttling (design open item 3).
10. Overload still answers 500 instead of 503 (spike open risk 4, unchanged).

## Changes to the other documents

- `CLAUDE.md`: the phase row for F and the Run worker and Queue schema commands (F1); section 8 notes for the worker and queue, `queue_user`, default privileges, the `identity_owner` hand-over, `error_event`, test data (F1), notifications (F2), push delivery and worker tests (F3), events (F4), scheduled jobs (F5). The status line was not touched by Claude Code.
- `docs/architecture.md`: sections 2, 10, 12, 13 and 16 (F1), "as built" notes for F2 to F5 in section 10, the push-token endpoint in section 13 (F3).
- `docs/phase-f-walkthrough.md`: new (F6).

# Step details

## F1: Schema, pg-boss, worker skeleton (passed)

**Result:** new 7, Phase F cumulative 7. The concurrency tests (two workers process 20 jobs each exactly once; shutdown waits for the running job) passed 5 runs in a row. The full suite passed: 46 files, 469 of 469. Committed as `b2e7f14`.

**Built (approved by Ian):** eight migrations (`*_f1_notification_tables` generated; checks; notification RLS with owner purge policies; `error_event` INSERT-only grant; `list_business_ids`; the two purge functions; `device.push_token` UPDATE; the `pgboss` schema with default privileges for `queue_user`), replayed in the shadow database first. pg-boss 12.38.0. `src/worker.ts`, `createWorker()`, `JobQueue`, `migrateQueueSchema()`, `pnpm queue:migrate`, `pnpm start:worker`. `queue_user` in the role init script and created by hand on the local volume.

**Found:** handing `list_business_ids` to `identity_owner` failed in the shadow database until `identity_owner` got `CREATE` on `public` for the hand-over (the A1 pattern). One line in the queue-schema migration (`ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`) did nothing; it was removed and its stored checksum updated on the two local databases.

**Earlier tests changed (mechanical):** the step 4 RLS list (`notification`, and `error_event` as the one exception), the B5 grants inventory, D1 test 5a (`push_token` now updatable), `resetTables()`, the test global setup and `setup-env`.

## F2: Notification service and reads (passed)

**Result:** new 6, Phase F cumulative 13. The concurrency test (20 identical events at once give one row per recipient and channel) passed 5 runs in a row. The full suite passed: 47 files, 475 of 475 after one fix (below). Committed as `319ed81`.

**Found:** the first full run failed 2 of 475, both spike step 1 tests: `ErrorEventLog` took the Clock, so `DatabaseModule` needed `CoreModule`. It now uses the database time, and `DatabaseModule` is self-contained again.

## F3: Delivery (passed)

**Result:** new 9, Phase F cumulative 22. The concurrency test (3 workers, 30 pushes, each sent once; one claim attempted 20 times succeeds once) and the wake-up test passed 5 runs in a row. The full suite passed: 48 files, 484 of 484. Committed as `bf38aa3` (part 1, at Ian's request) and `0d7f41c`.

**Decisions (approved):** 3 attempts (30 seconds, 2 minutes); `pg_notify` wake-up plus the sweeper; no push to shared devices; `notify()` accepts only `IN_APP` and `PUSH` for now.

## F4: Events (passed)

**Result:** new 7, Phase F cumulative 29. Test 1 (20 copies of one command make one notification) passed 5 runs in a row. The full suite passed: 49 files, 491 of 491. Committed as `27257de`.

**Decisions (approved):** an owner who makes a flagged sale is not notified of it (design section 5: never the cause); `approval.used` is written by the conversion or void that used the approval; `payment.attach` flags notify nobody.

## F5: Scheduled jobs (passed)

**Result:** new 6, Phase F cumulative 35. The fan-out and two-worker schedule tests passed 5 runs in a row. The full suite passed: 50 files, 497 of 497. Committed as `cc5d77a`.

**Decisions (approved):** the integrity `error_event` holds `pools=<n>` and short ids within 200 characters; `device.stale` dedupes on the last sync time; fan-out 3 at a time with a 5-minute expiry; `ChangeFeedService` exported from the sync module.

## F6: Hardening and handover (passed)

**Result:** new 5, Phase F cumulative 40 (all seven Phase F files: 40 of 40, 259.4 s), all passing in the gate run. The randomized workload passed 5 runs in a row (15 of 15 seed runs) after the fixes below. Lint (no warnings), type-check, build and the drift check were clean.

**Built (approved by Ian, with the three additions):**
- `test/f6-hardening.spec.ts`:
  - Test 1, the randomized workload (seeds 1001, 2002, 3003; `F6_SEED` replays one): two businesses, 150 operations in waves through the real API (sales, some flagged; conversions by managers and by attendants with a PIN; voids with a PIN; settlements with and without a variance; field-van sales; one stale phone per business), with the worker running as in production (wake-up listener on). The fake push sender gives every push a fate: the first three pushes are a permanent failure, a dead token and a retry; the rest are by a hash of the seed and the notification id. Phones whose token died register a new one. Then the live worker stops, a second worker moves the Clock through every retry, and the checks: exactly the intended notifications per business, type, reference, recipient and channel; nothing crossed businesses; every member's list equals their own rows; every push ended as its fate allows; the `error_event`s are exactly the pushes that used their 3 attempts; no device holds a token that was answered `DEAD_TOKEN`.
  - Test 2, logs: marker text in a member's name, notes, a push token and a product name; an oversell, a conversion and a void with approvals, a settlement with a note and a variance, deliveries with a retry. No marker or message text in any API or worker log line, notification `data` or `error_event`.
  - Test 3 (grants) is the B5 inventory and F1 test 1 (not duplicated, as in T5).
- `docs/phase-f-walkthrough.md` and `test/f6-walkthrough.spec.ts` (test 4): the nine steps of design section 12, phones `0712000701` to `0712000704` and `0712000709`.
- `pnpm job:run <name>` (`src/run-job.ts`), the `push delivered` log line, and `FakePushSender.decide` (tests only); `startTestWorker` gained `configurePush`.

**The workload's own model needed three fixes (none in the code under test):**
1. A push fated "retry, then OK" can end `NO_PUSH_TOKEN`: after its first `RETRY`, another push to the same member was answered `DEAD_TOKEN`, which cleared the token. The expectation now allows that, only for a member whose token died.
2. Two seeds ended with no permanent failure at all (every token had died early, so later pushes had none to fail). Phones now register a new token after one dies, and the first three pushes get fixed fates, so every run covers each case.
3. Jobs left queued by the live worker ran on the drain worker before the test attached its decision hook; `configurePush` now sets the fake up before the worker starts.

**Real-API run:** the built API (`node dist/main`, port 3100) and the built worker (`node dist/worker`), both on the test database, with `node dist/run-job` for steps 7 and 8: 30 of 30 checks. Neither log (148 API lines, 41 worker lines) holds a push token, a name, a message text, a phone number, a PIN or the fixed code, and neither has an error line. The walkthrough test needed two fixes of its own: its helper parsed JSON from a 204, and with the fake clock standing still two notifications tied on created_at, so it now moves the clock a minute between steps, as a person would.
