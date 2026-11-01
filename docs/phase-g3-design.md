# Phase G3 design: Orders from a website

Status: approved by Ian on 2026-11-01 (all six questions answered with the recommended defaults). This file is the source of truth for Phase G3. Where it disagrees with `docs/architecture.md` (section 9) or the phase table in `CLAUDE.md` section 2, this file wins, and you must update those to match (section 14). If something here is unclear or missing, stop and ask Ian. Do not guess.

Read `CLAUDE.md` first, then `docs/spike-results.md` and the results files of Phases A to G1 (the "Final patterns" and "Things to know" of each). The patterns proven there are the way to do things. Do not invent new ones.

Do not start until Ian has marked Phase G1 done in `CLAUDE.md` section 2. G2 (subscriptions) comes after G3 and does not block it.

## 1. Goal and scope

A shop can optionally let its own website send orders to the app. The owner turns the feature on and gets a secret **shop key**. The shop's website (its server, never a browser) sends each new order to a public endpoint with that key. The order appears in the app for staff with `orders.manage`, who get a push notification, can call the customer, press "Start sale", and later mark the order completed or cancelled. There is no stock reservation, no online payment, no customer accounts, and no stock sync to the website.

This endpoint is the first public, non-tenant entry point after login. Treat everything in it as untrusted input.

In scope:
- Shop key management (owner only).
- `POST /inbound/v1/orders` with the contract in section 5.
- Tables `shop_key`, `order_inbox`, `order_inbox_item`.
- Reading orders, and the `order.update` command.
- Notifications for a new order and a reminder, and a job that removes old customer details.

Out of scope (do not build): the website itself, stock reservation or stock sync to the website, online payment, customer accounts, WhatsApp or SMS ingestion, delivery tracking, an order that creates a sale automatically (the attendant starts the sale in the normal checkout), syncing orders through `snapshot` and `changes`, order reports, subscription gating (G2), refunds.

## 2. Decisions (all approved)

| Topic | Decision |
|---|---|
| Statuses | `NEW`, `IN_PROGRESS`, `COMPLETED` (linked to the sale), `CANCELLED`. |
| Items | Matched to the shop's pack types by barcode when possible; otherwise kept as written. The POS price always wins. |
| Updates | `order.update` commands (work offline). The orders list is online only. |
| Shop key | Shown once, stored only as a hash, regenerate invalidates the old key at once, looked up through a small `SECURITY DEFINER` function, rate limited per key and per IP. |
| Notifications | A new order pushes to staff with `orders.manage`; one reminder if still `NEW` after 15 minutes. |
| Customer data | Name and phone are blanked 12 months after the order was received. The order itself stays. |

## 3. Data model

Same rules as before: tenant tables have `id`, `business_id`, `created_at`, forced RLS with the `shop_only` NULLIF policy, composite foreign keys, unique `(business_id, id)`, explicit grants. Claude Code proposes the exact Prisma schema and SQL for each step and waits for approval before applying. Every new table, function and hand-written index goes into the exact inventories in `test/step4-migrations.spec.ts` and the grants inventory in `test/b5-hardening.spec.ts`.

**shop_key** (new, tenant)
- `key_prefix text not null` (8 characters, globally unique, the public part used to find the key), `key_hash text not null`, `created_by_membership_id`, `created_at`, `revoked_at timestamptz null`.
- Partial unique index `(business_id) WHERE revoked_at IS NULL`: one active key per business.
- `app_user`: SELECT, INSERT, UPDATE of `revoked_at` only. No DELETE.

**Key format and hashing.** A key looks like `sk_<prefix>_<secret>` where the secret is 32 random bytes in base64url. It is generated with the Node crypto random source. Because the secret has high entropy, store `HMAC-SHA256(secret, pepper)` (the same server pepper used for PINs), not scrypt: scrypt on every request of a public endpoint would let anyone burn the server's CPU. **This differs from `CLAUDE.md` rule 13, which says shop keys use the slow hash.** Show Ian this deviation and the reasoning, and on his approval change rule 13 to say: low-entropy secrets (PINs, passwords) use scrypt with the pepper; high-entropy random keys use HMAC-SHA256 with the pepper. Compare with a constant-time comparison.

