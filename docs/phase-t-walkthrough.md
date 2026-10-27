# Phase T walkthrough

A hands-on run of field sales against your local API (`docs/phase-t-design.md` section 12): a van stocked from the shop, a field attendant who sells from it and sees only it, and the day-end settlement. It takes about 20 minutes. Write down anything that surprises you.

Everything is local: the fake SMS and email senders send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same eight steps, with the same values, run as an automated test (`test/t5-walkthrough.spec.ts`), so this document is checked on every test run.

## 0. Setup

Start the database, then the API with the dev settings given on the command line (your `.env` stays as it is; settings on the command line win over `.env`). In a Git Bash terminal:

```bash
docker compose up -d --wait
```

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000601,+254712000602,+254712000603,+254712000609,field-owner@example.com,field-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
```

`AUTH_DEV_FIXED_CODES` is refused when `APP_ENV=production`, so this can never reach a real server.

In a second Git Bash terminal, set the address and a helper that sends one command (each call gets a new `command_id` and the current time as `occurred_at`):

```bash
API=http://127.0.0.1:3000/v1
```

```bash
cmd() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$2\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":$3}]}"; echo; }
```

Step 7 also needs a command with an older `occurred_at` (a sale made offline earlier in the day), given as the first argument:

```bash
cmd_at() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $2" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$3\",\"occurred_at\":\"$1\",\"payload\":$4}]}"; echo; }
```

Each step says which value to copy from a response into a variable, for example `OWNER=eyJ...`. Access tokens last 15 minutes; if one expires, log in again with the PIN (Phase A walkthrough, step 4).

The product, pack type, sale and settlement ids below are fixed so you can copy them. They can be used once per database: to run the walkthrough again, reset the local database first (`docker compose down -v`, then `docker compose up -d --wait`, then `pnpm exec prisma migrate deploy`; this deletes all local data).

```bash
PIECE=22222222-2222-4222-8222-222222222222; CARTON=33333333-3333-4333-8333-333333333333
SALE_A=b1b1b1b1-0000-4000-8000-000000000001; SALE_B=b1b1b1b1-0000-4000-8000-000000000002; SALE_C=b1b1b1b1-0000-4000-8000-000000000003
SALE_WRONG=b1b1b1b1-0000-4000-8000-000000000004; SALE_LATE=b1b1b1b1-0000-4000-8000-000000000005
SETTLEMENT=c1c1c1c1-0000-4000-8000-000000000001
```

## 1. The shop: owner, manager, field attendant, stock, and the van

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000601","email":"field-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000601","email":"field-owner@example.com","phone_code":"123456","email_code":"123456"}'
```

Copy `signup_token` into `SIGNUP`.

```bash
curl -s -X POST $API/auth/signup -H 'content-type: application/json' -d "{\"signup_token\":\"$SIGNUP\",\"owner_name\":\"Amina\",\"business_name\":\"Duka la Amina\",\"business_type\":\"RETAIL\",\"password\":\"baobab-sunrise-73\",\"pin\":\"1357\",\"device\":{\"name\":\"Amina phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `OWNER`. Then the shop's location id:

```bash
curl -s $API/locations -H "authorization: Bearer $OWNER"
```

Copy the `id` of "Main shop" into `SHOP`. Now the manager:

```bash
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000602","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `membership_id` into `MANAGER_ID` and `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000602\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Repeat the three requests for the field attendant: phone `0712000603`, display name `Otieno`, role `FIELD_ATTENDANT`, new PIN `2468`. Copy their `membership_id` into `FIELD_ID` and their `access_token` into `FIELD`.

The manager creates maize flour and receives 10 cartons and 40 pieces at the shop:

```bash
cmd $MANAGER product.create "{\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"Maize flour 2kg\",\"pack_types\":[{\"pack_type_id\":\"$PIECE\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"180\"},{\"pack_type_id\":\"$CARTON\",\"name\":\"carton of 24\",\"units_per_pack\":24,\"sell_price\":\"4200\"}]}"
```

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":10},{\"pack_type_id\":\"$PIECE\",\"quantity\":40}]}"
```

Each answers `"status":"ACCEPTED"`. The owner creates the van, a `FIELD` location assigned to Otieno:

