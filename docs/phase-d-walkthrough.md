# Phase D walkthrough

A hands-on run of the sync story against your local API (`docs/phase-d-design.md` section 12). It takes about 20 minutes. Write down anything that surprises you.

Everything is local: the fake SMS and email senders send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same six steps, with the same values, run as an automated test (`test/d4-walkthrough.spec.ts`), so this document is checked on every test run.

## 0. Setup

Start the database, then the API with the dev settings given on the command line (your `.env` stays as it is; settings on the command line win over `.env`). In a Git Bash terminal:

```bash
docker compose up -d --wait
```

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000401,+254712000402,+254712000403,+254712000409,sync-owner@example.com,sync-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
```

`AUTH_DEV_FIXED_CODES` is refused when `APP_ENV=production`, so this can never reach a real server.

In a second Git Bash terminal, set the address and a helper that sends one command (each call gets a new `command_id` and the current time as `occurred_at`):

```bash
API=http://127.0.0.1:3000/v1
```

```bash
cmd() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$2\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":$3}]}"; echo; }
```

Cursors are long and contain characters that must be encoded in a URL. This helper encodes one:

```bash
enc() { node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }
```

Each step says which value to copy from a response into a variable, for example `OWNER=eyJ...`. Access tokens last 15 minutes; if one expires, log in again with the PIN (Phase A walkthrough, step 4).

The product and pack type ids below are fixed so you can copy them. They can be used once per database: to run the walkthrough again, reset the local database first (`docker compose down -v`, then `docker compose up -d --wait`, then `pnpm exec prisma migrate deploy`; this deletes all local data).

## 1. The shop is set up: a product with a carton and a piece, a barcode, a cost and stock

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000401","email":"sync-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000401","email":"sync-owner@example.com","phone_code":"123456","email_code":"123456"}'
```

Copy `signup_token` into `SIGNUP`.

```bash
curl -s -X POST $API/auth/signup -H 'content-type: application/json' -d "{\"signup_token\":\"$SIGNUP\",\"owner_name\":\"Amina\",\"business_name\":\"Duka la Amina\",\"business_type\":\"RETAIL\",\"password\":\"baobab-sunrise-73\",\"pin\":\"1357\",\"device\":{\"name\":\"Amina phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `OWNER`. Then the location id:

```bash
curl -s $API/locations -H "authorization: Bearer $OWNER"
```

Copy the `id` of "Main shop" into `LOC`. Now the manager:

```bash
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000402","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `membership_id` into `MANAGER_ID` and `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000402\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Repeat the three requests for the attendant: phone `0712000403`, display name `Baraka`, role `ATTENDANT`, new PIN `2468`. Copy the attendant's `access_token` into `ATTENDANT`.

```bash
PIECE=22222222-2222-4222-8222-222222222222; CARTON=33333333-3333-4333-8333-333333333333
```

The manager creates the product with a barcode on the piece:

```bash
cmd $MANAGER product.create "{\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"Maize flour 2kg\",\"pack_types\":[{\"pack_type_id\":\"$PIECE\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"180\"},{\"pack_type_id\":\"$CARTON\",\"name\":\"carton of 24\",\"units_per_pack\":24,\"sell_price\":\"4200\"}],\"barcodes\":[{\"barcode\":\"6161101560029\",\"pack_type_id\":\"$PIECE\"}]}"
```

The owner sets a cost price on the piece (only the owner has `costs.view`):

```bash
cmd $OWNER pack_type.upsert "{\"pack_type_id\":\"$PIECE\",\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"180\",\"cost_price\":\"150\"}"
```

The manager receives 10 cartons and 5 pieces:

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":10},{\"pack_type_id\":\"$PIECE\",\"quantity\":5}]}"
```

## 2. A new phone downloads the snapshot and keeps the starting cursor

The attendant's phone starts the download (no `table`, no `cursor`):

```bash
curl -s "$API/sync/snapshot" -H "authorization: Bearer $ATTENDANT"
```

Expect `"table":"location"`, the Main shop row, `"next_table":"product"` and a long `start_cursor`. Copy `start_cursor` into `ATT_CURSOR`. The phone keeps this; it means "you have everything up to here".

