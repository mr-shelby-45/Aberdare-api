# Phase G1 walkthrough

A hands-on run of the reports against your local API and database (`docs/phase-g1-design.md` section 12): one shop day of sales and stock work, every report, the two CSV files, and a second business that sees none of it. It takes about 30 minutes. Add a few numbers up by hand as you go, and write down anything that surprises you.

Everything is local: the SMS and email senders are fakes that send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same nine steps, with the same values, run as an automated test (`test/g1f-walkthrough.spec.ts`), so this document is checked on every test run. The test's "today" is the fake clock's day (2026-10-25); yours is today in Nairobi.

## 0. Setup

Start the database and apply the migrations:

```bash
docker compose up -d --wait
```

```bash
pnpm exec prisma migrate deploy
```

**Terminal 1, the API**, with the dev settings on the command line (your `.env` stays as it is; settings on the command line win):

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000801,+254712000802,+254712000803,+254712000804,+254712000805,+254712000809,reports-owner@example.com,reports-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
```

**Terminal 2, your commands.** Set the address, today's Nairobi date, and a helper that sends one command:

```bash
API=http://127.0.0.1:3000/v1
```

```bash
TODAY=$(date -u -d '+3 hours' +%F); R="from=$TODAY&to=$TODAY"; echo $TODAY
```

```bash
cmd() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$2\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":$3}]}"; echo; }
```

Each step says which value to copy into a variable, for example `OWNER=eyJ...`. Access tokens last 15 minutes; if one expires, log in again with the PIN (Phase A walkthrough, step 4). Report routes allow 30 requests a minute per person. The fixed ids below can be used once per database: to run the walkthrough again, reset the local database (`docker compose down -v`, `docker compose up -d --wait`, `pnpm exec prisma migrate deploy`; this deletes all local data).

```bash
SODA=11111111-1111-4111-8111-111111111111; PIECE=22222222-2222-4222-8222-222222222222; CRATE=33333333-3333-4333-8333-333333333333
EQP=44444444-4444-4444-8444-444444444444; EQ=55555555-5555-4555-8555-555555555555; SETTLEMENT=e2e2e2e2-0000-4000-8000-000000000001
S1=a1a1a1a1-0000-4000-8000-000000000001; S2=a1a1a1a1-0000-4000-8000-000000000002; S3=a1a1a1a1-0000-4000-8000-000000000003; S4=a1a1a1a1-0000-4000-8000-000000000004
S5=a1a1a1a1-0000-4000-8000-000000000005; S6=a1a1a1a1-0000-4000-8000-000000000006; S7=a1a1a1a1-0000-4000-8000-000000000007
```

## 1. The shop, its people, and one day

The owner signs up:

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000801","email":"reports-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000801","email":"reports-owner@example.com","phone_code":"123456","email_code":"123456"}'
```

Copy `signup_token` into `SIGNUP`.

```bash
curl -s -X POST $API/auth/signup -H 'content-type: application/json' -d "{\"signup_token\":\"$SIGNUP\",\"owner_name\":\"Amina\",\"business_name\":\"Duka la Amina\",\"business_type\":\"RETAIL\",\"password\":\"baobab-sunrise-73\",\"pin\":\"1357\",\"device\":{\"name\":\"Amina phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `OWNER`, then the shop's location:

```bash
curl -s $API/locations -H "authorization: Bearer $OWNER"
```

Copy the `id` into `SHOP`. Now the manager:

```bash
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000802","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `membership_id` into `MANAGER_ID` and `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000802\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Repeat the three requests for:
- attendant `0712000803`, `Achieng`, `ATTENDANT`: copy `access_token` into `ACHIENG`;
- attendant `0712000804`, `Baraka`, `ATTENDANT`: copy `access_token` into `BARAKA`;
- field attendant `0712000805`, `Otieno`, `FIELD_ATTENDANT`: copy `membership_id` into `FIELD_ID` and `access_token` into `FIELD`.

The van, the two products (one is named `=1+1` on purpose, for step 8), stock, and 10 pieces into the van:

```bash
curl -s -X POST $API/locations -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d "{\"name\":\"Van\",\"kind\":\"FIELD\",\"assigned_membership_id\":\"$FIELD_ID\"}"
```

Copy the `id` into `VAN`.

```bash
cmd $OWNER product.create "{\"product_id\":\"$SODA\",\"name\":\"Soda\",\"pack_types\":[{\"pack_type_id\":\"$PIECE\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"50\",\"cost_price\":\"35.50\"},{\"pack_type_id\":\"$CRATE\",\"name\":\"crate of 24\",\"units_per_pack\":24,\"sell_price\":\"1100\",\"cost_price\":\"800\"}]}"
```

```bash
cmd $OWNER product.create "{\"product_id\":\"$EQP\",\"name\":\"=1+1\",\"pack_types\":[{\"pack_type_id\":\"$EQ\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"10\",\"cost_price\":\"6\"}]}"
```

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":50},{\"pack_type_id\":\"$CRATE\",\"quantity\":5},{\"pack_type_id\":\"$EQ\",\"quantity\":20}]}"
```

