# Phase F walkthrough

A hands-on run of the worker and notifications against your local API and database (`docs/phase-f-design.md` section 12): in-app notifications, a fake push, the stale-phone and integrity jobs, and a second business that sees none of it. It takes about 25 minutes. Write down anything that surprises you.

Everything is local: the SMS, email and push senders are fakes that send nothing, and the fixed code `123456` works only for the phones and emails listed below. The same nine steps, with the same values, run as an automated test (`test/f6-walkthrough.spec.ts`), so this document is checked on every test run.

## 0. Setup

You need `QUEUE_DATABASE_URL` in `.env` (you added it in F1). Start the database and build once:

```bash
docker compose up -d --wait
```

```bash
pnpm exec prisma migrate deploy
```

```bash
pnpm queue:migrate
```

`pnpm queue:migrate` builds the project and creates pg-boss's tables as the migration role; run it after every `prisma migrate deploy`.

**Terminal 1, the API**, with the dev settings on the command line (your `.env` stays as it is; settings on the command line win):

```bash
AUTH_DEV_FIXED_CODES=true AUTH_DEV_CODE_ALLOWLIST=+254712000701,+254712000702,+254712000703,+254712000704,+254712000709,worker-owner@example.com,worker-second@example.com AUTH_RATE_LIMIT_MAX=60 pnpm start:dev
```

**Terminal 2, the worker** (it logs one JSON line per job and per push):

```bash
pnpm start:worker
```

Expect a line with `"msg":"worker ready"`. Ctrl+C stops it cleanly (it lets a running job finish).

**Terminal 3, your commands.** Set the address and a helper that sends one command:

```bash
API=http://127.0.0.1:3000/v1
```

```bash
cmd() { curl -s -X POST $API/sync/commands -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"commands\":[{\"command_id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"type\":\"$2\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":$3}]}"; echo; }
```

And one for SQL as the database superuser (only for steps 7 and 8, which simulate trouble):

```bash
sql() { docker compose exec -T postgres psql -U postgres -d aberdare -c "$1"; }
```

Each step says which value to copy into a variable, for example `OWNER=eyJ...`. Access tokens last 15 minutes; if one expires, log in again with the PIN (Phase A walkthrough, step 4). The fixed ids below can be used once per database: to run the walkthrough again, reset the local database (`docker compose down -v`, `docker compose up -d --wait`, `pnpm exec prisma migrate deploy`, `pnpm queue:migrate`; this deletes all local data).

```bash
PIECE=22222222-2222-4222-8222-222222222222; CARTON=33333333-3333-4333-8333-333333333333
SALE_A=d1d1d1d1-0000-4000-8000-000000000001; SETTLEMENT=e1e1e1e1-0000-4000-8000-000000000001
```

## 1. The API and the worker are running

Terminal 1 shows the API listening on port 3000; terminal 2 shows `"worker ready"`.

## 2. The shop, its people, and low stock

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712000701","email":"worker-owner@example.com"}'
```

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000701","email":"worker-owner@example.com","phone_code":"123456","email_code":"123456"}'
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
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"phone":"0712000702","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

Copy `membership_id` into `MANAGER_ID` and `temp_pin` into `TEMP`, then:

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000702\",\"temp_pin\":\"$TEMP\"}"
```

Copy `setup_token` into `SETUP`, then:

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Wanjiru phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `MANAGER`. Repeat the three requests for the attendant: phone `0712000703`, name `Baraka`, role `ATTENDANT`. Copy their `membership_id` into `ATT_ID` and their `access_token` into `ATTENDANT`.

The manager creates maize flour and receives very little stock: 2 pieces and 3 cartons.

```bash
cmd $MANAGER product.create "{\"product_id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"Maize flour 2kg\",\"pack_types\":[{\"pack_type_id\":\"$PIECE\",\"name\":\"piece\",\"units_per_pack\":1,\"sell_price\":\"180\"},{\"pack_type_id\":\"$CARTON\",\"name\":\"carton of 24\",\"units_per_pack\":24,\"sell_price\":\"4200\"}]}"
```

```bash
cmd $MANAGER stock.receive "{\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":2},{\"pack_type_id\":\"$CARTON\",\"quantity\":3}]}"
```

## 3. An oversell: the owner is told

The attendant sells 5 pieces when only 2 are in stock:

```bash
cmd $ATTENDANT sale.create "{\"sale_id\":\"$SALE_A\",\"local_ref\":\"A-0001\",\"location_id\":\"$SHOP\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":5,\"unit_price\":\"180\"}],\"payments\":[{\"method\":\"CASH\",\"amount\":\"900\"}]}"
```

Expect `"status":"FLAGGED"`, `"reason":"STOCK_NEGATIVE"`. The sale is saved; the owner gets a notification in the same transaction:

```bash
curl -s $API/notifications -H "authorization: Bearer $OWNER"
```

```bash
curl -s $API/notifications/unread-count -H "authorization: Bearer $OWNER"
```

