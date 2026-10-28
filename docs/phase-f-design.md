# Phase F design: Worker, notifications and scheduled jobs

Status: approved by Ian on 2026-10-27 (all questions answered with the recommended defaults; the payment-after-settlement fix, "T6", is done separately by Ian with Claude Code and is not part of this phase). This file is the source of truth for Phase F. Where it disagrees with `docs/architecture.md` (section 10) or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 14). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md` and the results files of Phases A to T (the "Final patterns" and "Things to know" of each). The patterns proven there are the way to do things. Do not invent new ones.

Do not start until T6 is finished and committed and Ian has marked Phase T done in `CLAUDE.md` section 2.

## 1. Goal and scope

A second process, the worker, runs background work: delivering notifications and running scheduled jobs. Events that matter to an owner or manager (an oversold sale, a settlement with a shortage, a PIN used for an approval, a phone that has not synced) become notifications that the app can list online and that urgent ones push to phones. Housekeeping that the earlier phases built but never scheduled (pruning `change_log`, the nightly stock integrity check) now runs by itself.

In scope:
- `src/worker.ts` as a separate entry point, using pg-boss (already in the fixed stack in `CLAUDE.md` section 3).
- The `notification` table, `error_event` table, a non-tenant business-list function, the notification service, and the senders as interfaces with fake implementations (push, SMS, email).
- Reads and writes of notifications by their recipients: `GET /v1/notifications`, `GET /v1/notifications/unread-count`, `POST /v1/notifications/read`.
- Events wired now (section 6), and scheduled jobs (section 7).

Out of scope (do not build): real push (Firebase), SMS (Africa's Talking) and email providers, which need accounts Ian does not have yet (the interfaces and fakes are built now; real adapters come in a small later step); notification events for orders, payments arriving at the till, low stock and subscriptions (they belong to their phases); notification preferences, quiet hours, Swahili text (the phone renders the language), digests; syncing notifications to phones through `snapshot` and `changes`; a notification admin screen; Sentry (Phase H); an alerting or worker-health dashboard (Phase H).

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Worker | One extra process (`src/worker.ts`), same codebase, pg-boss queue inside Postgres. No Redis. |
| Senders | Interfaces plus fake senders now. Real adapters later, when accounts exist. |
| Events now | Flagged sales, carton broken, PIN used for an approval, settlement variance, phone not synced for 3 days, integrity mismatch (to `error_event`, not to shops). |
| In-app notifications | Online-only REST list with an unread count and mark-read. Push for urgent events. |
| Retries | 3 tries with growing delays; a final failure writes an `error_event`. Notifications and error events kept 90 days. |
| Row-level security | The worker never bypasses it. It loops over businesses and runs each one in a normal tenant transaction. |

## 3. Data model

Same rules as before: tenant tables have `id`, `business_id`, `created_at`, forced RLS with the `shop_only` NULLIF policy, composite foreign keys, unique `(business_id, id)`, explicit grants. Claude Code proposes the exact Prisma schema and SQL for each step and waits for approval before applying. Check what exists first: `error_event` and the device push-token column may already exist from Phase A. Every new table, function and hand-written index goes into the exact inventories in `test/step4-migrations.spec.ts` and the grants inventory in `test/b5-hardening.spec.ts`.

**notification** (new, tenant)
- `type text` (checked list, section 6), `recipient_membership_id` (composite foreign key), `channel text` check in `IN_APP`, `PUSH`, `SMS`, `EMAIL`.
- `data jsonb not null` (ids and numbers only; see section 6; never names, notes, phone numbers, PINs, codes or amounts of a customer's payment).
- `status text` check in `PENDING`, `SENDING`, `SENT`, `DEAD`; `attempts integer not null default 0`; `next_attempt_at timestamptz`; `last_error text null` (an error code, at most 60 characters, never message text); `sent_at`, `read_at` (null until read).
- `dedupe_key text not null`, with a unique constraint `(business_id, recipient_membership_id, channel, dedupe_key)`: creating the same notification twice, for example when an idempotent command is retried, makes one row.
- `IN_APP` rows are created with status `SENT` (visible at once) and are never handled by a sender. `PUSH`, `SMS` and `EMAIL` rows start `PENDING`.
- `app_user`: SELECT, INSERT, and UPDATE of `status`, `attempts`, `next_attempt_at`, `last_error`, `sent_at`, `read_at` only. No DELETE (the purge uses a function, below).
- Index for the list: `(business_id, recipient_membership_id, created_at DESC, id DESC)`. Index for the sweeper: `(business_id, status, next_attempt_at)`.

**error_event** (support only, non-tenant)
- `source text` (a job or component name), `code text`, `detail text` (short, no secrets, at most 200 characters), `business_id uuid null` (plain column, no foreign key), `created_at`.
- `app_user` has INSERT only. There is no read path in the API, so there is nothing to leak across businesses; support reads it with the migrator or a superuser. This is a deliberate, narrow exception to "every business-owned table has RLS": show Ian the reasoning when you present the SQL, and let him decide.
- Purge of rows older than 90 days by a function.

**Functions** (hand-written SQL, `SECURITY DEFINER`, owned by the existing owner role pattern, EXECUTE for `app_user` only, PUBLIC revoked, as `change_log_prune` and the `identity_*` functions)
- `list_business_ids(p_after uuid, p_limit integer)`: ids of businesses in id order after the given id, at most `p_limit`. Returns ids only, nothing else.
- `purge_old_notifications(p_before timestamptz)` and `purge_old_error_events(p_before timestamptz)`: delete rows older than the given time across all businesses and return the count. The notification purge needs an owner-only delete policy, the pattern used for `change_log_prune`.

**device**: the push token column and a way to mark a token dead (clear it) already exist or are added by the smallest change (UPDATE grant on that column only). Check Phase A first.

**pg-boss** keeps its own schema and tables. Do not write the setup from memory; read the documentation for the installed version, including how it creates its schema and which privileges it needs, and how to run its schema creation as the migrator role during migration or deploy rather than as the runtime role. Show Ian the privilege plan (which role creates the schema, which role the worker connects as, which grants it needs) before applying anything. If pg-boss does not work with the installed Node or Prisma setup, stop and report.

## 4. The worker process

- `src/worker.ts` boots the Nest application context (no HTTP server), starts pg-boss, registers the handlers and schedules, and shuts down cleanly on SIGTERM (finish the running job, stop fetching).
- Run command in `CLAUDE.md` section 8 (`Run worker`). Configuration (retry delays, thresholds, retention, intervals) is constants in `AppConfig`, not hard-coded.
- Every job handler is idempotent. Every business job runs through `TenantRunner` for one business at a time, in its own short transaction. No network call (a sender) inside a database transaction.
- Fan-out: a scheduler job lists businesses with `list_business_ids` (paged) and enqueues one job per business; a failure in one business must not stop the others and must write an `error_event`.
- Schedules are registered once, however many worker instances run. Times are written in UTC with a comment giving the Nairobi time (UTC+3, no daylight saving).
- Structured logs per job: job name, business id, duration, counts, outcome. No notification content, tokens or names.

## 5. Notifications: creating, delivering, reading

**Creating.** `NotificationsService.notify(...)` writes the row(s) in the same transaction as the event (the caller's transaction), one per recipient and channel, with a `dedupe_key` that identifies the event (for example `sale.flagged:<sale_id>`). The insert is `INSERT ... ON CONFLICT DO NOTHING`. Recipients are resolved from live memberships: active only, never the person who caused the event unless stated. "Owner" means the active members with the owner preset. A rolled-back event leaves no notification.

**Waking the worker.** A pending push must go out within about a minute. Enqueue a dispatch job only after the event's transaction has committed (never inside it), and also run a sweeper every minute that finds `PENDING` rows that are due and `SENDING` rows stuck for more than 5 minutes, so a lost job loses nothing. Propose the smallest mechanism that fits the existing `TenantRunner` and show Ian before building.

**Delivering (`PUSH`, `SMS`, `EMAIL`).**
- Claim with one atomic statement: `UPDATE notification SET status = 'SENDING', attempts = attempts + 1 ... WHERE id = $id AND status = 'PENDING' AND next_attempt_at <= $now RETURNING ...`. Two workers never send the same row. The claim commits before the sender is called; the sender is called outside any transaction; the result is then written in a new short transaction.
- Delivery is at least once: a crash after the sender returned and before the result was saved can send twice. This is accepted for push; record it as a known property.
- Sender result: `OK` (status `SENT`, `sent_at`), `RETRY` or an exception (back to `PENDING` with `next_attempt_at` from the delay table, 30 seconds, 2 minutes, 10 minutes), `DEAD_TOKEN` (clear the device's push token, mark the row `DEAD` without retries, no error event), `FAILED` (retry). After the third attempt fails: status `DEAD`, `last_error` set, one `error_event`.
- Senders are interfaces in `src/integrations/` (`PushSender`, `SmsSender`, `EmailSender`), with fake implementations for dev and tests. Reuse the sender interfaces and fakes that Phase A built for login codes; do not create a second set. The fake keeps what it was asked to send in memory for tests and logs only a masked line in dev.

**Reading (the recipient only).** All three need an active member on an active device, and always return only the caller's own notifications (RLS plus `recipient_membership_id = caller`). No business parameter (`business_id` in a query is `422`).
- `GET /v1/notifications?unread=&limit=&cursor=`: newest first by `(created_at, id)`, shared `SignedCursor`, `limit` default 20, max 100. Row: `id, type, data, message, created_at, read_at`. `message` is a short English text rendered from the type and data at read time (no secrets); the phone may render its own language from `type` and `data`.
- `GET /v1/notifications/unread-count`: `{ unread }`, counting only `IN_APP` rows with no `read_at`.
- `POST /v1/notifications/read` body `{ ids: [...] }` (1 to 100) or `{ all: true }`: sets `read_at` where it is null and the notification is the caller's; ids of other members' or missing notifications are ignored without error and without telling which. Idempotent.
- Only `IN_APP` rows are listed. Push rows exist only to be delivered.

## 6. Events wired now

Each is created in the same transaction as the event, with the dedupe key shown. Data holds ids and counts only.

| Type | When | Recipients | Channels | Dedupe key | Data |
|---|---|---|---|---|---|
| `sale.flagged` | `sale.create` ends `FLAGGED` (any reason, including `STOCK_NEGATIVE` and `AFTER_SETTLEMENT`) | active owners | IN_APP | `sale.flagged:<sale_id>` | sale id, sale number, flags |
| `stock.converted` | `stock.convert` accepted | active owners except the converter | IN_APP | `stock.converted:<conversion id>` | conversion id, converter |
| `approval.used` | a PIN approval is consumed by `stock.convert` or `sale.void` | the approver (IN_APP and PUSH) and active owners except the approver and the requester (IN_APP) | as listed | `approval.used:<approval id>` | purpose, requester, approver, the stock or sale id |
| `settlement.variance` | `settlement.close` with a nonzero `cash_variance` or any nonzero line variance | active owners except the closer | IN_APP and PUSH | `settlement.variance:<settlement id>` | settlement id, attendant, cash variance, count of lines with a variance |
| `device.stale` | the stale-device job (section 7) | active owners | IN_APP | `device.stale:<device id>:<date of its last sync>` | device id, member, days |

A mismatch found by the integrity job is not a notification: it writes an `error_event` (section 7). The login code SMS stays as Phase A built it, through the same sender interface.

The existing command results, audit rows and flags are unchanged. Notifying must never make a command fail: if creating a notification raises an unexpected error, the command still succeeds and an `error_event` is written (but a rolled-back command writes no notification). Show Ian how you will guarantee that without a savepoint cost on every command.

## 7. Scheduled jobs

| Job | When (UTC, Nairobi in the comment) | What |
|---|---|---|
| `changelog.prune` | daily 00:00 (03:00) | `ChangeFeedService.prune()` (the Phase D function). Log the count. |
| `stock.integrity` | daily 00:30 (03:30), one job per business | `StockIntegrityService.check()` in a tenant transaction. A mismatch writes one `error_event` per business per run listing the number of pools and at most 20 pool ids. No notification. |
| `devices.stale` | daily 04:00 (07:00), one job per business | Active devices with `last_sync_at` older than 3 days (or never synced and older than 3 days) notify owners as `device.stale`. Revoked devices are skipped. A device that syncs again and goes stale again later is a new episode (the dedupe key includes its last sync date). |
| `notifications.sweep` | every minute | Section 5. |
| `notifications.purge` | daily 01:00 (04:00) | `purge_old_notifications` for rows older than 90 days. |
| `errors.purge` | daily 01:10 (04:10) | `purge_old_error_events` for rows older than 90 days. |

Fan-out jobs are staggered so one slow business does not delay the others. A job may be run on demand (a function the tests call) with the Clock injected.

## 8. Lessons from earlier phases that apply

- Do not run any test while a migration waits for review.
- Testing method as in `docs/phase-b-design.md` section 12 (new tests during a step; concurrency tests 5 times; gate with earlier Phase F files once; full suite once in the background; end of phase 3 runs in a row with real numbers).
- Keep transactions short; an idle or long transaction holds back `changes` for every shop. The worker must never hold a transaction open while waiting on a sender or a timer.
- Race tests must force the overlap (held-open transaction and a wait for lock waiters, `lockWaiters()` in the E3 and T4 tests).
- Rows in one transaction share `created_at`; order through ids.
- Generated and hand-written objects need a migration and, where Prisma would drop them, the Prisma declaration. Do not run `prisma format` on the whole schema. A migration that adds a `NOT NULL` column fails on a test database with leftover rows: wipe `aberdare_test` first.
- Verify every mutation revert byte for byte. Search for leftover mutation markers before the final suite.
- Auth routes are rate limited per IP; tests use their own IP and phone range.
- Commit after each passing step and check `git status` is clean.
- Never weaken an earlier test. Report and ask.

## 9. Mistakes AI tends to make here (do not)

- Calling a sender (push, SMS, email) inside a database transaction, or holding a transaction while waiting.
- Running worker queries as a role that bypasses RLS, or reading notifications across businesses in one query "for speed".
- Creating the notification outside the event's transaction (an event that rolled back still notifies, or a committed event loses its notification).
- Reading then updating a notification's status in two steps instead of one atomic claim (double sends).
- Letting one failing business or one failing notification stop the whole job.
- Putting names, notes, phone numbers, amounts of customers' payments, codes, tokens or full message text in `data`, `last_error`, `error_event.detail` or logs.
- Notifying the person who caused the event, or inactive and suspended members.
- Registering schedules once per worker instance, so each runs several times.
- Letting a notification failure fail the command that caused it.
- Letting recipients read or mark other people's notifications, or telling them which ids exist.
- Building real providers, preferences, digests, order or payment or low-stock or subscription events, or syncing notifications "while here".
- Installing a library other than pg-boss without asking.

## 10. Build order

Each step ends with passing tests shown in the session and a commit. Present schema and SQL before applying and run no test until approved.

- **F1: Schema, pg-boss, worker skeleton, doc updates.** Section 3, 4 and 14. The business-list function and the privilege plan for pg-boss are shown to Ian first.
- **F2: Notification service and reads.** Section 5 (creating and reading).
- **F3: Delivery.** Section 5 (senders, claim, retries, dead tokens, the sweeper).
- **F4: Events.** Section 6.
- **F5: Scheduled jobs.** Section 7.
- **F6: Hardening and handover.** Randomized workload, logs, grants, walkthrough (`docs/phase-f-walkthrough.md`), results (`docs/phase-f-results.md`).

## 11. Test plan

Real Docker database, injectable `Clock`, genuinely concurrent concurrency tests, fake senders with a test inspection interface.

**F1**
1. Inventories (RLS tables, functions, indexes, policies) and the grants inventory list the new objects; `app_user` has no DELETE on `notification` or `error_event`, INSERT only on `error_event`, and only the listed UPDATE columns on `notification`; PUBLIC cannot run the new functions.
2. Database checks refuse: a type, channel or status outside the lists; an over-long `last_error` or `detail`; a negative `attempts`; a duplicate dedupe key for one recipient and channel (the same key for another recipient or channel is fine).
3. `list_business_ids` returns every business exactly once across pages of any size, in id order, ids only, with no tenant setting; it works for `app_user`.
4. The purge functions delete only rows older than the cut-off, across businesses, and return the counts.
5. pg-boss starts and stops against the test database with the privilege plan; two worker instances processing 20 jobs process each exactly once; the worker entry boots, handles a job, and shuts down on SIGTERM without losing the running job.
6. Earlier suites pass (changed only mechanically).

**F2**
1. `notify` creates one row per recipient and channel in the caller's transaction; a rolled-back transaction leaves none; the same event twice (same dedupe key) leaves one.
2. Recipient resolution: active owners only; suspended and invited members excluded; the actor excluded where the table says so; a business with no active owner creates nothing and does not fail.
3. `GET /v1/notifications`: only the caller's own, newest first, `unread` filter, paging with a signed cursor (tampered is `422`), `limit` rules, `business_id` parameter `422`, a suspended member and a revoked device refused; only `IN_APP` rows appear; `message` text holds no secrets.
4. `unread-count` matches the list; `POST /read` marks the caller's ids, ignores others' and unknown ids with an identical response, `all: true` marks everything of the caller only, repeating it changes nothing.
5. Tenant isolation: identical events in two businesses never mix; a member of business B never sees A's notifications.

**F3**
1. A `PENDING` push is claimed, sent through the fake sender outside any transaction (the fake asserts no open database transaction) and marked `SENT` with `sent_at`; `IN_APP` rows never reach a sender.
2. Retries: a sender that fails twice and then succeeds ends `SENT` with `attempts = 3` and waits the growing delays (move the Clock); a sender that fails three times ends `DEAD` with one `error_event` and `last_error` set to a code.
3. `DEAD_TOKEN`: the device's push token is cleared, the row is `DEAD`, no retry, no `error_event`; a later notification to that member skips the cleared token cleanly.
4. Concurrency (5 runs): 3 workers and 30 pending notifications send each exactly once; the same claim attempted 20 times concurrently succeeds once.
5. Crash handling: a notification left `SENDING` for more than 5 minutes (Clock) is reclaimed by the sweeper and sent; a `PENDING` row whose dispatch job was lost is sent by the sweeper. A row whose first attempt is merely slow (still inside the 5 minutes) is not reclaimed. The case where the original sender call finishes after the sweeper reclaimed the row can send twice; the test documents this at-least-once case rather than hiding it.
6. A throwing or timing-out sender never leaves a transaction open or a row stuck.
7. No log line contains a token, a message body or a recipient's name.

**F4**
1. A sale flagged for each reason creates one `sale.flagged` for each active owner, in the sale's transaction; an unflagged sale creates none; the same command sent twice creates one; a sale that rolls back creates none; an `AFTER_SETTLEMENT` sale notifies with that flag listed.
2. `stock.convert` by a manager notifies owners; by an owner notifies nobody; with an approval, `stock.converted` plus `approval.used`.
3. `approval.used`: the approver gets IN_APP and PUSH, owners (other than the approver and requester) IN_APP; the same for a `SALE_VOID` approval; a failed conversion that rolled the approval back creates nothing.
4. `settlement.variance` only when a cash or line variance is nonzero; not for a closer who is the only owner; push delivered by the fake after the worker runs.
5. Notifying never fails a command: with the notification insert forced to fail, `sale.create`, `stock.convert`, `sale.void` and `settlement.close` still succeed, and an `error_event` is written.
6. Suspended owners are not notified; the data of each notification holds only ids and counts (checked by key list).

**F5**
1. `changelog.prune` through the job removes old `change_log` rows and moves the horizon (the Phase D rules still hold).
2. `stock.integrity`: clean data writes nothing; a balance corrupted as the superuser writes one `error_event` for that business only, listing at most 20 pools, and no notification; a second run writes another; one business's failure (injected) does not stop the others and writes an `error_event`.
3. `devices.stale`: a device 3 days and 1 minute without sync notifies owners once; running the job twice notifies once; a device that synced in between and goes stale again notifies again; a revoked device never does; a device that never synced is judged by its creation date.
4. Purge jobs remove notifications and error events older than 90 days and keep newer ones.
5. Schedules: starting two worker instances registers each schedule once; the fan-out job enqueues exactly one job per business.
6. Every job is safe to run twice in a row.

**F6**
1. Randomized, seeded and replayable (`F6_SEED`): two businesses, 150 operations (flagged sales, conversions with and without approvals, voids with approvals, settlements with and without variances, device activity) through the real API with a worker running and a fake push sender that fails at random, including dead tokens, for three seeds. At the end: every event has exactly one notification per intended recipient and channel; no duplicates; every `PENDING` row is eventually `SENT` or `DEAD`; the count of `DEAD` rows equals the injected permanent failures; no notification crossed businesses; no member read another's.
2. Logs: marker names, notes, tokens and message text in events; none appear in any log line or `data` or `error_event`.
3. The grants inventory matches section 3.
4. The walkthrough runs as a test and once against the built API and a running worker on the test database.
5. The results file has no placeholders.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, revert and verify the revert:
1. Create the notification after the command's transaction, in its own transaction: F2 test 1 and F4 test 1.
2. Remove the dedupe key's unique constraint or the `ON CONFLICT`: F2 test 1 and F4 test 1.
3. Claim without the `status = 'PENDING'` condition (or read then update): F3 test 4.
4. Mark-read without the recipient condition: F2 test 4.
5. Call the sender inside the claim's transaction: F3 test 1.
6. Remove the sweeper: F3 test 5.
7. Retry without a cap: F3 test 2.
8. Notify the converter when the converter is an owner: F4 test 2.
9. Register the schedules on every worker instance: F5 test 5.
10. Run a business job without the tenant transaction: the isolation tests of F2 and F5.
11. Let a notification failure fail the command: F4 test 5.

## 12. Manual walkthrough (for Ian)

At the end of F6, Claude Code writes `docs/phase-f-walkthrough.md` (curl, plus the worker started in a second terminal) with fake senders:

1. Start the API and the worker. 2. The owner, a manager and an attendant exist; stock is low. 3. The attendant sells more than is in stock; the owner lists notifications and sees `sale.flagged` and a nonzero unread count; marks it read. 4. The manager converts a carton; the owner is notified. 5. The attendant voids a sale with the manager's PIN approval; the manager (approver) gets in-app and a fake push, shown in the worker log as a masked line. 6. A field attendant's day closes with a shortage; the owner gets `settlement.variance`. 7. A phone is made stale (move `last_sync_at` back with a SQL line given in the document); the next run of the stale job notifies the owner once. 8. The integrity job is run after the balance is deliberately corrupted with the superuser SQL given in the document; an `error_event` appears. 9. A second business sees none of it.

Ian runs it and writes down anything that surprised him.

## 13. Results file

When F6 is finished, Claude Code writes `docs/phase-f-results.md` in the style of `docs/phase-t-results.md`: status line (only Ian marks the phase done), a summary table per step with "new" and "Phase F cumulative" test counts, final patterns (the worker and pg-boss privilege plan, the fan-out, creating notifications in the event's transaction, the atomic claim, the retry table, the sweeper, the schedules), the mutation proofs, versions (pg-boss version added), things to know, open risks, changes to other docs, and the final suite results with every number filled in (3 runs in a row).

## 14. Doc updates to make in F1 (show Ian the diff before committing)

- `CLAUDE.md` section 2: the phase table row for F becomes "worker, notifications (fake senders), scheduled jobs"; section 8 `Run worker` gets the real command. Do not touch the status line.
- `docs/architecture.md`: section 2 (the worker process and how it uses tenant transactions), section 10 (replace the planned table with this design: events now and events later, channels, retries, dedupe, at-least-once), section 12 (`notification`, `error_event`, the new functions), section 13 (the three notification endpoints), section 16 (open items below).

## 15. Open items

1. Real adapters: Firebase push, Africa's Talking SMS, an email provider and sending domain (accounts needed; none exist yet). Until then login codes and pushes are fakes.
2. Notification events for orders, payments at the till and unmatched payments (Phase M and G), low-stock digest (needs reorder levels), subscription reminders (Phase G).
3. A busy shop with many flagged sales makes many notifications; throttling or grouping is not built.
4. Notifications are not in `snapshot` and `changes`; the app fetches them online.
5. Worker health and alerting, and Sentry (Phase H). A dead worker is not noticed by anything yet.
6. Push delivery is at least once (a duplicate push is possible after a crash).
7. The per-business fan-out is fine for hundreds of businesses; measure before thousands (Phase H).
8. Retention for `sync_command`, `audit_log` and `change_log` is only defined for `change_log` (30 days) and for notifications and error events (90 days). `sync_command` and `audit_log` retention is undecided.
9. Notification language (Swahili) and quiet hours are the phone's job or later.
10. Approval notifications go to the approver and owners; notifying a requester on refusal is not built.
