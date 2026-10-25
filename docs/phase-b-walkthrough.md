# Phase B walkthrough

A hands-on run of the catalogue story against your local API (`docs/phase-b-design.md` section 13). It takes about 15 minutes. Write down anything that surprises you.

Everything is local: the fake SMS and email senders send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same ten steps, with the same values, run as an automated test (`test/b5-walkthrough.spec.ts`), so this document is checked on every test run.

## 0. Setup

Start the database, then the API with the dev settings given on the command line (your `.env` stays as it is; settings on the command line win over `.env`). In a Git Bash terminal:

```bash
docker compose up -d --wait
```

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000201,+254712000202,+254712000203,+254712000209,catalogue-owner@example.com,catalogue-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
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

## 1. The owner signs up and sees the default location

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000201","email":"catalogue-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000201","email":"catalogue-owner@example.com","phone_code":"123456","email_code":"123456"}'
```

Copy `signup_token` into `SIGNUP`.

```bash
curl -s -X POST $API/auth/signup -H 'content-type: application/json' -d "{\"signup_token\":\"$SIGNUP\",\"owner_name\":\"Amina\",\"business_name\":\"Duka la Amina\",\"business_type\":\"RETAIL\",\"password\":\"baobab-sunrise-73\",\"pin\":\"1357\",\"device\":{\"name\":\"Amina phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `OWNER`.

```bash
curl -s $API/locations -H "authorization: Bearer $OWNER"
```

Expect one location: `"name":"Main shop","is_default":true`.

## 2. The owner adds a manager and an attendant

```bash
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000202","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000202\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Then repeat the three requests for the attendant: phone `0712000203`, display name `Baraka`, role `ATTENDANT`. Copy the attendant's `access_token` into `ATTENDANT`.

## 3. The attendant tries to create a product

```bash
MAIZE='{"product_id":"11111111-1111-4111-8111-111111111111","name":"Maize flour 2kg","pack_types":[{"pack_type_id":"22222222-2222-4222-8222-222222222222","name":"piece","units_per_pack":1,"sell_price":"180"},{"pack_type_id":"33333333-3333-4333-8333-333333333333","name":"carton of 24","units_per_pack":24,"sell_price":"4200"}],"barcodes":[{"barcode":"6161101560029","pack_type_id":"22222222-2222-4222-8222-222222222222"},{"barcode":"16161101560026","pack_type_id":"33333333-3333-4333-8333-333333333333"}]}'
```

```bash
cmd $ATTENDANT product.create "$MAIZE"
```

Expect `"status":"REJECTED","reason":"PERMISSION_DENIED"`. The request itself answers 200: each command gets its own result.

## 4. The manager creates "Maize flour 2kg" with a piece, a carton of 24 and two barcodes

```bash
cmd $MANAGER product.create "$MAIZE"
```

Expect `"status":"ACCEPTED"`. Prices are strings (`"180"`, `"4200"`), never numbers.

## 5. Scan the carton barcode

```bash
curl -s $API/products/by-barcode/16161101560026 -H "authorization: Bearer $ATTENDANT"
```

Expect `"pack_type_id":"33333333-3333-4333-8333-333333333333"` (the carton) and the whole product. Any active member can scan.

## 6. Search "maize"

```bash
curl -s "$API/products?q=maize" -H "authorization: Bearer $MANAGER"
```

Expect the product, prices shown as `"180.00"` and `"4200.00"`, and no `cost_price` key at all (the manager has no `costs.view`).

## 7. The owner sets a cost price and sees it

```bash
cmd $OWNER pack_type.upsert '{"pack_type_id":"22222222-2222-4222-8222-222222222222","product_id":"11111111-1111-4111-8111-111111111111","name":"piece","units_per_pack":1,"sell_price":"180","cost_price":"150"}'
```

```bash
curl -s $API/products/11111111-1111-4111-8111-111111111111 -H "authorization: Bearer $OWNER"
```

Expect `"cost_price":"150.00"` on the piece and `"cost_price":null` on the carton. Try the same `pack_type.upsert` as `$MANAGER`: `REJECTED / PERMISSION_DENIED`, because setting a cost price needs `costs.view`.

## 8. Try the carton barcode on another product

```bash
cmd $MANAGER product.create '{"product_id":"44444444-4444-4444-8444-444444444444","name":"Sugar 1kg","pack_types":[{"pack_type_id":"55555555-5555-4555-8555-555555555555","name":"piece","units_per_pack":1,"sell_price":"140"}],"barcodes":[]}'
```

```bash
cmd $MANAGER barcode.add '{"barcode":"16161101560026","product_id":"44444444-4444-4444-8444-444444444444","pack_type_id":"55555555-5555-4555-8555-555555555555"}'
```

Expect `"reason":"BARCODE_TAKEN"`.

## 9. Archive the product

```bash
cmd $MANAGER product.update '{"product_id":"11111111-1111-4111-8111-111111111111","archived":true}'
```

```bash
curl -s "$API/products?q=maize" -H "authorization: Bearer $MANAGER"
```

Expect `{"products":[]}`. Add `&include_archived=true` to see it again with `"archived":true`. Its barcodes stay reserved: repeat the `barcode.add` from step 8 and it is still `BARCODE_TAKEN`.

## 10. A second business

Sign up again as in step 1 with phone `0712000209`, email `catalogue-second@example.com` and business name `Duka B`. Copy its `access_token` into `SECOND`.

```bash
curl -s "$API/products?q=maize" -H "authorization: Bearer $SECOND"
```

Expect `{"products":[]}`: the first business's products are invisible.

```bash
cmd $SECOND product.create '{"product_id":"66666666-6666-4666-8666-666666666666","name":"Maize flour 2kg","pack_types":[{"pack_type_id":"77777777-7777-4777-8777-777777777777","name":"carton","units_per_pack":24,"sell_price":"4000"}],"barcodes":[{"barcode":"16161101560026","pack_type_id":"77777777-7777-4777-8777-777777777777"}]}'
```

Expect `ACCEPTED`: the same barcode in another business is no conflict. Scan it as each owner (`/products/by-barcode/16161101560026`): each sees only its own carton.

## Things to try if you have time

- Send the same command twice by hand (the same `command_id`): the second answer is the stored first answer, and nothing is created twice.
- `GET $API/products?limit=1` returns a `next_cursor`; pass it back with `&cursor=...` for the next page, then change one character in it: `422 VALIDATION_FAILED`.
- Search for `%` signs or quotes: they match literally and nothing breaks.
- The audit log, as the superuser: `docker compose exec postgres psql -U postgres -d aberdare -c "SELECT occurred_at, action, metadata FROM audit_log ORDER BY occurred_at"`.
