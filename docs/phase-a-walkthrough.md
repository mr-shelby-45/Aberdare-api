# Phase A walkthrough

A hands-on run of the identity story against your local API (`docs/phase-a-design.md` section 20). It takes about 15 minutes. Write down anything that surprises you; that is the point of doing it by hand.

Everything here is local: the fake SMS and email senders never send anything, and the fixed code `123456` only works for the phones and emails you list below.

## 0. Setup

In `.env` (never commit it), set:

```
AUTH_DEV_FIXED_CODES=true
AUTH_DEV_CODE_ALLOWLIST=+254712000001,+254712000002,+254712000003,+254712000009,owner@example.com,second@example.com
AUTH_RATE_LIMIT_MAX=60
```

`AUTH_DEV_FIXED_CODES` is refused when `APP_ENV=production`, so this can never reach a real server.

Start the database and the API (in a Git Bash terminal):

```bash
docker compose up -d --wait
```

```bash
pnpm start:dev
```

In a second Git Bash terminal, set the address:

```bash
API=http://127.0.0.1:3000/v1
```

Each step below says which value to copy from a response into a variable, for example `OWNER_TOKEN=eyJ...`. Tokens last 15 minutes; if one expires, repeat step 4 (PIN login) for that person.

## 1. The owner signs up

```bash
curl -s -X POST $API/auth/signup/start -H 'content-type: application/json' -d '{"phone":"0712 000 001","email":"Owner@Example.com"}'
```

Expect `202 {"status":"CODES_SENT"}`. Note that the phone and email are normalised (`+254712000001`, `owner@example.com`).

```bash
curl -s -X POST $API/auth/signup/verify -H 'content-type: application/json' -d '{"phone":"0712000001","email":"owner@example.com","phone_code":"123456","email_code":"123456"}'
```

Copy `signup_token` into `SIGNUP`.

```bash
curl -s -X POST $API/auth/signup -H 'content-type: application/json' -d "{\"signup_token\":\"$SIGNUP\",\"owner_name\":\"Amina\",\"business_name\":\"Duka la Amina\",\"business_type\":\"RETAIL\",\"password\":\"baobab-sunrise-73\",\"pin\":\"1357\",\"device\":{\"name\":\"Amina phone\",\"platform\":\"android\"}}"
```

Copy `access_token` into `OWNER_TOKEN`, `device_id` into `OWNER_DEVICE` and `device_secret` into `OWNER_SECRET`. The device secret is shown only this once.

```bash
curl -s $API/me -H "authorization: Bearer $OWNER_TOKEN"
```

Expect the owner membership, the business and every permission.

## 2. The owner creates a manager and an attendant

```bash
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' -d '{"phone":"0712000002","display_name":"Wanjiru","role_preset":"MANAGER"}'
```

```bash
curl -s -X POST $API/staff -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' -d '{"phone":"0712000003","display_name":"Baraka","role_preset":"ATTENDANT"}'
```

From the attendant's response copy `membership_id` into `BARAKA` and `temp_pin` into `TEMP_PIN`. The temp PIN is shown only here; the database holds a hash.

```bash
curl -s $API/staff -H "authorization: Bearer $OWNER_TOKEN"
```

Check: phones are masked to the last 3 digits, and no hash or PIN appears.

## 3. The attendant's first login and activation

```bash
curl -s -X POST $API/auth/first-login -H 'content-type: application/json' -d "{\"phone\":\"0712000003\",\"temp_pin\":\"$TEMP_PIN\"}"
```

Copy `setup_token` into `SETUP`. (Try a wrong temp PIN first if you like: `INVALID_CREDENTIALS`, the same answer as for a phone nobody invited.)

```bash
curl -s -X POST $API/auth/staff/activate -H 'content-type: application/json' -d "{\"setup_token\":\"$SETUP\",\"code\":\"123456\",\"new_pin\":\"2468\",\"device\":{\"name\":\"Baraka phone\",\"platform\":\"android\"}}"
```

Copy `device_id` into `BARAKA_DEVICE` and `device_secret` into `BARAKA_SECRET`.

## 4. The attendant logs in with the PIN

```bash
curl -s -X POST $API/auth/pin -H 'content-type: application/json' -d "{\"device_id\":\"$BARAKA_DEVICE\",\"device_secret\":\"$BARAKA_SECRET\",\"pin\":\"2468\"}"
```

Copy `access_token` into `BARAKA_TOKEN`.

## 5. The attendant is refused a manager-only action

```bash
curl -s $API/staff -H "authorization: Bearer $BARAKA_TOKEN"
```

Expect `403 PERMISSION_DENIED`.

## 6. The owner suspends the attendant; the attendant's next request is refused

```bash
curl -s -X POST $API/staff/$BARAKA/suspend -H "authorization: Bearer $OWNER_TOKEN"
```

```bash
curl -s $API/me -H "authorization: Bearer $BARAKA_TOKEN"
```

Expect `403 MEMBERSHIP_INACTIVE`, even though the access token itself has not expired. Reactivate if you want to continue with Baraka:

```bash
curl -s -X POST $API/staff/$BARAKA/reactivate -H "authorization: Bearer $OWNER_TOKEN"
```

## 7. The owner logs in on a "second phone" with email and password

```bash
curl -s -X POST $API/auth/login -H 'content-type: application/json' -d '{"email":"owner@example.com","password":"baobab-sunrise-73","device":{"name":"Amina tablet","platform":"ios"}}'
```

Expect a new `device_id` and `device_secret`. Try a wrong password too: `INVALID_CREDENTIALS`, the same as for an unknown email.

## 8. Password reset

Wait one minute after the signup in step 1 first (a code to the same email within 60 seconds is silently not sent).

```bash
curl -s -X POST $API/auth/password/forgot -H 'content-type: application/json' -d '{"email":"owner@example.com"}'
```

Expect `202`. Try an email nobody has: the same `202` and the same body.

```bash
curl -s -X POST $API/auth/password/reset -H 'content-type: application/json' -d '{"email":"owner@example.com","code":"123456","new_password":"jacaranda-rain-58"}'
```

Expect `200 {"status":"PASSWORD_RESET"}`. Now the old password fails, the new one works, and every refresh token the owner had is dead (the owner's PIN login on the first phone still works, because the device and PIN did not change).

## 9. A second business cannot see the first

Sign up a second owner exactly as in step 1, with `0712000009` and `second@example.com` (business name "Duka B"). Copy its `access_token` into `B_TOKEN`.

```bash
curl -s $API/staff -H "authorization: Bearer $B_TOKEN"
```

Expect only the second owner. Then try to act on the first business's attendant:

```bash
curl -s -X POST $API/staff/$BARAKA/suspend -H "authorization: Bearer $B_TOKEN"
```

Expect `404 NOT_FOUND`: to business B, Baraka does not exist.

## 10. Look at the audit log

There is no audit endpoint yet (reports are Phase G). To read it, open a database shell as the superuser:

```bash
docker compose exec postgres psql -U postgres -d aberdare -c "SELECT occurred_at, action, target_type, actor_membership_id, metadata, host(ip) AS ip FROM audit_log ORDER BY occurred_at"
```

You should see the signups, device registrations, staff changes, the suspension and reactivation, and the password reset. No metadata value is a PIN, code, token, secret, phone or email.

When you are done, set `AUTH_DEV_FIXED_CODES=false` again.