```bash
curl -s -X POST $API/locations -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d "{\"name\":\"Van 1\",\"kind\":\"FIELD\",\"assigned_membership_id\":\"$FIELD_ID\"}"
```

Expect `201` with `"kind":"FIELD"`, `"assigned_membership_id"` set to Otieno and `"is_default":false`. Copy its `id` into `VAN`.

## 2. The manager issues 10 pieces and 1 carton to the van

```bash
cmd $MANAGER stock.issue "{\"from_location_id\":\"$SHOP\",\"to_location_id\":\"$VAN\",\"reference\":\"Morning load\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":10},{\"pack_type_id\":\"$CARTON\",\"quantity\":1}]}"
```

Expect `"status":"ACCEPTED"` with a `transfer_id` and, per line, the balances after: pieces `"from_after":30,"to_after":10`, cartons `"from_after":9,"to_after":1`. The shop's stock went down and the van's went up in one transaction; an issue bigger than the shop's stock is refused with `STOCK_INSUFFICIENT` and changes nothing.

## 3. The attendant syncs and sees only their own stock

```bash
curl -s "$API/sync/snapshot?limit=500" -H "authorization: Bearer $FIELD"
```

The snapshot comes in pages, one table at a time. Follow `next_table` until you reach the `location` table, then `stock_balance` (for example `curl -s "$API/sync/snapshot?table=location&limit=500" -H "authorization: Bearer $FIELD"`). Expect exactly one location, the van, and two balances, both at the van: 10 pieces and 1 carton. The shop and its stock are not there at all. The same holds for the plain read:

```bash
curl -s $API/locations -H "authorization: Bearer $FIELD"
```

Expect only "Van 1".

## 4. The attendant sells; a sale at the shop is refused

Note the time first: step 7 sends a sale made offline at this moment.

