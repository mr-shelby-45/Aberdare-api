# Phase C walkthrough

A hands-on run of the stock story against your local API (`docs/phase-c-design.md` section 14). It takes about 20 minutes. Write down anything that surprises you.

Everything is local: the fake SMS and email senders send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same nine steps, with the same values, run as an automated test (`test/c6-walkthrough.spec.ts`), so this document is checked on every test run.

## 0. Setup

Start the database, then the API with the dev settings given on the command line (your `.env` stays as it is; settings on the command line win over `.env`). In a Git Bash terminal:

```bash
docker compose up -d --wait
```

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000301,+254712000302,+254712000303,+254712000309,stock-owner@example.com,stock-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
```

`AUTH_DEV_FIXED_CODES` is refused when `APP_ENV=production`, so this can never reach a real server.

In a second Git Bash terminal, set the address and a helper that sends one command (each call gets a new `command_id` and the current time as `occurred_at`):

```bash
API=http://127.0.0.1:3000/v1
```

```bash
cmd() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$2\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":$3}]}"; echo; }
```

Each step says which value to copy from a response into a variable, for example `OWNER=eyJ...`. Access tokens last 15 minutes; if one expires, log in again with the PIN (Phase A walkthrough, step 4).

The product and pack type ids below are fixed so you can copy them. They can be used once per database: to run the walkthrough again, reset the local database first (`docker compose down -v`, then `docker compose up -d --wait`, then `pnpm exec prisma migrate deploy`; this deletes all local data).

## 1. The owner signs up, adds a manager and an attendant, and the manager creates maize flour

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000301","email":"stock-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000301","email":"stock-owner@example.com","phone_code":"123456","email_code":"123456"}'
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
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000302","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `membership_id` into `MANAGER_ID` and `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000302\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Repeat the three requests for the attendant: phone `0712000303`, display name `Baraka`, role `ATTENDANT`, the same new PIN `2468`. Copy the attendant's `access_token` into `ATTENDANT`.

The manager creates the product, sold as a piece and a carton of 24:

```bash
cmd $MANAGER product.create '{"product_id":"11111111-1111-4111-8111-111111111111","name":"Maize flour 2kg","pack_types":[{"pack_type_id":"22222222-2222-4222-8222-222222222222","name":"piece","units_per_pack":1,"sell_price":"180"},{"pack_type_id":"33333333-3333-4333-8333-333333333333","name":"carton of 24","units_per_pack":24,"sell_price":"4200"}]}'
```

Expect `"status":"ACCEPTED"`. For the rest, set:

```bash
PIECE=22222222-2222-4222-8222-222222222222; CARTON=33333333-3333-4333-8333-333333333333
```

## 2. The manager receives a delivery; the attendant may not

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$LOC\",\"reference\":\"INV-104\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":10},{\"pack_type_id\":\"$PIECE\",\"quantity\":5}]}"
```

Expect `"result":{"lines":[{"pack_type_id":"3333...","quantity_after":10},{"pack_type_id":"2222...","quantity_after":5}]}`.

```bash
cmd $ATTENDANT stock.receive "{\"location_id\":\"$LOC\",\"reference\":\"INV-104\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":10},{\"pack_type_id\":\"$PIECE\",\"quantity\":5}]}"
```

Expect `"status":"REJECTED","reason":"PERMISSION_DENIED"`.

## 3. A delivery with two bad lines lists both

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":0},{\"pack_type_id\":\"99999999-9999-4999-8999-999999999999\",\"quantity\":3}]}"
```

Expect `"reason":"INVALID_LINES"` with `"invalid_lines":[{"line":1,"reason":"QUANTITY_INVALID"},{"line":2,"reason":"PACK_TYPE_NOT_FOUND"}]`. Nothing was saved: the shopkeeper fixes both lines and sends a new delivery.

## 4. The manager writes off a damaged piece

```bash
cmd $MANAGER stock.adjust "{\"location_id\":\"$LOC\",\"pack_type_id\":\"$PIECE\",\"quantity_change\":-1,\"reason\":\"DAMAGED\",\"note\":\"torn bag\"}"
```

Expect `"quantity_after":4`. (Try `"reason":"FOUND"` with `-1`: `REASON_SIGN_MISMATCH`.)

## 5. The attendant gets the manager's approval and breaks a carton

```bash
curl -s $API/stock/approvers -H "authorization: Bearer $ATTENDANT"
```

Expect Amina (owner) and Wanjiru (manager), names only.

```bash
curl -s -X POST $API/stock/approvals -H "authorization: Bearer $ATTENDANT" -H 'content-type: application/json' -d "{\"approver_membership_id\":\"$MANAGER_ID\",\"approver_pin\":\"2468\",\"purpose\":\"STOCK_CONVERT\"}"
```

Expect 201 with `approval_id` and `valid_until` (15 minutes ahead). Copy `approval_id` into `APPROVAL`. (A wrong PIN gives `403 APPROVAL_DENIED`, the same answer as any other refusal.)

```bash
cmd $ATTENDANT stock.convert "{\"location_id\":\"$LOC\",\"from_pack_type_id\":\"$CARTON\",\"to_pack_type_id\":\"$PIECE\",\"quantity\":1,\"approval_id\":\"$APPROVAL\"}"
```

Expect `"from_after":9,"to_after":28,"units_added":24` and `approved_by_membership_id` equal to `$MANAGER_ID`: the manager approved, the attendant did it.

## 6. The same approval cannot be used twice

Run the same `stock.convert` again. Expect `"reason":"APPROVAL_INVALID"`.

## 7. A count that does not lose what happened in between

The manager's phone shows 28 pieces and the manager counts 27. Before the count reaches the server, 2 more pieces are written off (in a real shop this is usually a sale; sales arrive in Phase E):

```bash
cmd $MANAGER stock.adjust "{\"location_id\":\"$LOC\",\"pack_type_id\":\"$PIECE\",\"quantity_change\":-2,\"reason\":\"DAMAGED\"}"
```

Expect `"quantity_after":26`. Now the count arrives, with what the phone saw (28) and what was counted (27):

```bash
cmd $MANAGER stock.count "{\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"expected_quantity\":28,\"counted_quantity\":27}]}"
```

Expect `"delta":-1,"quantity_after":25`. The count applies `counted minus expected` (one missing piece) to the live balance, so the 2 written off in between are not lost: 25, not 27.

## 8. Balances and history

```bash
curl -s $API/stock -H "authorization: Bearer $ATTENDANT"
```

Expect piece 25 and carton 9, with product, pack and location names.

```bash
curl -s $API/stock/movements -H "authorization: Bearer $ATTENDANT"
```

Expect 7 movements, newest first: the count, the second write-off, the conversion in and out (created by Baraka), the first write-off (with the note), and the two received lines. There is no `unit_cost` key: the attendant may not see costs. Run it with `$OWNER` and every row has `"unit_cost"` (here `null`).

## 9. A second business sees none of it

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000309","email":"stock-second@example.com"}'
```

Verify and sign up as in step 1 (business name `Duka B`), copy its `access_token` into `SECOND`, then:

```bash
curl -s $API/stock -H "authorization: Bearer $SECOND"
```

```bash
curl -s $API/stock/movements -H "authorization: Bearer $SECOND"
```

Expect `"balances":[]` and `"movements":[]`.

## What to write down

Anything that surprised you, anything that felt slow, and any answer you did not understand. Those notes decide what changes before Phase D.
