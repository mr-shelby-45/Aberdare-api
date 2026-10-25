# Architecture

This is the agreed design for the Shop POS backend. It is the source of truth. If code and this file disagree, stop and ask which one is right, then fix the wrong one.

Markers used below:
- **DECIDED**: agreed with Ian. Do not change without asking.
- **DEFAULT**: a sensible choice made while writing this file. Use it, but tell Ian if it causes a problem.
- **OPEN**: not decided. Ask before building.

Table of contents: 1 Product, 2 System overview, 3 Tenant isolation, 4 Authentication, 5 Offline sync, 6 Stock, 7 Barcodes and search, 8 M-Pesa payments, 9 Orders from a website, 10 Notifications, 11 Errors, logging, time, 12 Data model, 13 API endpoints, 14 Permissions, 15 Hosting, 16 Open items.

---

## 1. Product

**DECIDED.** A subscription POS and inventory app for Kenyan shopkeepers, wholesalers and warehouses, sold through the Play Store and App Store.

- One app. At signup the owner picks a business type: Retail, Wholesale or Warehouse. The types are independent modules, not layers on top of each other.
- A hybrid retail plus wholesale model also exists for one specific client (stock received in cartons or pieces, sold in cartons or pieces, one ledger, one set of payments).
- Each business is a tenant. One owner per business is typical. One owner may have several locations (shops) in one subscription.
- Subscription: free trial (14 to 30 days, **OPEN** exactly), then paid, with a grace period. Renewal reminders by SMS and push, payment by M-Pesa prompt. Tiers and prices are **OPEN**.
- Users: smartphones with reliable data, but the shop must keep selling when the internet drops.
- Customers do not have accounts. No customer credit, balances or statements. Everyone pays at the time of sale.
- Currency: KES only.

## 2. System overview

```
Phone app (Flutter, offline first, local SQLite)
   |  HTTPS, JSON, /v1
   v
API process (NestJS + Fastify)  ----->  PostgreSQL  <-----  Worker process (pg-boss jobs)
   ^        ^                                                   |
   |        |                                                   +--> SMS (Africa's Talking)
   |        +-- Safaricom Daraja callbacks (webhooks)            +--> Push (Firebase Cloud Messaging)
   +-- Website orders (optional, per shop key)                  +--> Daraja (reconciliation, later STK push)
```

- Two processes from one codebase: `main.ts` (API) and `worker.ts` (jobs). They share the database.
- The API never calls SMS, push or Daraja inside a request transaction. It writes a row; the worker acts on it.
- Errors: Sentry on the server, Crashlytics on the phone. Details in section 11.

## 3. Tenant isolation (row-level security)

**DECIDED.** Every business-owned table has `business_id uuid not null`. Postgres RLS makes the database refuse cross-tenant reads and writes even if the code forgets a filter.

Database roles:
- `migrator`: owns the tables, runs migrations. Used only by migration commands.
- `app_user`: used by the API and worker. Not the owner. `NOBYPASSRLS`. Has only the table privileges it needs.
- `identity_owner` (Phase A): NOLOGIN, not BYPASSRLS. Owns only the identity lookup functions of the non-tenant access path below.

Policy pattern, applied to every tenant table:

```sql
ALTER TABLE sale ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON sale
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
```

Why `NULLIF(..., '')`: after a transaction ends, the setting can read as an empty string, and casting `''` to uuid throws an error. With NULLIF an unset tenant becomes NULL and matches no rows. That is the safe failure.

Per-request flow:
1. A guard verifies the access token and puts `{ userId, businessId, membershipId, deviceId }` into request context (AsyncLocalStorage).
2. An interceptor opens one Prisma interactive transaction for the request.
3. First statement: `SELECT set_config('app.business_id', $1, true)` (third argument `true` = transaction-local).
4. Repositories receive the transaction client from the context and run all queries on it. They never import the global Prisma client.
5. Commit or roll back at the end of the request.

As built in the spike (step 1): `TenantRunner.run(businessId, fn)` in `src/database/tenant.ts` does steps 2 to 5 with Prisma 7 and the pg driver adapter. Repositories call `currentTx()`, which throws `TENANT_CONTEXT_MISSING` outside a tenant transaction; nested `run()` calls are refused. The interceptor in step 2 is not built yet: it needs the guard and token from section 4 and will call `TenantRunner.run()`. `withSavepoint()` in the same file is used when a failure must be recorded inside the transaction (section 5). Schema-level privileges for app_user live in a migration, not only in the Docker init script, because a fresh database or `prisma migrate reset` only gets what migrations contain (step 4).

**DECIDED (Phase A):** the people table is called `person`. `app_user` means only the database login role.