```bash
curl -s "$API/sync/snapshot?table=product" -H "authorization: Bearer $ATTENDANT"
```

Then the pack types, one per page to show paging:

```bash
curl -s "$API/sync/snapshot?table=pack_type&limit=1" -H "authorization: Bearer $ATTENDANT"
```

Expect one row and a `next_cursor`. Copy it into `PAGE`, then:

```bash
curl -s "$API/sync/snapshot?table=pack_type&limit=1&cursor=$(enc "$PAGE")" -H "authorization: Bearer $ATTENDANT"
```

Expect the second pack type, `"next_cursor":null,"next_table":"product_barcode"`. Neither pack type has a `cost_price` key: the attendant may not see costs. Finish with:

```bash
curl -s "$API/sync/snapshot?table=product_barcode" -H "authorization: Bearer $ATTENDANT"
```

```bash
curl -s "$API/sync/snapshot?table=stock_balance" -H "authorization: Bearer $ATTENDANT"
```

Expect balances 10 (carton) and 5 (piece), and `"next_table":null`: the download is complete. The manager's phone also starts a snapshot, for step 5:

```bash
curl -s "$API/sync/snapshot" -H "authorization: Bearer $MANAGER"
```

Copy its `start_cursor` into `MGR_CURSOR`.

## 3. The manager makes three changes

A new price (the cost is left out, so it stays as it was):

```bash
cmd $MANAGER pack_type.upsert "{\"pack_type_id\":\"$PIECE\",\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"190\"}"
```

A barcode on the carton:

```bash
cmd $MANAGER barcode.add "{\"barcode\":\"16161101560026\",\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"pack_type_id\":\"$CARTON\"}"
```

A carton broken into pieces:

```bash
cmd $MANAGER stock.convert "{\"location_id\":\"$LOC\",\"from_pack_type_id\":\"$CARTON\",\"to_pack_type_id\":\"$PIECE\",\"quantity\":1}"
```

## 4. The attendant's phone asks what changed

```bash
curl -s "$API/sync/changes?cursor=$(enc "$ATT_CURSOR")" -H "authorization: Bearer $ATTENDANT"
```

Expect exactly four changes, in this order, each with the record as it is now: the piece pack type (`"sell_price":"190.00"`, no `cost_price`), the new carton barcode, the carton balance (9) and the piece balance (29). `"has_more":false`. Copy `next_cursor` into `ATT_CURSOR` (a phone replaces its cursor only after applying the whole page), then ask again:

```bash
curl -s "$API/sync/changes?cursor=$(enc "$ATT_CURSOR")" -H "authorization: Bearer $ATTENDANT"
```

Expect `"changes":[]` and the same `next_cursor`: nothing new.

## 5. The manager is allowed to see costs

The owner gives the manager `costs.view`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH $API/staff/$MANAGER_ID -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"extra_permissions":["costs.view"]}'
```

Expect `204`. The attendant's cursor still works (repeat the last request: `200`). The manager's old cursor was issued without costs, so the manager's phone holds data without costs:

```bash
curl -s "$API/sync/changes?cursor=$(enc "$MGR_CURSOR")" -H "authorization: Bearer $MANAGER"
```

Expect `410` with `"code":"SNAPSHOT_REQUIRED"`. The phone takes a fresh snapshot; the pack types now carry costs:

```bash
curl -s "$API/sync/snapshot?table=pack_type" -H "authorization: Bearer $MANAGER"
```

Expect the piece with `"sell_price":"190.00","cost_price":"150.00"`.

## 6. A second business sees none of it

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000409","email":"sync-second@example.com"}'
```

Verify and sign up as in step 1 (business name `Duka B`), copy its `access_token` into `SECOND`, then:

```bash
curl -s "$API/sync/snapshot" -H "authorization: Bearer $SECOND"
```

```bash
curl -s "$API/sync/snapshot?table=product" -H "authorization: Bearer $SECOND"
```

Expect only Duka B's own "Main shop", and `"rows":[]` for products.

## What to write down

Anything that surprised you, anything that felt slow, and any answer you did not understand. Those notes decide what changes before Phase E.