**Function** (hand-written SQL, `SECURITY DEFINER`, owned by `identity_owner` like the `identity_*` functions, EXECUTE for `app_user` only, PUBLIC revoked)
- `identity_lookup_shop_key(p_prefix text)`: returns `business_id`, `key_hash` and whether the key is active, for an active key with that prefix; nothing otherwise. Add it to the exact function inventory. This is one of the short list of non-tenant lookups; note it in `architecture.md` section 3.

**order_inbox** (new, tenant)
- `source text` check in `website`; `external_id text` (1 to 64 characters); unique `(business_id, source, external_id)`.
- `customer_name text null` (at most 80), `customer_phone text null` (E.164, at most 16), `note text null` (at most 300), `anonymised_at timestamptz null`.
- `status text` check in `NEW`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`; `status_changed_at`; `status_note text null` (at most 200); `handled_by_membership_id` (composite foreign key, null while `NEW`); `completed_sale_id uuid null` (composite foreign key to `sale`; only when `COMPLETED`, check).
- `received_at timestamptz not null` (server Clock), `reminded_at timestamptz null`.
- `app_user`: SELECT, INSERT, and UPDATE of `status`, `status_changed_at`, `status_note`, `handled_by_membership_id`, `completed_sale_id`, `reminded_at` only. No DELETE. A trigger or policy makes `COMPLETED` and `CANCELLED` final (the pattern used for `voided_is_final`; show Ian the choice).
- Read index `(business_id, received_at DESC, id DESC)` and `(business_id, status, received_at)` for the reminder job.

**order_inbox_item** (new, tenant, append-only)
- `order_id`, `line_no` (1-based, unique per order), `code text` (at most 64), `name text` (at most 120), `quantity integer` (1 to 100,000), `unit_price numeric(14,2) null` (the website's price, informational), `pack_type_id uuid null` (composite foreign key; set when the code matched).

**Anonymising** (hand-written SQL, `SECURITY DEFINER`, the `change_log_prune` pattern with owner-only policies): `anonymise_old_orders(p_before timestamptz)` sets `customer_name`, `customer_phone`, `note` to null and `anonymised_at` for orders received before the cut-off that are not yet anonymised, across businesses, and returns the count.

**change_log:** none. Orders are not synced.

## 4. Shop key management

REST, online only, permission `shopkey.manage` (owners):
- `POST /v1/orders-inbox/key`: creates a key, or regenerates it. In one transaction the active key (if any) is revoked and a new one is created. Returns `201 { shop_key, prefix, created_at }`, the full `shop_key` shown **once**. The old key stops working immediately.
- `GET /v1/orders-inbox/key`: `{ active, prefix, created_at }`. Never the secret.
- `DELETE /v1/orders-inbox/key`: revokes the active key and turns the feature off. `204`.
- Audit `shopkey.created`, `shopkey.regenerated`, `shopkey.revoked` (prefix only, never the key).
- The key is a secret for the website's **server**. Do not enable CORS for the inbound route. The walkthrough and the app's setup text must say a browser must never hold the key.

## 5. The inbound endpoint

`POST /inbound/v1/orders`, header `X-Shop-Key`, JSON body. Public (no access token), not under the tenant interceptor. Contract (from `architecture.md` section 9, with the limits below):

```
{
  "external_id": "web-10492",
  "source": "website",
  "business_id": "<optional safety check>",
  "customer": { "name": "Amina W.", "phone": "+254712345678" },
  "items": [ { "code": "6001234", "name": "Maize flour 2kg", "qty": 2, "unit_price": 180 } ],
  "note": "Deliver after 5pm"
}
```

Steps, in this order:
1. Body size limit 64 KiB; content type JSON; otherwise `413` or `415`.
2. Rate limit per IP (on top of the global limit) before anything else.
3. Read `X-Shop-Key`, split the prefix, call `identity_lookup_shop_key`, compare the HMAC in constant time. An unknown prefix, a malformed key, a revoked key and a wrong secret all give the same `401` after the same amount of work (run a dummy comparison when the prefix is unknown). Never say which part was wrong.
4. Rate limit per key prefix (60 requests a minute) and a cap of 500 new orders per business per Nairobi day (`429 ORDER_LIMIT`, a constant in `AppConfig`).
5. If `business_id` is present and does not equal the key's business: `403`. (After the key is verified, so the answer reveals nothing to a stranger.)
6. Validate the body: `external_id` 1 to 64 characters, `source` exactly `website`, 1 to 50 items, `code` and `name` strings within the limits, `qty` an integer from 1 to 100,000, `unit_price` optional, a number or string with at most two decimals and within range (money is never handled as a JavaScript float in calculations; convert to whole cents exactly and reject anything that does not fit), customer name at most 80, phone normalised to E.164 with the existing phone normaliser (Kenyan numbers; invalid is `422`), note at most 300. Unknown extra fields are ignored; control characters are rejected. Failures are `422` in the standard error shape.
7. In one tenant transaction (`TenantRunner.run(businessId, ...)`, a system actor without a membership): insert the order with `INSERT ... ON CONFLICT (business_id, source, external_id) DO NOTHING RETURNING id`. No row means a duplicate: answer `200 { order_id, status }` with the existing order and change nothing. Otherwise match each item's `code` (normalised like barcodes in Phase B) to a pack type through `ProductsService` (one query for all codes), insert the items with `pack_type_id` where matched, create the notification rows (section 8), write the audit row if the audit service supports a system actor (otherwise do not audit, and tell Ian), and answer `201 { order_id, status: 'NEW' }`.

Responses: `201` new, `200` duplicate, `401` bad key, `403` business mismatch, `413`, `415`, `422`, `429`. The response body never echoes customer data.

Logs: route pattern, status, duration, business id after the key is verified. Never the key, the customer's name or phone, item names or the note.

## 6. Reading orders and the `order.update` command

**Reads** (`orders.manage`, active member on an active device, own business by RLS, `business_id` in a query is `422`)
- `GET /v1/orders?status=&limit=&cursor=`: newest first by `(received_at, id)`, the shared `SignedCursor` bound to the filter, `limit` default 20, max 100. Row: `id, source, external_id, status, received_at, customer_name, customer_phone, note, item_count, handled_by { membership_id, display_name }, completed_sale_id`. After anonymising, the customer fields are null.
- `GET /v1/orders/:id`: the same plus `items` (`code`, `name`, `quantity`, `unit_price`, and when matched the pack type id and its current names). Unknown id or another business's id: `404`.

**order.update** (a sync command, permission `orders.manage`): `{ order_id, status, sale_id?, note? }`.
- Allowed transitions: `NEW` to `IN_PROGRESS`, `NEW` to `COMPLETED`, `NEW` to `CANCELLED`, `IN_PROGRESS` to `COMPLETED`, `IN_PROGRESS` to `CANCELLED`. `COMPLETED` and `CANCELLED` are final. Anything else is `REJECTED / ORDER_STATUS_INVALID`. The same status again from the same member is an accepted no-op.
- One conditional `UPDATE ... WHERE id = $id AND status = <the expected current status>` so two staff cannot both take an order. If another member already moved a `NEW` order to `IN_PROGRESS`, the second is `REJECTED / ORDER_ALREADY_TAKEN`. Only the member who took an order, or a member with `sales.void` (managers and owners), can complete or cancel it (`PERMISSION_DENIED` otherwise).
- `sale_id` is optional on `COMPLETED`; if given it must be a completed sale the caller may see (the Phase E visibility rule: an attendant's own sales; otherwise `SALE_NOT_FOUND`).
- `status_note` is the optional `note` (at most 200). Unknown order or another business's: `ORDER_NOT_FOUND`.
- Audit `order.updated` (order id, from and to status, sale id), never the note or customer data.

## 7. Customer data

Customer name and phone are personal data. They are visible to staff with `orders.manage` (they need to call the customer), never in logs, notification data, audit or error events. Twelve months after `received_at`, a daily worker job (`orders.anonymise`) calls `anonymise_old_orders`, which blanks name, phone and note and sets `anonymised_at`. The order, its items and its status stay. Ian should confirm the retention period and the handling of customers' data with a lawyer (see open items).

## 8. Notifications and jobs (built on Phase F)

- `order.new`: created in the order's transaction for every active member with `orders.manage`; channels IN_APP and PUSH; dedupe key `order.new:<order id>`; data `{ order_id, item_count }` only.
- `order.stale`: if an order is still `NEW` 15 minutes after `received_at`, one reminder to the same recipients (IN_APP and PUSH); dedupe key `order.stale:<order id>`; `reminded_at` set. A scheduled job `orders.remind` runs every 5 minutes as a per-business fan-out, so the reminder arrives 15 to 20 minutes after the order. It skips orders that are no longer `NEW`.
- `orders.anonymise`: daily, 04:30 UTC comment 07:30 Nairobi, calls the anonymise function and logs the count.
- An order that cannot notify anyone (no staff with `orders.manage`) is still saved. Notifying never fails the endpoint: use the Phase F failure guard.
- The notification text and data hold ids and counts only.

## 9. Lessons from earlier phases that apply

- Do not run any test while a migration waits for review.
- Testing method as in `docs/phase-b-design.md` section 12 (new tests during a step; concurrency tests 5 times; gate with earlier Phase G3 files once; full suite once in the background; end of phase 3 runs in a row with real numbers). Consider asking Ian whether a "fast set" of tests should be used during steps.
- Tests of rate-limited routes need their own IPs, phones and keys; the in-memory limiter counts a whole burst arriving in one tick.
- Race tests must force the overlap (a held-open transaction and `lockWaiters()`).
- Rows written in one transaction share `created_at`; order through ids.
- Generated and hand-written objects need a migration and, where Prisma would drop them, the Prisma declaration. Do not run `prisma format` on the whole schema.
- Verify every mutation revert byte for byte. Search for leftover mutation markers before the final suite.
- Commit after each passing step and check `git status` is clean.
- Never weaken an earlier test. Report and ask.

## 10. Mistakes AI tends to make here (do not)

- Storing the shop key in clear text, logging it, returning it again after creation, or using a slow hash on a public route.
- A different answer or timing for an unknown prefix, a revoked key and a wrong secret.
- Taking the business id from the body. The key decides the business; a body `business_id` is only a check.
- Running the inbound transaction without the tenant setting, or reading orders across businesses.
- Trusting the website's price, quantity or text; floats for money; unbounded arrays or strings; storing HTML or control characters.
- Echoing or logging the customer's name, phone, address or note, or putting them in notifications.
- Making the duplicate check "select then insert" instead of `ON CONFLICT`.
- Letting two staff take the same order, or letting a completed order change.
- Enabling CORS on the inbound route, or accepting the key in a query string.
- Reserving stock, creating sales automatically, building online payment, or syncing stock to the website.
- Letting a failed notification fail the order.
- Installing a library without asking.

## 11. Build order

Each step ends with passing tests shown in the session and a commit. Present schema and SQL before applying and run no test until approved.

- **G3a: Schema, key management, lookup function, doc updates.** Sections 3, 4 and the rule 13 wording (Ian approves the deviation first).
- **G3b: The inbound endpoint.** Section 5.
- **G3c: Reads and `order.update`.** Section 6.
- **G3d: Notifications and jobs.** Sections 7 and 8.
- **G3e: Hardening and handover.** Randomized workload, logs, grants, walkthrough (`docs/phase-g3-walkthrough.md`), results (`docs/phase-g3-results.md`).

## 12. Test plan

Real Docker database, injectable `Clock`, genuinely concurrent concurrency tests.

**G3a**
1. Inventories (RLS tables, functions, policies, indexes) and the grants inventory list the new objects; `app_user` has no DELETE, only the listed UPDATE columns, and PUBLIC cannot run the new functions.
2. Database checks refuse: a status or source outside the list; over-long text; a quantity outside 1 to 100,000; `completed_sale_id` unless `COMPLETED`; `handled_by` missing on `IN_PROGRESS`; two active keys for one business (a revoked plus a new one is fine); a duplicate `(business, source, external_id)`; a duplicate prefix.
3. Composite keys: handler, sale, item pack type and key creator belong to the same business.
4. A completed or cancelled order cannot be updated again.
5. Key management: `POST` returns the key once and the stored value is not the key; the stored hash is the HMAC of the secret, and nothing in the database, logs or later responses holds the key; `GET` shows the prefix only; regenerate revokes the old key in one transaction (a forced failure leaves the old key active); `DELETE` revokes; only `shopkey.manage` (owners) may; audit rows hold the prefix only.
6. `identity_lookup_shop_key` returns the business and hash for an active key, nothing for revoked or unknown, works for `app_user` without a tenant setting.
7. Earlier suites pass (changed only mechanically).

**G3b**
1. A valid order: `201`, the order and items stored, `NEW`, `received_at` from the Clock; the same `external_id` again: `200` with the same `order_id` and nothing changed; 20 concurrent copies create one order (5 runs).
2. Keys: missing header, malformed key, unknown prefix, revoked key, wrong secret, and a key of another business all give the same `401` body and status; the work done is the same (count HMAC runs); a key from business A can never create an order in B; `business_id` mismatch is `403` only with a valid key; a matching `business_id` is accepted.
3. Validation: every limit in section 5 step 6 with an over-limit and a boundary case; money with three decimals, negative, NaN or a huge number; a phone that is not Kenyan or not normalisable; control characters; 51 items; a body over 64 KiB; wrong content type; each reports `422`, `413` or `415` in the standard error shape with nothing stored.
4. Matching: an item whose code equals a barcode of the shop (including the 12-digit leading-zero normalisation) is linked to its pack type; a code of another business's barcode is not; unmatched items are stored as written.
5. Rate limits: the per-IP, per-key and daily caps return `429` (with separate IPs and keys per test); the response never contains customer data.
6. Tenant isolation: identical external ids in two businesses are two orders.
7. Logs hold no key, name, phone, item name or note.

**G3c**
1. `GET /v1/orders` and `/:id`: only the caller's business; filters; newest first; paging with a signed cursor (tampered is `422`); `business_id` parameter `422`; matched pack type names present; unknown and other-business ids are `404`; a member without `orders.manage` (a field attendant) is `403`; suspended member and revoked device refused.
2. `order.update` transitions: every allowed path works; every other path is `ORDER_STATUS_INVALID`; final orders stay final; the same status from the same member is a no-op.
3. Two members taking one `NEW` order at once (forced overlap, 5 runs): exactly one `IN_PROGRESS`, the other `ORDER_ALREADY_TAKEN`.
4. Permissions: only the taker or a member with `sales.void` may complete or cancel; others `PERMISSION_DENIED`.
5. `sale_id` on completion: an attendant's own sale works; another member's sale is `SALE_NOT_FOUND`; a voided sale or another business's sale is rejected; a sale on a different order is allowed (not unique).
6. Audit `order.updated` once per change, in the same transaction; a forced failure after the audit insert leaves nothing; no note or customer data in the metadata.
7. Idempotent: the same command id twice updates once; a retry of a rejected command returns the same rejection.

**G3d**
1. A new order notifies each active member with `orders.manage` once (IN_APP and PUSH), in the order's transaction; none for suspended or invited members; a rolled-back order creates none; the duplicate `200` creates none; no staff with `orders.manage` still saves the order.
2. A notification failure never fails the inbound request (forced), and an `error_event` is written.
3. `orders.remind`: an order `NEW` for 15 minutes (Clock) is reminded once; running the job twice reminds once; an order that moved on is skipped; one business's failure does not stop others.
4. `orders.anonymise`: orders older than 12 months lose name, phone and note and get `anonymised_at`; newer ones keep them; items and status stay; running twice is safe; reads show nulls afterwards.
5. Schedules register once however many workers run.
6. Notification `data` holds ids and counts only (checked by key list).

**G3e**
1. Randomized, seeded and replayable (`G3_SEED`): two businesses, 150 operations (orders from a simulated website including duplicates, bad keys and bad bodies, staff taking, completing and cancelling orders, key regeneration mid-run, sales) through the real API with a worker running. At the end: every accepted external id has exactly one order; no order crossed businesses; statuses follow the allowed transitions; every `COMPLETED` order's sale belongs to the business; notifications are exactly one `order.new` per recipient per order; a regenerated key's old value never succeeded after the change. Three seeds.
2. Logs: marker names, phones, notes and a key; none appear in any log line, audit row, notification or `error_event`.
3. The grants inventory matches section 3.
4. The walkthrough runs as a test and once against the built API and a running worker on the test database.
5. The results file has no placeholders.

**Proof the tests catch mistakes.** Apply each temporarily, show the named test failing, revert and verify the revert:
1. Store the key in clear text: G3a test 5.
2. Different answer for an unknown prefix and a wrong secret: G3b test 2.
3. Duplicate check by select then insert: G3b test 1.
4. Take the business from the body: G3b test 2.
5. Skip the key's revocation check: G3a test 5 and G3b test 2.
6. Accept three decimals or a float price: G3b test 3.
7. Log the customer name: G3b test 7.
8. Remove the status condition from the take-order update: G3c test 3.
9. Let a completed order change: G3a test 4.
10. Remind every time instead of once: G3d test 3.
11. Skip the anonymising of the phone: G3d test 4.
12. Let a notification failure fail the request: G3d test 2.

## 13. Manual walkthrough (for Ian)

At the end of G3e, Claude Code writes `docs/phase-g3-walkthrough.md` (curl, plus the worker in a second terminal):

1. The owner turns the feature on, copies the shop key once, and sees that a second `GET` shows no secret. 2. A small script on the "website side" sends an order; the order appears for the attendant, who receives a push (fake) and an in-app notification. 3. The same order is sent again and nothing doubles. 4. A wrong key, a revoked key and a bad body are refused. 5. The attendant takes the order; a second attendant tries and is told it is taken. 6. The attendant makes a sale and completes the order with it. 7. A second order stays untouched for 15 minutes (the walkthrough moves it back in time with the SQL line given) and a single reminder arrives. 8. The owner regenerates the key; the old key stops working at once. 9. A second business sees none of it.

Ian runs it and writes down anything that surprised him.

## 14. Doc updates to make in G3a (show Ian the diff before committing)

- `CLAUDE.md` section 2: the phase row for G (G3 is built after G1); section 5 rule 13 (the high-entropy key wording, only after Ian approves).
- `docs/architecture.md`: section 3 (the new non-tenant lookup), section 9 (the final contract and limits), section 12 (the new tables), section 13 (the shop key and orders endpoints), section 16 (open items below).

## 15. Open items

1. Data protection: the retention period (12 months), the lawful basis for holding customers' names and phones, and registration with the Data Protection Commissioner need legal advice.
2. Orders are online only; a phone offline cannot list them. Syncing orders is a later decision.
3. No stock check or reservation: a website may sell goods the shop no longer has.
4. A leaked shop key lets someone create junk orders until the owner regenerates it (the daily cap and rate limits bound it).
5. The reminder arrives 15 to 20 minutes after the order; a delayed job could make it exact.
6. WhatsApp or SMS ingestion, delivery tracking and order reports are not built.
7. Orders could be gated by the subscription state (G2).
8. Whether the website's prices should be compared with the POS price (the POS price wins today and the difference is not shown).