**Non-tenant access path (DECIDED, Phase A; details in `docs/phase-a-design.md` section 5).** Login must find a person, device or refresh token before any business is known, but RLS shows nothing without a tenant.
- A third role, `identity_owner` (NOLOGIN, not BYPASSRLS), owns a small set of `SECURITY DEFINER` functions. Each takes one exact key, returns only the columns it needs for at most a handful of rows, and cannot list or search. They use `SET search_path = pg_catalog, public`, no dynamic SQL, `REVOKE EXECUTE ... FROM PUBLIC` and `GRANT EXECUTE ... TO app_user`.
- On each table the functions touch (`person`, `membership`, `device`, `refresh_token`, `business`), an extra policy `TO identity_owner` lets the functions through. FORCE RLS applies to owners too, so this policy is what makes them work. `identity_owner` gets the minimum privileges, by column where possible.
- `app_user` itself gets no cross-tenant SELECT on anything.
- `identity_owner` is created in the Docker init script and by hand on the real host, like the other roles. A migration that needs it fails with a clear message if it is missing.

Non-tenant tables:
- `person` (one human across all businesses: phone, email, password). RLS enabled: `app_user` may SELECT a person only when that person has a membership in the current business, and has no INSERT, UPDATE or DELETE; writes go through the identity functions.
- `otp_challenge` (login and signup codes). No RLS; it holds nothing tenant-related.
- The shop key lookup (Phase G) will use the same kind of function.

**Business RLS (DECIDED, Phase A):** `business` gets RLS with the policy `id = NULLIF(current_setting('app.business_id', true), '')::uuid` for USING and WITH CHECK. Signup generates the new business id on the server, sets it as the tenant, then inserts.