```bash
STEP4_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

Sale A, 6 pieces for cash; sale B, 3 pieces paid by M-Pesa; sale C, the carton for cash:

```bash
cmd $FIELD sale.create "{\"sale_id\":\"$SALE_A\",\"local_ref\":\"V-0001\",\"location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":6,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"1080\"}]}"
```

```bash
cmd $FIELD sale.create "{\"sale_id\":\"$SALE_B\",\"local_ref\":\"V-0002\",\"location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":3,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"MPESA\",\"amount\":\"540\",\"mpesa_code\":\"qk90tt12xy\"}]}"
```

```bash
cmd $FIELD sale.create "{\"sale_id\":\"$SALE_C\",\"local_ref\":\"V-0003\",\"location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":1,\"unit_price\":\"4200\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"4200\"}]}"
```

Each answers `"status":"ACCEPTED"` with totals `1080.00`, `540.00` and `4200.00` and no flags. Now a sale at the shop:

```bash
cmd $FIELD sale.create "{\"sale_id\":\"$SALE_WRONG\",\"local_ref\":\"V-0004\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"180\"}]}"
```

Expect `"status":"REJECTED"`, `"reason":"LOCATION_NOT_FOUND"`: for the attendant, the shop does not exist. It is the same answer as for a made-up id or another business's location.

## 5. A void needs the manager's PIN

The customer brings the carton back. The attendant cannot void alone:

```bash
cmd $FIELD sale.void "{\"sale_id\":\"$SALE_C\",\"reason\":\"CUSTOMER_CANCELLED\"}"
```

Expect `"status":"REJECTED"`, `"reason":"PERMISSION_DENIED"`. The phone lists who can approve:

```bash
curl -s "$API/stock/approvers?purpose=SALE_VOID" -H "authorization: Bearer $FIELD"
```

Expect Amina and Wanjiru. Wanjiru types her PIN on Otieno's phone:

```bash
curl -s -X POST $API/stock/approvals -H "authorization: Bearer $FIELD" -H 'content-type: application/json' -d "{\"approver_membership_id\":\"$MANAGER_ID\",\"approver_pin\":\"2468\",\"purpose\":\"SALE_VOID\"}"
```

Copy `approval_id` into `APPROVAL`, then:

```bash
cmd $FIELD sale.void "{\"sale_id\":\"$SALE_C\",\"reason\":\"CUSTOMER_CANCELLED\",\"approval_id\":\"$APPROVAL\"}"
```

Expect `"status":"ACCEPTED"` with `"approved_by_membership_id"` set to Wanjiru. The carton is back in the van and the 4200 cash payment is reversed.

## 6. Day end: return, preview, count, cash, close

The attendant's phone syncs first (the close is refused with `ATTENDANT_NOT_SYNCED` unless one of their phones synced in the last 10 minutes):

```bash
curl -s "$API/sync/snapshot?limit=1" -H "authorization: Bearer $FIELD"
```

Otieno hands back the unsold carton, and the manager records it:

```bash
cmd $MANAGER stock.return "{\"from_location_id\":\"$VAN\",\"to_location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$CARTON\",\"quantity\":1}]}"
```

Expect `"ACCEPTED"` with cartons `"from_after":0,"to_after":10`. Now the preview:

```bash
curl -s "$API/field/settlements/preview?location_id=$VAN" -H "authorization: Bearer $MANAGER"
```

Expect:
- pieces: issued 10, returned 0, sold 9, voided back 0, expected 1;
- cartons: issued 1, returned 1, sold 1, voided back 1, expected 0;
- `"expected_cash":"1080.00"` (sale A; the voided carton's 4200 is reversed and left out), `"mpesa_unverified_total":"540.00"`, `"mpesa_verified_total":"0.00"` (until Phase M), `"sale_count":3`, `"voided_count":1`, `"unpaid_total":"0.00"`, and `last_synced_at` set.

The attendant cannot see this (`403 PERMISSION_DENIED` with their token). Wanjiru counts the van with Otieno: the one piece the server expects is not there. She takes 1050 in cash, 30 short, and closes:

```bash
cmd $MANAGER settlement.close "{\"settlement_id\":\"$SETTLEMENT\",\"field_location_id\":\"$VAN\",\"cash_received\":\"1050\",\"note\":\"Short 30, piece missing\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"counted_quantity\":0},{\"pack_type_id\":\"$CARTON\",\"counted_quantity\":0}]}"
```

Expect `"status":"ACCEPTED"`, `"cash_variance":"-30.00"`, and the line variances: piece -1, carton 0. Every pack type with stock or movements must have a line; leaving the carton out is refused with `INVALID_LINES` (`LINE_MISSING`). The settlement is final:

```bash
curl -s "$API/field/settlements/$SETTLEMENT" -H "authorization: Bearer $MANAGER"
```

```bash
curl -s "$API/stock/movements?location_id=$VAN&type=ADJUST" -H "authorization: Bearer $MANAGER"
```

Expect the settlement with its figures and lines, and one `ADJUST` movement: -1 piece, reason `LOST`.

## 7. A late offline sale is saved and flagged

The missing piece was sold at the time of step 4, while Otieno's phone was offline. The phone syncs it now:

```bash
cmd_at $STEP4_AT $FIELD sale.create "{\"sale_id\":\"$SALE_LATE\",\"local_ref\":\"V-0005\",\"location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"180\"}]}"
```

Expect `"status":"FLAGGED"` with `"flags":["STOCK_NEGATIVE","AFTER_SETTLEMENT"]`. The sale is saved (it really happened), the van's pieces go to -1, and `AFTER_SETTLEMENT` tells the owner that a sale reached the server after the day was closed. It is not added to the closed settlement; it belongs to the next one:

```bash
curl -s "$API/field/settlements/preview?location_id=$VAN" -H "authorization: Bearer $MANAGER"
```

Expect `"expected_cash":"180.00"` and `"sale_count":1`. Settling the next day squares the 180 and the piece.

## 8. A second business sees none of it

Sign up a second shop with phone `0712000609` and email `field-second@example.com` (the three requests of step 1, business name `Duka B`). Copy its `access_token` into `SECOND`, then:

```bash
curl -s "$API/field/settlements" -H "authorization: Bearer $SECOND"
```

```bash
curl -s "$API/field/settlements/$SETTLEMENT" -H "authorization: Bearer $SECOND"
```

```bash
curl -s "$API/field/settlements/preview?location_id=$VAN" -H "authorization: Bearer $SECOND"
```

Expect an empty list, `"code":"SETTLEMENT_NOT_FOUND"` and `"code":"LOCATION_NOT_FOUND"`: the same answers as for ids that do not exist. `GET $API/locations` with `SECOND` does not list the van.

Done. If anything differed from what this page says, note the step and the response.
