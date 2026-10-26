# Phase E walkthrough

A hands-on run of sales, payments and voids against your local API (`docs/phase-e-design.md` section 14). It takes about 20 minutes. Write down anything that surprises you.

Everything is local: the fake SMS and email senders send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same ten steps, with the same values, run as an automated test (`test/e6-walkthrough.spec.ts`), so this document is checked on every test run.

## 0. Setup

Start the database, then the API with the dev settings given on the command line (your `.env` stays as it is; settings on the command line win over `.env`). In a Git Bash terminal:

```bash
docker compose up -d --wait
```

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000501,+254712000502,+254712000503,+254712000509,sales-owner@example.com,sales-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
```

`AUTH_DEV_FIXED_CODES` is refused when `APP_ENV=production`, so this can never reach a real server.

In a second Git Bash terminal, set the address and a helper that sends one command (each call gets a new `command_id` and the current time as `occurred_at`):

```bash
API=http://127.0.0.1:3000/v1
```

```bash
cmd() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$2\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":$3}]}"; echo; }
```

```bash
enc() { node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }
```

Each step says which value to copy from a response into a variable, for example `OWNER=eyJ...`. Access tokens last 15 minutes; if one expires, log in again with the PIN (Phase A walkthrough, step 4).

The product, pack type and sale ids below are fixed so you can copy them. They can be used once per database: to run the walkthrough again, reset the local database first (`docker compose down -v`, then `docker compose up -d --wait`, then `pnpm exec prisma migrate deploy`; this deletes all local data).

```bash
PIECE=22222222-2222-4222-8222-222222222222; CARTON=33333333-3333-4333-8333-333333333333
SALE_A=a1a1a1a1-0000-4000-8000-000000000001; SALE_B=a1a1a1a1-0000-4000-8000-000000000002; SALE_C=a1a1a1a1-0000-4000-8000-000000000003
SALE_D=a1a1a1a1-0000-4000-8000-000000000004; SALE_E=a1a1a1a1-0000-4000-8000-000000000005
```

## 1. The shop: owner, manager, attendant, a product with a cost, and stock

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000501","email":"sales-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000501","email":"sales-owner@example.com","phone_code":"123456","email_code":"123456"}'
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
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000502","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `membership_id` into `MANAGER_ID` and `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000502\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Repeat the three requests for the attendant: phone `0712000503`, display name `Baraka`, role `ATTENDANT`, new PIN `2468`. Copy the attendant's `access_token` into `ATTENDANT`.

The manager creates maize flour, the owner sets a cost price on the piece (only the owner has `costs.view`), and the manager receives 10 cartons and 20 pieces:

```bash
cmd $MANAGER product.create "{\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"Maize flour 2kg\",\"pack_types\":[{\"pack_type_id\":\"$PIECE\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"180\"},{\"pack_type_id\":\"$CARTON\",\"name\":\"carton of 24\",\"units_per_pack\":24,\"sell_price\":\"4200\"}]}"
```