Constraints:
- Transactions must stay short (Prisma's default interactive transaction timeout is about 5 seconds). No network calls inside them.
- Background jobs set the tenant the same way for each business they process.
- Foreign key checks ignore RLS, so a plain foreign key would accept a row that points at another business's row. **DECIDED (spike step 2):** every reference between tenant tables is a composite foreign key, `(business_id, x_id) REFERENCES x(business_id, id)`, backed by a unique `(business_id, id)` index on the referenced table.

## 4. Authentication

**DECIDED (revised for Phase A; full detail in `docs/phase-a-design.md` sections 6 to 10).** Phone numbers are normalised to E.164 and unique on `person.phone`. One person may have memberships in several businesses; each business has exactly one owner.

**Owner**: signs up with phone and email, both proven by a code (SMS and email), then sets a password and a 4-digit PIN. Logs in on a new phone or after reinstall with **email and password**. Password reset by email code revokes all of that person's refresh tokens.

**Staff (attendants and managers)**: identified by phone. The owner adds a staff member in the app:
1. The server upserts the `person` (if the phone is new) and creates a `membership` for this business with status `INVITED`, the chosen role preset and extra permissions.
2. The server generates a 6-digit temporary PIN, shown to the owner once. Only its hash is stored. It works once, expires in 3 days, and 5 wrong tries kill it.
3. First login on the staff phone: `POST /auth/first-login` with phone and temporary PIN returns a short-lived setup token and sends an SMS code. `POST /auth/staff/activate` with the code, a new 4-digit PIN and the device details sets the PIN, marks the phone verified, makes the membership `ACTIVE` and registers the device. (This replaces the earlier `set-pin` and `verify-device` endpoints.)

**Devices and daily login**: registering a device issues a random **device secret** (32 bytes), shown to the app once and stored only as a SHA-256 hash. Daily login is `device_id` + `device_secret` + PIN. The server checks the secret in constant time, then the membership's PIN, status and locks.

**Hashing**: Node's built-in `crypto.scrypt` with a server-side pepper for passwords and PINs; HMAC-SHA256 with the pepper for codes; SHA-256 for high-entropy secrets (refresh tokens, device secrets). No argon2 or bcrypt. Lockouts: 5 wrong PINs lock the membership for 15 minutes, 10 in a row need a reset; 5 wrong passwords lock the person for 15 minutes. Rate limit by IP on every public auth route.

**As built (A3, decided with Ian):** during a password lockout every password, right or wrong, gets the same `INVALID_CREDENTIALS` as an unknown email (a dummy hash still runs), so a lock is never a guessing oracle and never reveals that an email exists; the message hints to wait 15 minutes. Password login therefore never returns `ACCOUNT_LOCKED`. A PIN lock answers `423 ACCOUNT_LOCKED` without checking the PIN (only a holder of the device secret gets that far), with `Retry-After` for the 15-minute lock. "Locked for good" is `pin_failed_count >= 10`, cleared by an owner reset (staff) or a password login (owner). Logout revokes every live refresh token of the membership on that device.

**As built (A5):** password reset is two calls. `POST /auth/password/forgot` always answers 202 with the same body; only an email that has a password gets a code (a send limit is silent too). `POST /auth/password/reset { email, code, new_password }` hashes the new password first (same work for every email), verifies the code, then `identity_reset_password` uses up the code, sets the hash and clears the password lockout in one function. Every failure (unknown email, wrong, expired or used code) answers `400 OTP_INVALID`: a separate "expired" answer would reveal which emails have accounts, because anyone can request a code and wait. After the reset, the person's refresh tokens are revoked in each business they belong to, one short transaction per business, each with a `password.reset` audit row. Devices and PINs are not touched.

**Tokens**: a 15-minute JWT access token (`@nestjs/jwt`) carrying only `sub` (person id), `mid` (membership id), `bid` (business id) and `did` (device id). No permissions or names. A 30-day refresh token (32 random bytes, stored as a SHA-256 hash, tied to a membership and device) rotates on every use; reusing a used token revokes its whole family. Logging out, suspending a membership or revoking a device revokes its refresh tokens.

**Shared tablet**: the owner can mark a device as a "shared shop device" (Settings, Devices). A `device_membership` row links the device to each staff member allowed on it. The app shows a "Who is selling?" lock screen with display names (from `GET /auth/device-members`, authenticated by the device secret) and a PIN pad. The PIN is checked for the chosen membership on that device.

Reinstall is treated as a new device: log in again, then a full snapshot sync rebuilds the local data.

## 5. Offline sync

**DECIDED.** The phone keeps a local SQLite database (via Drift, encrypted) and never writes sales directly to the server.

**Writes**: the phone records "commands" in an outbox, each with a phone-generated UUID, a type, a payload, and `occurred_at`. It sends batches to `POST /v1/sync/commands`.

The server, for each command:
- Checks the command UUID in `sync_command`. If seen before, returns the stored result (idempotent). The uniqueness is enforced by a database constraint, not by a check.
- Checks the permission for that command type.
- Runs the handler in its own transaction (or savepoint) so one bad command does not undo the others.
- Returns per command: `accepted`, `flagged` (accepted but needs the owner's attention, for example an oversell), or `rejected` (with a reason code).

As built in spike step 3 (**DECIDED** with Ian):
- Each command runs in its own tenant transaction. Its first write claims the row: `INSERT INTO sync_command ... ON CONFLICT (business_id, command_id) DO NOTHING RETURNING id`. No row back means it was already processed, and the stored result is returned. A concurrent duplicate waits on the unique index until the first transaction ends.
- The handler runs inside a savepoint. An expected rejection (validation, permission, business rule, a reference to something that does not exist) rolls back to the savepoint and is stored as `rejected`, so a re-send gets the same answer.
- An unexpected error rolls back the whole transaction, command row included. Nothing is stored, the response says `failed` (`INTERNAL_ERROR`), and the phone's retry processes the command again.
- Once committed, an outcome cannot change: a restrictive RLS policy only allows UPDATE while the row is `PROCESSING`, and app_user has no DELETE.
- A command without a valid UUID cannot be stored; it is rejected (`VALIDATION_FAILED`) without a row.

Command types and required permission:

| Command | Permission |
|---|---|
| sale.create | sales.create |
| payment.attach | payments.confirm |
| stock.receive | stock.receive |
| stock.adjust | stock.adjust |
| stock.convert | stock.convert (manager or owner only) |
| stock.count | stock.count |
| product.create, product.update, pack_type.upsert, barcode.add, barcode.remove | products.edit (plus costs.view for any command that sets or changes `cost_price`) |
| order.update | orders.manage |

As designed for Phase B (`docs/phase-b-design.md` section 5; `POST /v1/sync/commands` is built in Phase B, Phase D adds only snapshot and changes):
- Body `{ commands: [ { command_id, type, occurred_at, payload } ] }`, at most 100 commands, body limit 1 MB. Processed in order; the response lists one result per command in the same order: `{ command_id, status (ACCEPTED, FLAGGED, REJECTED, FAILED), reason?, result? }`. `FAILED` is an unexpected error, safe to retry.
- `occurred_at` more than 24 hours in the future is rejected (`OCCURRED_AT_INVALID`); any past time is accepted. `sync_command` stores both `occurred_at` (phone) and `received_at` (server).
- IDs of new things are phone-generated UUIDs. Omitted fields mean "unchanged"; `null` clears an optional field.
- **Per-command transactions.** `TenantInterceptor` normally runs the whole request in one tenant transaction, and nested `TenantRunner.run()` is refused. The sync route is marked (for example `@OwnTransactions()`): the interceptor still loads the membership and device in a short tenant transaction, applies the same status checks and builds the effective permissions, then lets the handler run outside any transaction so each command gets its own. The dispatcher checks the permission per command and passes the actor explicitly to `AuditService.record`. This marker is for this route only.

**Reads**:
- `GET /v1/sync/snapshot`: full data for the business (products, barcodes, pack types, stock, recent sales), paged. Used on first login and after reinstall.
- `GET /v1/sync/changes?cursor=`: changes since a cursor, taken from a `change_log` table. The server re-reads a small overlap window before the cursor and the phone dedupes by id, so nothing is missed when transactions commit out of order.

**Conflicts**: the shop already sold the goods, so the server never refuses a real sale because stock ran out on paper. It accepts the sale, lets the balance go negative if necessary, marks the command `flagged`, and shows it to the owner. Rejection is only for invalid or unauthorised commands.

Unsynced outbox sales are lost if the app is uninstalled. The app warns about this and shows "last synced". Android auto-backup is disabled for the local database.

## 6. Stock

**DECIDED.**

Ledger plus cached balance:
- `stock_movement` is append-only: one row per change, per business, location and pack type. Never updated or deleted. Corrections are new rows.
- `stock_balance` holds the current quantity per (business, location, pack type). It is updated in the SAME transaction as the movement.
- A nightly job checks that each balance equals the sum of its movements and writes an `error_event` if not.

Pack types: a product can have several pack types (for example `piece`, `carton_of_24`). Each has its own stock pool. Stock received as cartons is sold as cartons. Stock received as pieces is sold as pieces. Loose pieces are never sold at the wholesale price.

Break bulk: when piece stock runs out, a carton can be converted to pieces. This is one recorded event (`stock_conversion`) that links two ledger rows: minus 1 carton, plus N pieces, in one transaction. Requires `stock.convert` (managers and owners). An attendant can trigger a conversion on their phone only if a manager or owner enters their PIN there; the conversion records `approved_by`.

Atomic decrease, the pattern to use (single statement, no read-then-write):

```sql
UPDATE stock_balance
SET quantity = quantity - $1
WHERE business_id = $2 AND location_id = $3 AND pack_type_id = $4
  AND quantity >= $1
RETURNING quantity;
```

Zero rows returned means insufficient stock. Two modes exist:
- **Strict mode** (stock.adjust decreases, stock.convert): if zero rows, reject with `STOCK_INSUFFICIENT`.
- **Sale mode** (sale.create from sync): the sale already happened, so allow the balance to go below zero, still in one atomic statement (`quantity = quantity - $1` without the guard), insert the movement, and flag the command if the result is negative.

In both modes the movement insert and the balance update happen in one transaction, and the balance always equals the sum of movements.

As built in spike step 2: sale-mode decreases and receipts use one atomic upsert, `INSERT INTO stock_balance ... ON CONFLICT (business_id, location_id, pack_type_id) DO UPDATE SET quantity = stock_balance.quantity + EXCLUDED.quantity RETURNING quantity`, so a missing balance row is created in the same statement. Strict decreases use the conditional `UPDATE` above; a missing row means zero rows, so `STOCK_INSUFFICIENT`. Isolation level: READ COMMITTED (the default). `stock_movement` and `stock_conversion` are append-only through grants (app_user has SELECT and INSERT only).

Level of tracking: counts only. Lot numbers and individual box serials are out of scope.

## 7. Barcodes and search

**DECIDED.**

- `product_barcode` maps many barcodes to one product and pack type. A barcode is unique per business.
- Cartons: scan the barcode already printed on the carton once to register it. No label printing for now.
- For items with no barcode, the shop may use its own in-store EAN-13 codes in the 20 to 29 prefix range (label printing is later).
- Scanning with the phone camera is the default. An optional Bluetooth keyboard-style scanner works because it types the code into the app like a keyboard.
- Search runs on the phone (SQLite full-text search), limited to the shop's own data. Scanning a barcode is an exact-match search. If nothing is found, offer "Add as new product".
- Cost prices are hidden from search results and screens unless the user has `costs.view`.
- Server search `GET /v1/products?q=` is allowed, with a trigram index as an optional addition later.

As designed for Phase B (`docs/phase-b-design.md` sections 2, 4 and 6):
- One barcode maps to exactly one pack type per business (assumes cartons carry their own code; open item 21). Barcodes are added and removed by command, and a removal is logged. The barcode of an archived product stays reserved.
- A barcode is text, never a number (leading zeros matter). It matches `^[A-Za-z0-9._-]{4,48}$`. Normalisation on every write and lookup: trim; a 12-digit numeric code gets a leading `0` (UPC-A equals EAN-13 with a leading zero). Check digits are not validated and case is not changed. 14-digit carton codes (ITF-14) are accepted as they are.
- Server search: exact barcode match (normalised), then exact SKU, then names starting with `q`, then other names containing `q`. Name matching is `name ILIKE '%...%'` (uses the trigram index `product_name_trgm_idx`), with `%`, `_` and `\` escaped, parameters only. `q` is at least 2 characters, at most 50 results, no paging. Archived products are hidden unless `include_archived=true`. Every read is limited to the caller's business by RLS; no endpoint takes a business id.
- `cost_price` is omitted from responses (the key is absent, not null) unless the caller has `costs.view`.

## 8. M-Pesa payments

**DECIDED approach, details need verification against the official Daraja docs.**

Every business must use its own Safaricom till number. Verification comes in levels:
1. **Manual match** (first version): the attendant enters or confirms the M-Pesa message details. The payment is saved as `unverified`.
2. **C2B notifications from Daraja per business** (next): Safaricom sends a callback when money arrives at the till; the server matches it to the sale and marks it `verified`.
3. **STK push** (later, not now).

Callback security (Safaricom callbacks are not signed):
- HTTPS only.
- A secret unique token in the callback URL path.
- IP allowlist of Safaricom addresses. Community-documented ranges are 196.201.212.0/24, 196.201.213.0/24 and 196.201.214.0/24 (plus hosts 196.201.214.200 and 196.201.212.127). **These are unconfirmed and must be confirmed with Safaricom.** Start in log-only mode (log non-matching IPs but do not block), then enforce. The real client IP behind the load balancer requires Fastify `trustProxy`.
- Idempotency on `trans_id` and `CheckoutRequestID` (unique constraints). A duplicate callback returns 200 and does nothing.
- A reconciliation job uses the Daraja Transaction Status API to check unconfirmed or large payments and to catch dropped callbacks.

Unmatched payments (money received, no sale) appear for the owner after about 10 minutes.

Do not invent Daraja field names. Read the docs or ask.

## 9. Orders from a website (optional slot)

**DECIDED.** Think of it as an optional Ethernet port: off by default, useful for the clients who want it.

- A separate website, built by Ian per client, keeps its own catalogue and images. It only sends an order notice to this API.
- The owner turns the feature on in the app and gets a **shop key** (shown once, stored hashed, can be regenerated). The key identifies the business.
- Endpoint: `POST /inbound/v1/orders` with header `X-Shop-Key`. The body may contain an optional `business_id`. It is only a safety check: if it does not match the key's business, respond 403.
- Orders appear in an Orders tab and trigger a push to staff with `orders.manage`. The attendant sees the customer's details, can call or open WhatsApp (wa.me link), and presses "Start sale", which opens the normal checkout. The POS price wins.
- No stock reservation, no stock sync to the website, no online payment, no customer accounts. WhatsApp orders are typed in by hand.

Contract:

```
POST /inbound/v1/orders
X-Shop-Key: <the shop's key>
{
  "external_id": "web-10492",
  "source": "website",
  "customer": { "name": "Amina W.", "phone": "+254712345678" },
  "items": [ { "code": "6001234", "name": "Maize flour 2kg", "qty": 2, "unit_price": 180 } ],
  "note": "Deliver after 5pm"
}
```

Responses: 201 new order, 200 duplicate `external_id` (idempotent), 401 bad key, 403 business mismatch, 422 validation error, 429 rate limit.

## 10. Notifications

**DECIDED.** A notification row is written in the same transaction as the event that causes it. The worker sends it, retries 3 times with growing delays, marks dead push tokens, and writes an `error_event` on final failure. The `notification` table needs: type, recipient membership, channel, payload, status, attempts, last error, sent time.

| Event | Who | Channel |
|---|---|---|
| New online order | staff with orders.manage | push |
| Order still new after 15 minutes | same | push (once) |
| Payment arrived at till | staff with payments.confirm | push |
| Payment unmatched for about 10 minutes | owner | push |
| Flagged sale (oversell) | owner | in-app |
| Carton broken into pieces | owner | in-app |
| Low stock | owner | daily digest |
| Subscription ending (7, 3, 1 days) | owner | SMS and push |
| Device has not synced for days | owner | in-app |
| Login code | user | SMS |

Retention for notifications: 90 days.

## 11. Errors, logging, time

**DECIDED.**

Error response shape (all errors, every endpoint):

```json
{ "error": { "code": "STOCK_INSUFFICIENT", "message": "Only 2 left", "requestId": "req_8f3k2", "timestamp": "2026-10-23T15:42:10.123Z" } }
```

- `code` is a stable machine-readable string. `message` is safe to show to a user. Never put internal details, SQL, or stack traces in the response.
- Use one global exception filter. Unexpected errors return `INTERNAL_ERROR` and are reported to Sentry.

Structured logs (JSON, one line per event): UTC timestamp, request ID, business ID, membership ID, device ID, route, status, duration, error code. Never log the items listed in CLAUDE.md rule 12.

As built in spike step 5: Fastify's built-in logger (pino) writes one line per request with `time` (ISO UTC), `requestId`, `method`, `route` (the route pattern, never the URL), `status` and `durationMs`. Business, membership and device IDs join the line once auth exists. Request IDs are generated by the server (`req_` plus 12 random characters), returned as `X-Request-Id`, and never taken from the client. Request bodies are never logged; sensitive field names are redacted and phone numbers masked as a backstop. Unexpected errors are logged without their message (it can contain the data being written). Sentry is not added yet (needs Ian's approval of its SDK); until then 500s are only logged. HTTP settings (`TRUST_PROXY`, webhook allowlist and mode, rate limit) are validated at startup. The rate limit is kept in process memory, so with several API instances each counts separately (open risk; Redis is ruled out, a Postgres-backed store is the likely fix).

Tables:
- `error_event`: server-side errors for support. Kept 90 days.
- `audit_log`: who did what and when (sales voided, stock adjusted, staff changes, conversions, payment approvals). Kept indefinitely. Append-only.

As built in Phase A5: `audit_log` is a tenant table (forced RLS, `shop_only` policy) where `app_user` has SELECT and INSERT only, so history cannot be rewritten through the API. Checks: action looks like `staff.suspended`, target type is one lowercase word, metadata is a JSON object. `AuditService.record({ action, targetType, targetId, metadata, actorMembershipId? })` writes in the current tenant transaction, so a rolled-back action leaves no row. It refuses metadata keys that look like secrets or contact details (pin, code, token, secret, password, hash, phone, email, key). The actor defaults to the request's membership; system events (PIN lockout, refresh-token reuse, password reset) pass `null`. The caller's IP and the acting membership come from a request context that `TenantInterceptor` opens for every route. Events recorded in Phase A: `business.signed_up`, `device.registered` / `revoked` / `shared_changed` / `member_added` / `member_removed`, `staff.created` / `updated` / `suspended` / `reactivated` / `removed` / `pin_reset`, `pin.locked`, `refresh_token.reuse_detected`, `password.reset` (one row in each business of the person). How long to keep IP addresses is still open (section 16).

Time: all timestamps in UTC. Phone events carry `occurred_at` (phone clock) and the server records `received_at`. If they differ by more than about 5 minutes, flag clock skew to the user. Display in Africa/Nairobi.

## 12. Data model

Table list (exact columns are designed during the build and reviewed by Ian before the first migration of each group):

| Table | Purpose |
|---|---|
| business | the tenant: name, type (`RETAIL`, `WHOLESALE`, `WAREHOUSE`), till number, subscription state, settings. RLS on its own `id` from Phase A |
| location | a shop or warehouse of a business: name, default flag (one per business, created at signup), archived time |
| person | one human across all businesses: phone (unique, E.164), verified flags, email (unique, nullable), password hash (owners only), login lockout. Not tenant-owned; read through the identity functions (section 3) |
| membership | a person's role in one business: display name, role preset, extra permissions, status (`INVITED`, `ACTIVE`, `SUSPENDED`, `REMOVED`), PIN hash, temporary PIN hash and expiry, lockout counters. Exactly one `OWNER` per business |
| device | a registered phone: name, platform, device secret hash, shared flag, status (`ACTIVE`, `REVOKED`), push token (Phase F), last seen and last sync |
| device_membership | which memberships may sell on a shared device |
| refresh_token | rotating refresh tokens: membership, device, family, token hash, expiry, used and revoked times |
| otp_challenge | SMS and email codes: channel, target, purpose, code hash, expiry, attempts, verified and consumed times. Not tenant-owned, no RLS |
| product | name (1 to 120 characters, not unique), SKU (unique per business when present), archived time. No categories and no stock columns (Phase B) |
| pack_type | piece, carton of N, and so on: name and units per pack (both unique per product, 1 to 10000 units, at most one base unit), sell price and optional cost price (`NUMERIC(14,2)`, never negative), archived time. 1 to 6 per product |
| product_barcode | barcode (text) to product and pack type, unique per business; composite key to `pack_type (business_id, product_id, id)` so it cannot point at another product's pack type. The only Phase B table where rows are deleted |
| stock_movement | append-only ledger |
| stock_balance | cached balance per business, location, pack type |
| stock_conversion | links the two ledger rows of a break-bulk |
| sale, sale_item | a sale and its lines |
| payment | payment attached to a sale, verified flag, method |
| mpesa_transaction | raw M-Pesa notifications, unique on trans_id |
| order_inbox, order_inbox_item | orders from a website |
| sync_command | every received command: UUID unique, result, status, `occurred_at` (phone) and `received_at` (server) |
| change_log | what changed, for `sync/changes` |
| subscription | plan, state, trial end, grace end, payments |
| notification | see section 10 |
| audit_log | see section 11. Built in Phase A: actor membership, action, target type and id, metadata (never secrets), ip, occurred_at. Append-only |
| error_event | see section 11 |

Standard columns on tenant tables: `id uuid`, `business_id uuid`, `created_at timestamptz`, `updated_at timestamptz`. Primary keys are UUIDs. Records created offline use phone-generated UUIDs.

Hand-written SQL migrations are required for: RLS policies, the change-log triggers, trigram indexes, and partial or unique indexes Prisma cannot express. Keep each of those in its own clearly named migration file.

As built in the spike (columns approved by Ian per step):
- Tables that exist: `business` (no RLS yet), `product` (with `sku`), `location`, `pack_type`, `stock_balance`, `stock_movement`, `stock_conversion`, `sync_command`, `change_log`. Columns were kept to what each spike step needed; the rest of each table (prices, categories, `reason` on movements, `approved_by` on conversions and so on) is added with the feature that uses it.
- Exceptions to the standard columns: append-only tables (`stock_movement`, `stock_conversion`, `sync_command`, `change_log`) have no `updated_at`. `change_log.id` is a `BIGSERIAL`, not a UUID, because it is the sync cursor and must grow.
- `change_log` (`id`, `business_id`, `table_name`, `row_id`, `operation`, `changed_at`) is written only by triggers (`product_change_log` so far, `SECURITY INVOKER`).
- Special indexes: GIN trigram `product_name_trgm_idx` (declared in `schema.prisma` too, so Prisma does not drop it) and the partial unique `pack_type_one_base_unit_per_product` (one pack type with `units_per_pack = 1` per product).
- Every reference between tenant tables is a composite foreign key (section 3).

As designed for Phase B (`docs/phase-b-design.md` section 3): `location` gains `is_default` (partial unique index, one default per business) and `archived_at`; `product` gains `archived_at` and a btree index on `(business_id, name, id)` for paging; `pack_type` gains `sell_price`, `cost_price`, `archived_at` and the uniques above; `product_barcode` is new; `change_log` triggers are extended to `pack_type`, `product_barcode` (including deletes) and `location`. Products, pack types and locations are archived, never deleted. Grants: `location` SELECT, INSERT, UPDATE; `product_barcode` SELECT, INSERT, DELETE.

## 13. API endpoints

All under `/v1`, JSON, access token required unless stated.

- **auth** (no token unless stated; Phase A, see `docs/phase-a-design.md` section 6):
  - owner signup: `POST /auth/signup/start`, `POST /auth/signup/verify`, `POST /auth/signup`
  - owner login: `POST /auth/login` (email and password; may answer `requires_selection` with a selection token)
  - password reset: `POST /auth/password/forgot`, `POST /auth/password/reset`
  - staff first login: `POST /auth/first-login`, `POST /auth/staff/activate`
  - daily login: `POST /auth/pin` (device id, device secret, PIN)
  - shared tablet: `GET /auth/device-members` (device id and secret in headers)
  - tokens: `POST /auth/refresh`, `POST /auth/logout` (token required)
- **me** (token): `GET /me`
- **business**: `GET/PATCH /business`
- **locations** (Phase B): `GET /locations` (any active member; active only, `include_archived=true` for the owner list), `POST /locations` and `PATCH /locations/:id` (rename, archive, restore; `locations.manage`). The only REST writes for catalogue-like data; the default location and the last active location cannot be archived
- **catalogue reads** (Phase B, any active member): `GET /products?q=&limit=&cursor=&include_archived=`, `GET /products/:id`, `GET /products/by-barcode/:code`. Catalogue writes are sync commands only, never REST
- **staff** (`staff.manage`): `POST /staff` (returns the temporary PIN once), `GET /staff`, `PATCH /staff/:id`, `POST /staff/:id/reset-pin`, `POST /staff/:id/suspend`, `POST /staff/:id/reactivate`, `DELETE /staff/:id` (status `REMOVED`, never a hard delete)
- **devices** (`devices.manage`): `GET /devices`, `PATCH /devices/:id` (name, shared flag), `DELETE /devices/:id` (revoke), `POST /devices/:id/members`, `DELETE /devices/:id/members/:membershipId`
- **reads**: `/stock`, `/stock/movements`, `/sales`, `/payments/pending`, `/orders`, `/reports/*`, `/audit-log`, `/notifications`, `/subscription`
- **sync**: `POST /sync/commands` (Phase B), `GET /sync/snapshot`, `GET /sync/changes?cursor=` (Phase D)
- **manager actions**: `POST /sales/:id/void`, `POST /payments/:id/approve`
- **orders**: `PATCH /orders/:id`; `POST /orders-inbox/key` (create or regenerate the shop key)
- **subscription**: `POST /subscription/pay`
- **public inbound** (shop key, not token): `POST /inbound/v1/orders`
- **webhooks** (secret in path, IP allowlist): `POST /webhooks/mpesa/:secret/...` (exact Daraja routes to be verified)
- **health** (no token): `GET /health`

## 14. Permissions

**DECIDED.** Three presets. The owner can add individual permissions to a person, except `stock.convert`, which only managers and owners hold.

| Permission | Attendant | Manager | Owner |
|---|---|---|---|
| sales.create, payments.confirm, stock.view, orders.manage | yes | yes | yes |
| products.edit, stock.receive, stock.adjust, stock.convert, stock.count | no | yes | yes |
| sales.void, payments.approve, reports.view | no | yes | yes |
| costs.view, staff.manage, devices.manage, subscription.manage, shopkey.manage, locations.manage | no | no | yes |

Reading locations and the catalogue needs no permission beyond an active membership. `costs.view` covers reading and writing cost prices. `locations.manage` is new in Phase B (owner preset only, grantable like the others).

Permissions are **read live from the database on every request**, never stored in the token (Phase A decision). Inside the tenant transaction, the `TenantInterceptor` loads the membership and device, refuses unless both are `ACTIVE`, computes effective permissions (role preset plus `extra_permissions`) and checks the route's `@RequirePermission(...)`. Sync commands check the same effective permissions in the command dispatcher. Suspending someone or changing a permission therefore takes effect on the very next request. The check never lives in a Nest guard, because guards run before the tenant transaction exists. `stock.convert` can never be an extra permission on an attendant (rejected on write, ignored on read). The owner cannot be suspended, removed or demoted.

## 15. Hosting

**OPEN.** Plan: a South Africa region (closest practical to Kenya for managed Postgres). Candidates are Azure (South Africa North), AWS (Cape Town) and Google (Johannesburg). Neon and Supabase have no African region. Prices, free offers and latency from Nairobi are not yet checked. Kenya's Data Protection (General) Regulations 2021 allow cross-border transfers on certain bases; this is not legal advice, so confirm registration and transfer rules with a lawyer or the Data Protection Commissioner.

Rule for the code: it must run on any plain PostgreSQL via environment variables (`DATABASE_URL` for the app role, `MIGRATION_DATABASE_URL` for the migrator role). Local development uses Docker.

All environment variables as of the end of the spike (see `.env.example`; HTTP settings are validated at startup by `src/config/app.config.ts`):
- Database: `DATABASE_URL` (app_user), `MIGRATION_DATABASE_URL` and `SHADOW_DATABASE_URL` (migrator, Prisma CLI only), `DATABASE_POOL_MAX` (default 10), `DATABASE_TX_MAX_WAIT_MS` (default 2000).
- HTTP: `PORT`, `LOG_LEVEL`, `TRUST_PROXY` (the load balancer's range; empty = trust nobody), `WEBHOOK_IP_ALLOWLIST`, `WEBHOOK_IP_ALLOWLIST_MODE` (`log` or `enforce`), `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`.
- Tests only: `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`.

On a hosted database the two roles and the databases must be created once by an administrator (the Docker init script does not run there); everything else comes from migrations.

## 16. Open items

1. Hosting provider, region and cost.
2. Trial length, subscription tiers and prices.
3. Confirm with Safaricom: callback IP ranges and the callback protection method.
4. Data protection registration and cross-border transfer advice.
5. Exact table columns (reviewed per group before migrating).
6. Fractional quantities (kg, litres) are unsupported for now.
7. Mobile app repository and API contract sharing (OpenAPI generation is the likely route).

Added at the end of the spike (details in `docs/spike-results.md`, "Open risks"):

8. ~~Rename the `app_user` table or the `app_user` role.~~ Decided in Phase A: the table is `person` (section 3).
9. A database home for pg-boss: its schema created by a migration or its own role, since app_user cannot create anything.
10. Production pool size and connection wait (`DATABASE_POOL_MAX`, `DATABASE_TX_MAX_WAIT_MS`), after a load test on the chosen host. Also whether a connection pooler sits in front of Postgres.
11. A shared rate-limit store for several API instances (Postgres-backed; Redis is ruled out).
12. Sentry: approve its SDK.
13. Sync commands: an attempt limit for commands that always crash, and a payload hash to catch a reused command UUID.
14. A fixed lock order for any operation that changes several stock balance rows.

Added with the Phase A design (`docs/phase-a-design.md` section 18):

15. Email provider and sending domain (needed before launch).
16. Real SMS provider setup (Africa's Talking account) and a test with a real phone.
17. A common-password list for the password rule.
18. Notify the owner's other devices (and by email) when a new device registers (Phase F). Reduces the impact of a stolen password.
19. How long to keep audit log IP addresses, and the data protection position on storing them.
20. Lost access to the owner's email is a support process for now. Design it before launch.

Added with the Phase B design (`docs/phase-b-design.md` section 17):

21. Carton barcodes: Ian checks a real carton at the client. If it shows the same number as the pieces, one barcode must map to several pack types of one product and the app asks "piece or carton?" on scan.
22. Bulk import (CSV or Excel) of existing products, likely needed to onboard real shops.
23. Categories and filters.
24. Reorder levels (needed by the Phase F low-stock digest).
25. Kenya's eTIMS e-invoicing may need a tax class on products. Not verified; confirm with an accountant before launch.
26. Wholesale price tiers or quantity discounts.
27. Label generation and printing for items without barcodes (in-store EAN-13 range 20 to 29).
28. A future audit read endpoint must hide cost values from anyone without `costs.view`.
29. A location restriction per staff member, if a real client needs it.