```bash
cmd $MANAGER stock.issue "{\"from_location_id\":\"$SHOP\",\"to_location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":10}]}"
```

The day's seven sales. Write them down as you go; you will add them up in step 2.

| Sale | Seller | What | Paid |
|---|---|---|---|
| 1 | Achieng | 2 Soda pieces, 100.00 | cash 100.00 |
| 2 | Achieng | 1 crate, 1100.00 | M-Pesa 1100.00 |
| 3 | Baraka | 3 `=1+1`, 30.00 | cash 10.00 + M-Pesa 20.00 |
| 4 | Baraka | 1 Soda piece, 50.00 | nothing yet |
| 5 | Achieng | 1 Soda piece, 50.00 | cash 50.00 (voided below) |
| 6 | Baraka | 2 Soda pieces at 45.00 (list 50.00), 90.00 | cash 90.00 |
| 7 | Otieno (van) | 4 Soda pieces, 200.00 | cash 200.00 |

```bash
cmd $ACHIENG sale.create "{\"sale_id\":\"$S1\",\"local_ref\":\"W-1\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":2,\"unit_price\":\"50\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"100\"}]}"
```

```bash
cmd $ACHIENG sale.create "{\"sale_id\":\"$S2\",\"local_ref\":\"W-2\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$CRATE\",\"quantity\":1,\"unit_price\":\"1100\"}],\"payments\":[{\"method\":\"MPESA\",\"amount\":\"1100\",\"mpesa_code\":\"QWK1111111\"}]}"
```

```bash
cmd $BARAKA sale.create "{\"sale_id\":\"$S3\",\"local_ref\":\"W-3\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$EQ\",\"quantity\":3,\"unit_price\":\"10\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"10\"},{\"method\":\"MPESA\",\"amount\":\"20\",\"mpesa_code\":\"QWK2222222\"}]}"
```

```bash
cmd $BARAKA sale.create "{\"sale_id\":\"$S4\",\"local_ref\":\"W-4\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"50\"}],\"payments\":[]}"
```

```bash
cmd $ACHIENG sale.create "{\"sale_id\":\"$S5\",\"local_ref\":\"W-5\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":1,\"unit_price\":\"50\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"50\"}]}"
```

```bash
cmd $BARAKA sale.create "{\"sale_id\":\"$S6\",\"local_ref\":\"W-6\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":2,\"unit_price\":\"45\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"90\"}]}"
```

```bash
cmd $FIELD sale.create "{\"sale_id\":\"$S7\",\"local_ref\":\"W-7\",\"location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":4,\"unit_price\":\"50\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"200\"}]}"
```

Every one is `"status":"ACCEPTED"` (selling below the list price is allowed; step 5 shows it). The manager voids sale 5, writes off one damaged `=1+1`, and counts the shop's Soda pieces: the phone expected 35, there are 34.

```bash
cmd $MANAGER sale.void "{\"sale_id\":\"$S5\",\"reason\":\"MISTAKE\"}"
```

```bash
cmd $MANAGER stock.adjust "{\"location_id\":\"$SHOP\",\"pack_type_id\":\"$EQ\",\"quantity_change\":-1,\"reason\":\"DAMAGED\"}"
```

```bash
cmd $MANAGER stock.count "{\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"expected_quantity\":35,\"counted_quantity\":34}]}"
```

