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

Tables that are not tenant-owned (no RLS): `app_user` lookups during login, and the lookup of a shop key. Those code paths use a separate, narrowly scoped access path (a small set of SQL functions or a limited repository) and are reviewed carefully. Keep this list as short as possible.

Constraints:
- Transactions must stay short (Prisma's default interactive transaction timeout is about 5 seconds). No network calls inside them.
- Background jobs set the tenant the same way for each business they process.

## 4. Authentication

**DECIDED.**

**Owner**: signs up and logs in with phone number plus SMS one-time code (OTP). Phone numbers are normalised to E.164 and unique on `app_user.phone`.

**Staff (attendants and managers)**: identified by phone number, which is unique on `app_user`. The owner adds a staff member in the app:
1. The server creates the `app_user` (if the phone is new) and a `membership` row for this business with status `invited`, the chosen role preset and permissions.
2. The app generates a temporary PIN and shows it to the owner once. Only its hash is stored. It expires in a few days and works once.
3. First login on the staff phone: phone number plus temporary PIN. The staff member sets their own PIN and confirms an SMS code. A `device` row is created and the membership becomes `active`.
4. Later logins: the app sends device ID plus PIN. The server finds the device, then its membership, then compares one hash. No phone number needed.

PIN hashing: argon2id with a server-side pepper (bcrypt acceptable if argon2 gives trouble). Failed attempts are counted per membership; after 5 wrong tries the membership is locked until the owner resets the PIN or a timed lockout passes. Rate limit by IP and by device.

Tokens: a short-lived access token carrying `membershipId`, `businessId`, `userId`, `deviceId`, plus a refresh token stored hashed and tied to the device. Logging out or suspending a membership revokes its refresh tokens.

**Shared tablet**: the owner can mark a device as a "shared shop device" (Settings, Devices). A `device_membership` row links the device to each staff member allowed on it. The app shows a "Who is selling?" lock screen with first names and a PIN pad. The PIN is checked for the chosen membership on that device.

Reinstall is treated as a new device: log in again, then a full snapshot sync rebuilds the local data.

## 5. Offline sync

**DECIDED.** The phone keeps a local SQLite database (via Drift, encrypted) and never writes sales directly to the server.

**Writes**: the phone records "commands" in an outbox, each with a phone-generated UUID, a type, a payload, and `occurred_at`. It sends batches to `POST /v1/sync/commands`.

The server, for each command:
- Checks the command UUID in `sync_command`. If seen before, returns the stored result (idempotent). The uniqueness is enforced by a database constraint, not by a check.
- Checks the permission for that command type.
- Runs the handler in its own transaction (or savepoint) so one bad command does not undo the others.
- Returns per command: `accepted`, `flagged` (accepted but needs the owner's attention, for example an oversell), or `rejected` (with a reason code).

Command types and required permission:

| Command | Permission |
|---|---|
| sale.create | sales.create |
| payment.attach | payments.confirm |
| stock.receive | stock.receive |
| stock.adjust | stock.adjust |
| stock.convert | stock.convert (manager or owner only) |
| stock.count | stock.count |
| product.create, product.update | products.edit |
| order.update | orders.manage |

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

Tables:
- `error_event`: server-side errors for support. Kept 90 days.
- `audit_log`: who did what and when (sales voided, stock adjusted, staff changes, conversions, payment approvals). Kept indefinitely. Append-only.

Time: all timestamps in UTC. Phone events carry `occurred_at` (phone clock) and the server records `received_at`. If they differ by more than about 5 minutes, flag clock skew to the user. Display in Africa/Nairobi.

## 12. Data model

Table list (exact columns are designed during the build and reviewed by Ian before the first migration of each group):

| Table | Purpose |
|---|---|
| business | the tenant: name, type, till number, subscription state, settings |
| location | a shop or warehouse of a business |
| app_user | a person: phone (unique, E.164), name. Not tenant-owned. |
| membership | a person's role in one business: status, permissions, PIN hash, lockout counters |
| device | a registered phone: push token, last sync, shared flag |
| device_membership | which memberships may sell on a shared device |
| product | name, category, cost price, sell prices |
| pack_type | piece, carton of N, and so on, with its own price |
| product_barcode | barcode to product and pack type, unique per business |
| stock_movement | append-only ledger |
| stock_balance | cached balance per business, location, pack type |
| stock_conversion | links the two ledger rows of a break-bulk |
| sale, sale_item | a sale and its lines |
| payment | payment attached to a sale, verified flag, method |
| mpesa_transaction | raw M-Pesa notifications, unique on trans_id |
| order_inbox, order_inbox_item | orders from a website |
| sync_command | every received command: UUID unique, result, status |
| change_log | what changed, for `sync/changes` |
| subscription | plan, state, trial end, grace end, payments |
| notification | see section 10 |
| audit_log | see section 11 |
| error_event | see section 11 |

Standard columns on tenant tables: `id uuid`, `business_id uuid`, `created_at timestamptz`, `updated_at timestamptz`. Primary keys are UUIDs. Records created offline use phone-generated UUIDs.

Hand-written SQL migrations are required for: RLS policies, the change-log triggers, trigram indexes, and partial or unique indexes Prisma cannot express. Keep each of those in its own clearly named migration file.

## 13. API endpoints

All under `/v1`, JSON, access token required unless stated.

- **auth** (no token): `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/first-login`, `/auth/set-pin`, `/auth/verify-device`, `/auth/pin`, `/auth/refresh`, `/auth/logout`
- **business**: `GET/PATCH /business`, `/locations`
- **staff**: `POST /staff` (returns the temporary PIN once), `PATCH /staff/:id`, `POST /staff/:id/reset-pin`, `POST /staff/:id/suspend`, `DELETE /staff/:id`
- **devices**: `GET /devices`, `PATCH /devices/:id` (shared flag), `DELETE /devices/:id`
- **reads**: `GET /products?q=`, `/products/by-barcode/:code`, `/stock`, `/stock/movements`, `/sales`, `/payments/pending`, `/orders`, `/reports/*`, `/audit-log`, `/notifications`, `/subscription`
- **sync**: `POST /sync/commands`, `GET /sync/snapshot`, `GET /sync/changes?cursor=`
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
| costs.view, staff.manage, devices.manage, subscription.manage, shopkey.manage | no | no | yes |

Every protected endpoint and sync command checks its permission in the controller or command dispatcher, using the permissions in the token and, for sensitive actions, the live membership row (so suspending someone takes effect immediately).

## 15. Hosting

**OPEN.** Plan: a South Africa region (closest practical to Kenya for managed Postgres). Candidates are Azure (South Africa North), AWS (Cape Town) and Google (Johannesburg). Neon and Supabase have no African region. Prices, free offers and latency from Nairobi are not yet checked. Kenya's Data Protection (General) Regulations 2021 allow cross-border transfers on certain bases; this is not legal advice, so confirm registration and transfer rules with a lawyer or the Data Protection Commissioner.

Rule for the code: it must run on any plain PostgreSQL via environment variables (`DATABASE_URL` for the app role, `MIGRATION_DATABASE_URL` for the migrator role). Local development uses Docker.

## 16. Open items

1. Hosting provider, region and cost.
2. Trial length, subscription tiers and prices.
3. Confirm with Safaricom: callback IP ranges and the callback protection method.
4. Data protection registration and cross-border transfer advice.
5. Exact table columns (reviewed per group before migrating).
6. Fractional quantities (kg, litres) are unsupported for now.
7. Mobile app repository and API contract sharing (OpenAPI generation is the likely route).