```bash
cmd $OWNER pack_type.upsert "{\"pack_type_id\":\"$PIECE\",\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"180\",\"cost_price\":\"150\"}"
```

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":10},{\"pack_type_id\":\"$PIECE\",\"quantity\":20}]}"
```

Each answers `"status":"ACCEPTED"`. Now the attendant's phone starts its offline copy and keeps the starting cursor (step 9 uses it):

```bash
curl -s "$API/sync/snapshot" -H "authorization: Bearer $ATTENDANT"
```

Copy `start_cursor` into `ATT_CURSOR`.

## 2. A sale of 3 pieces and 1 carton, paid part cash, part M-Pesa

Sale A: three pieces at the list price and one carton at 4100 (below the list price of 4200: recorded, not refused), paid with 640 cash and 4000 by M-Pesa. The code is typed in lower case on purpose:

```bash
cmd $ATTENDANT sale.create "{\"sale_id\":\"$SALE_A\",\"local_ref\":\"A-0001\",\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":3,\"unit_price\":\"180\"},{\"pack_type_id\":\"$CARTON\",\"quantity\":1,\"unit_price\":\"4100\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"640\"},{\"method\":\"MPESA\",\"amount\":\"4000\",\"mpesa_code\":\"qk12ab34cd\"}]}"
```

Expect `"status":"ACCEPTED"` and `"result":{"sale_id":"a1a1a1a1-...-000000000001","sale_number":1,"total":"4640.00","paid_total":"4640.00","balance_due":"0.00","flags":[]}`: the numbers for the receipt. The server works out the total itself, with exact decimals.

## 3. A wrong phone total is saved and flagged

Sale B, one piece, but the phone says the total is 170:

```bash
cmd $ATTENDANT sale.create "{\"sale_id\":\"$SALE_B\",\"local_ref\":\"A-0002\",\"location_id\":\"$LOC\",\"total\":\"170\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"180\"}]}"
```

Expect `"status":"FLAGGED"`, `"reason":"TOTAL_MISMATCH"` and `"total":"180.00"`: the sale is saved with the server's total, and the owner can look at why the phone thought otherwise.

## 4. A sale bigger than the stock is saved, and the stock goes negative

Sale C, 12 cartons, when only 9 are left. Nothing is paid yet:

```bash
cmd $ATTENDANT sale.create "{\"sale_id\":\"$SALE_C\",\"local_ref\":\"A-0003\",\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":12,\"unit_price\":\"4200\"}]}"
```

Expect `"status":"FLAGGED"`, `"reason":"STOCK_NEGATIVE"`, `"sale_number":3` and `"balance_due":"50400.00"`. The sale really happened, so it is never refused; the carton count is now -3 until someone counts or receives.

## 5. The same M-Pesa code on a second sale is flagged

Sale D, one piece, paid with sale A's code (in upper case this time; codes are compared in upper case):

```bash
cmd $ATTENDANT sale.create "{\"sale_id\":\"$SALE_D\",\"local_ref\":\"A-0004\",\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"MPESA\",\"amount\":\"180\",\"mpesa_code\":\"QK12AB34CD\"}]}"
```

Expect `"status":"FLAGGED"`, `"reason":"DUPLICATE_MPESA_CODE"` and `"sale_number":4`. The sale and its payment are saved; the payment is marked as a duplicate of the first one for the owner to check. M-Pesa codes are not verified with Safaricom until Phase M.

## 6. The attendant pays off a balance

The customer of sale C pays:

```bash
cmd $ATTENDANT payment.attach "{\"sale_id\":\"$SALE_C\",\"payments\":[{\"method\":\"CASH\",\"amount\":\"50400\"}]}"
```

Expect `"status":"ACCEPTED"` with `"paid_total":"50400.00","balance_due":"0.00"`.

## 7. The attendant voids sale A with the manager's PIN

Without an approval the attendant may not void:

```bash
cmd $ATTENDANT sale.void "{\"sale_id\":\"$SALE_A\",\"reason\":\"CUSTOMER_CANCELLED\"}"
```

Expect `"status":"REJECTED"` and `"reason":"PERMISSION_DENIED"`. Who could approve a void?

```bash
curl -s "$API/stock/approvers?purpose=SALE_VOID" -H "authorization: Bearer $ATTENDANT"
```

Expect Amina and Wanjiru. Wanjiru types her PIN on the attendant's phone:

```bash
curl -s -X POST $API/stock/approvals -H "authorization: Bearer $ATTENDANT" -H 'content-type: application/json' -d "{\"approver_membership_id\":\"$MANAGER_ID\",\"approver_pin\":\"2468\",\"purpose\":\"SALE_VOID\"}"
```

Copy `approval_id` into `APPROVAL` (it is valid for 15 minutes and only on this phone). Now the void:

```bash
cmd $ATTENDANT sale.void "{\"sale_id\":\"$SALE_A\",\"reason\":\"CUSTOMER_CANCELLED\",\"approval_id\":\"$APPROVAL\"}"
```

Expect `"status":"ACCEPTED"` and `"approved_by_membership_id"` equal to `MANAGER_ID`. The three pieces and the carton go back on the shelf, and both payments of sale A are reversed. The same approval cannot be used again.

## 8. Who sees which sales, and who sees costs

The manager makes a sale of their own, sale E:

```bash
cmd $MANAGER sale.create "{\"sale_id\":\"$SALE_E\",\"local_ref\":\"W-0001\",\"location_id\":\"$LOC\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"180\"}]}"
```

The manager lists all five sales (numbers 5, 4, 3, 2, 1, newest first); the attendant only their own four (4, 3, 2, 1). Asking for sale E as the attendant is the same 404 as a sale that does not exist:

```bash
curl -s "$API/sales" -H "authorization: Bearer $MANAGER"
```

```bash
curl -s "$API/sales" -H "authorization: Bearer $ATTENDANT"
```

```bash
curl -s "$API/sales/$SALE_E" -H "authorization: Bearer $ATTENDANT"
```

Expect `"code":"SALE_NOT_FOUND"`. Sale A in detail, as the attendant:

```bash
curl -s "$API/sales/$SALE_A" -H "authorization: Bearer $ATTENDANT"
```

Expect `"status":"VOIDED"`, `"void_reason":"CUSTOMER_CANCELLED"`, `voided_by` Baraka, `void_approved_by` Wanjiru, both payments `"status":"REVERSED"` (the M-Pesa one stored as `QK12AB34CD`), and no `cost_price` on the items. The same request as the owner shows `"cost_price":"150.00"` on the piece line and `null` on the carton line:

```bash
curl -s "$API/sales/$SALE_A" -H "authorization: Bearer $OWNER"
```

## 9. A phone catches up with the sales

```bash
curl -s "$API/sync/changes?cursor=$(enc "$ATT_CURSOR")" -H "authorization: Bearer $ATTENDANT"
```

Expect changes for sales A to D (sale A already `"status":"VOIDED"`: the phone gets the current state, not every step), their items and payments (sale A's two payments `"REVERSED"`), and the stock balances. Nothing of the manager's sale E reaches the attendant's phone, not even a delete marker. Stock after the void, as the manager:

```bash
curl -s "$API/stock" -H "authorization: Bearer $MANAGER"
```

Expect -2 cartons (10 received, 1 sold in A and returned, 12 sold in C) and 17 pieces (20 received; 3 sold in A and returned; 1 each in B, D and E). The void's own movements:

```bash
curl -s "$API/stock/movements?type=SALE_VOID" -H "authorization: Bearer $MANAGER"
```

Expect two `SALE_VOID` movements: +3 pieces and +1 carton.

## 10. A second business sees none of it

Sign up a second shop with phone `0712000509` and email `sales-second@example.com` (the three requests of step 1, business name `Duka B`). Copy its `access_token` into `SECOND`, then:

```bash
curl -s "$API/sales" -H "authorization: Bearer $SECOND"
```

```bash
curl -s "$API/sales/$SALE_A" -H "authorization: Bearer $SECOND"
```

Expect an empty list, and `"code":"SALE_NOT_FOUND"`: the same answer as for a sale that does not exist.

Done. If anything differed from what this page says, note the step and the response.