Otieno's phone syncs, then the manager closes the van: 6 pieces expected, 5 counted, 200.00 cash handed over.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$API/sync/snapshot?limit=1" -H "authorization: Bearer $FIELD"
```

```bash
cmd $MANAGER settlement.close "{\"settlement_id\":\"$SETTLEMENT\",\"field_location_id\":\"$VAN\",\"cash_received\":\"200\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"counted_quantity\":5}]}"
```

Expect `"cash_variance":"0.00"` and a variance of `-1` for the piece.

## 2. The sales report, checked by hand

```bash
curl -s "$API/reports/sales?$R" -H "authorization: Bearer $MANAGER"
```

Expect `sale_count` 6 (sale 5 is voided, so it is left out), `total` `1570.00` (100 + 1100 + 30 + 50 + 90 + 200), `paid_total` `1520.00`, `balance_due` `50.00` (sale 4). `payments`: `cash` `400.00` (100 + 10 + 90 + 200), `mpesa_unverified` `1120.00` (1100 + 20), `mpesa_verified` `0.00` (until Phase M).

```bash
curl -s "$API/reports/sales?$R&group_by=attendant" -H "authorization: Bearer $MANAGER"
```

Expect Achieng 2 sales, `1200.00`; Baraka 3 sales, `170.00`, of which `50.00` still owed; Otieno 1 sale, `200.00`. Compare with the list the phones see:

```bash
curl -s "$API/sales?limit=20" -H "authorization: Bearer $MANAGER"
```

## 3. Top products and profit

```bash
curl -s "$API/reports/top-products?$R" -H "authorization: Bearer $MANAGER"
```

Expect Soda first with `pieces` 33 (2 + 24 for the crate + 1 + 2 + 4) and `value` `1540.00`, then `=1+1` with 3 and `30.00`. No cost figures: the manager does not have `costs.view`.

```bash
curl -s "$API/reports/profit?$R" -H "authorization: Bearer $MANAGER"
```

Expect `403 PERMISSION_DENIED`. The owner has `costs.view`:

```bash
curl -s "$API/reports/profit?$R&group_by=product" -H "authorization: Bearer $OWNER"
```

Expect `totals` revenue `1570.00`, cost `1137.50`, profit `432.50`; Soda `1540.00` - `1119.50` = `420.50` (33 pieces at 35.50, the crate counted as one crate at 800.00); `=1+1` `30.00` - `18.00` = `12.00`.

## 4. Stock and shrinkage

```bash
curl -s "$API/reports/stock" -H "authorization: Bearer $OWNER"
```

Expect `pieces` 151, `pools` 4, `value_at_cost` `4680.50`. Compare with the stock list: the shop has 34 pieces, 4 crates and 16 `=1+1`; the van 5 pieces.

```bash
curl -s "$API/stock" -H "authorization: Bearer $MANAGER"
```

```bash
curl -s "$API/reports/shrinkage?$R" -H "authorization: Bearer $MANAGER"
```

Expect `DAMAGED` 1, `COUNT` 1 and `SETTLEMENT` 1 lost, all in pieces (`"unit":"pieces"`).

```bash
curl -s "$API/reports/shrinkage?$R&group_by=person" -H "authorization: Bearer $MANAGER"
```

Expect Otieno 1 (the van's shortage counts against the attendant, not Wanjiru who closed it) and Wanjiru 2.

## 5. Exceptions and money owed

```bash
curl -s "$API/reports/exceptions?type=voids&$R" -H "authorization: Bearer $MANAGER"
```

Expect sale 5, `MISTAKE`, voided by Wanjiru, `approved_by` `null` (she can void without anyone's PIN).

```bash
curl -s "$API/reports/exceptions?type=below_list&$R" -H "authorization: Bearer $MANAGER"
```

Expect sale 6: 2 at `45.00` against `50.00`, `difference` `10.00`.

```bash
curl -s "$API/reports/receivables?type=unpaid" -H "authorization: Bearer $MANAGER"
```

Expect sale 4, `balance_due` `50.00`, `age_days` 0.

```bash
curl -s "$API/reports/receivables?type=unverified_mpesa" -H "authorization: Bearer $MANAGER"
```

Expect the two M-Pesa payments, `QWK1111111` (`1100.00`) and `QWK2222222` (`20.00`), neither a duplicate. The codes are shown here but never written to the API's log (check terminal 1).

## 6. The field report

```bash
curl -s "$API/reports/field?$R" -H "authorization: Bearer $MANAGER"
```

Expect Otieno: one settlement, `expected_cash` and `cash_received` `200.00`, `shortage_units` 1.

## 7. An attendant's own day

```bash
curl -s "$API/reports/my-day" -H "authorization: Bearer $BARAKA"
```

Expect only Baraka's sales: 3, `170.00`, `paid_total` `120.00`, `balance_due` `50.00`, `payments` cash `100.00` and M-Pesa `20.00`. Nothing of Achieng's or Otieno's. The shop's sales report is refused to him:

```bash
curl -s "$API/reports/sales?$R" -H "authorization: Bearer $BARAKA"
```

## 8. The CSV files

```bash
curl -s -D - -o sales.csv "$API/reports/sales/export.csv?$R" -H "authorization: Bearer $MANAGER"
```

The headers show `content-type: text/csv; charset=utf-8` and `content-disposition: attachment; filename="sales_<today>_<today>.csv"`. Open `sales.csv` in a spreadsheet: 6 rows, Nairobi dates and times, and the `total` column sums to `1570.00`, as in step 2.

```bash
curl -s -o stock.csv "$API/reports/stock/export.csv" -H "authorization: Bearer $MANAGER"
```

Open `stock.csv`: the product `=1+1` shows as the text `'=1+1`, not as the number 2. A spreadsheet runs a cell that starts with `=`; the leading apostrophe stops that. Delete both files when you are done: they hold shop data.

## 9. A second business sees none of it

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000809","email":"reports-second@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000809","email":"reports-second@example.com","phone_code":"123456","email_code":"123456"}'
```

```bash
curl -s -X POST $API/auth/signup -H 'content-type: application/json' -d "{\"signup_token\":\"<the new signup_token>\",\"owner_name\":\"Amina\",\"business_name\":\"Duka Jirani\",\"business_type\":\"RETAIL\",\"password\":\"baobab-sunrise-73\",\"pin\":\"1357\",\"device\":{\"name\":\"Amina phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `SECOND`, then:

```bash
curl -s "$API/reports/sales?$R" -H "authorization: Bearer $SECOND"
```

```bash
curl -s "$API/reports/stock" -H "authorization: Bearer $SECOND"
```

```bash
curl -s "$API/reports/receivables?type=unpaid" -H "authorization: Bearer $SECOND"
```

Expect zeros and empty lists: row-level security keeps every report to the caller's own business.

Write down anything that surprised you.