Expect one `sale.flagged` with `"message":"Sale #1 was flagged: Stock went negative."` (ids and numbers only: no names), and `{"unread":1}`. Mark everything read:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/notifications/read -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"all":true}'
```

Expect `204`, and the unread count is now `0`.

## 4. A carton is broken into pieces: the owner is told

```bash
cmd $MANAGER stock.convert "{\"location_id\":\"$SHOP\",\"from_pack_type_id\":\"$CARTON\",\"to_pack_type_id\":\"$PIECE\",\"quantity\":1}"
```

The owner's list now starts with `stock.converted`, `"A pack was broken into smaller units."`, unread. Had the owner converted it, nobody would be told (never the person who caused the event).

## 5. A void with the manager's PIN: in-app and a fake push

The manager's phone registers its push token (the real app does this by itself):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT $API/devices/me/push-token -H "authorization: Bearer $MANAGER" -H 'content-type: application/json' -d '{"push_token":"walkthrough-token"}'
```

The attendant asks for the manager's PIN on the attendant's phone, then voids sale A:

```bash
curl -s -X POST $API/stock/approvals -H "authorization: Bearer $ATTENDANT" -H 'content-type: application/json' -d "{\"approver_membership_id\":\"$MANAGER_ID\",\"approver_pin\":\"2468\",\"purpose\":\"SALE_VOID\"}"
```

Copy `approval_id` into `APPROVAL`, then:

```bash
cmd $ATTENDANT sale.void "{\"sale_id\":\"$SALE_A\",\"reason\":\"MISTAKE\",\"approval_id\":\"$APPROVAL\"}"
```

```bash
curl -s $API/notifications -H "authorization: Bearer $MANAGER"
```

Expect one `approval.used`: `"Your PIN approved a sale void."`. Within a second or two, terminal 2 (the worker) shows a line with `"msg":"push delivered"` and `"outcome":"OK"`: the fake push to the manager's phone. The line has the notification id and device id only, never the token or the text.

## 6. A field day closes short: the owner is told

Create the field attendant as in step 2: phone `0712000704`, name `Otieno`, role `FIELD_ATTENDANT`; copy their `membership_id` into `FIELD_ID` and their `access_token` into `FIELD`. Then the van, and 5 pieces into it:

```bash
curl -s -X POST $API/locations -H "authorization: Bearer $OWNER" -H 'content-type: application/json' -d "{\"name\":\"Van 1\",\"kind\":\"FIELD\",\"assigned_membership_id\":\"$FIELD_ID\"}"
```

Copy its `id` into `VAN`.

```bash
cmd $MANAGER stock.issue "{\"from_location_id\":\"$SHOP\",\"to_location_id\":\"$VAN\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"quantity\":5}]}"
```

The field phone syncs, then the manager counts only 4 pieces and closes:

```bash
curl -s "$API/sync/snapshot?limit=1" -H "authorization: Bearer $FIELD" > /dev/null
```

```bash
cmd $MANAGER settlement.close "{\"settlement_id\":\"$SETTLEMENT\",\"field_location_id\":\"$VAN\",\"cash_received\":\"0\",\"lines\":[{\"pack_type_id\":\"$PIECE\",\"counted_quantity\":4}]}"
```

The owner's list now starts with `settlement.variance`: `"A field settlement closed with a cash variance of KES 0.00 and 1 line with a count difference."`. The owner's phone has no push token, so its push ends `DEAD` with `NO_PUSH_TOKEN` (no error is recorded for that).

## 7. A phone stops syncing: the stale-device job tells the owner once

Pretend the attendant's phone last synced 4 days ago:

```bash
sql "UPDATE device SET last_sync_at = now() - interval '4 days' WHERE registered_by_membership_id = '$ATT_ID'"
```

The job runs every day at 04:00 UTC (07:00 Nairobi); run it now instead:

```bash
pnpm job:run devices.stale
```

Wait a few seconds (the worker logs `"stale devices checked"`), then check the owner's list: one `device.stale`, `"A phone has not synced for 4 days."`. Run the job again: still one (the same quiet spell is never reported twice).

## 8. A broken balance: the integrity job records it for support

Corrupt the shop's piece balance on purpose (only ever on your local database):

```bash
sql "UPDATE stock_balance SET quantity = quantity + 1 WHERE location_id = '$SHOP' AND pack_type_id = '$PIECE'"
```

```bash
pnpm job:run stock.integrity
```

```bash
sql "SELECT source, code, detail FROM error_event WHERE code = 'INTEGRITY_MISMATCH'"
```

Expect one row: `stock.integrity`, `INTEGRITY_MISMATCH`, and `pools=1` followed by short ids of the shop and the pack type. Nobody gets a notification: this is for support, not for shops. Put the balance back:

```bash
sql "UPDATE stock_balance SET quantity = quantity - 1 WHERE location_id = '$SHOP' AND pack_type_id = '$PIECE'"
```

## 9. A second business sees none of it

Sign up a second shop with phone `0712000709` and email `worker-second@example.com` (the three requests of step 2, business name `Duka B`). Copy its `access_token` into `SECOND`, then:

```bash
curl -s $API/notifications -H "authorization: Bearer $SECOND"
```

```bash
curl -s $API/notifications/unread-count -H "authorization: Bearer $SECOND"
```

Expect an empty list and `{"unread":0}`. Copy the `id` of the owner's newest notification from step 8's list into `NOTE`, and try to mark it read as the second business:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/notifications/read -H "authorization: Bearer $SECOND" -H 'content-type: application/json' -d "{\"ids\":[\"$NOTE\"]}"
```

Expect `204`, the same answer as for any id, and the owner's notification stays unread.

Done. Stop the worker with Ctrl+C in terminal 2. If anything differed from what this page says, note the step and the response.
