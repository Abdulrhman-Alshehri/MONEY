# Guide for AI agents

The complete technical reference. Read [README.md](README.md) first for what the product does and how it's used.

## Rules

**Never do these:**

1. Commit or print `APP_TOKEN`, the Supabase service key, statements, database exports or real transaction rows. **The repo is public.**
2. Put private working files in this folder. The whole folder can be published by Netlify, so use a location outside it.
3. Store raw statement descriptions. They contain national IDs, account numbers and IBANs, including other people's.
4. Add public RLS policies or expose `raw_text` through the API.
5. Put real names, card digits or account numbers in code, tests or docs. Use made-up examples.

**Ask the user first:**

- Before renaming `sms-ingest`, changing its URL or changing the `x-api-key` check. The Shortcut can't be updated remotely, and SMS would be lost silently.
- Before bulk updates or deletes on real data, and before running a real import.

**Always:**

- Treat the database as production. It holds the user's real finances.
- Delete test rows you create in the live database.
- Reconcile any statement import against the PDF's page 1 before reporting success.
- Report gaps in the data along with totals.
- Keep `index.ts` and the deployed function identical.

## System map

| Part | Where | Notes |
|---|---|---|
| Frontend | Netlify, from this repo's root | Static, no build step |
| API | Supabase Edge Function `sms-ingest` | Deno, `verify_jwt` off, deploys separately from the repo |
| Database | Supabase Postgres | Project ref is in the `API` constant in `index.html` |
| Secret | `APP_TOKEN` (the old token) in Supabase function secrets | Value is never in the repo. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase |
| Sign-in | Face ID passkeys in `passkeys`; device keys and Face ID sessions in `api_keys`, as hashes | See "Who can call the API" |
| SMS input | iOS Shortcuts automation on the user's phone | Agents can't see or change it. With the optional queue (README, step 5) the automation runs `sms.js` in Scriptable instead of posting itself; see "SMS queue" |
| Widgets | `widget.js` in the Scriptable app on the phone | Calls `?action=summary`; the token, salary and saving are in the iPhone Keychain |
| Scheduler | `pg_cron` job `spending-tick`, 7 minutes past every hour | Calls `?action=tick` through `pg_net` with a `cron` key kept in Vault as `cron_key` |
| Push | Web Push sent by the function; the VAPID key pair is in `app_settings` | iPhone needs the Home Screen app and iOS 16.4 or later |
| Backups | Storage bucket `backups` (private) | Every Thursday; the last 12 are kept |
| Statement import | `Stmt.cs`, `extract.ps1`, `import.ps1` on Windows PowerShell 5.1, or `stmt.py` and `stmt_import.py` on Python 3 | No Node, Python or PDF tools were available on the user's laptop. The Python port runs in a cloud session |

## API

Base URL: `https://<project-ref>.supabase.co/functions/v1/sms-ingest`

Every request but the two Face ID unlock calls needs `x-api-key`, checked by `auth()`. Before comparing, the key is normalized: whitespace and invisible direction characters are removed, and Arabic digits are converted. CORS allows all origins and `GET, POST, PUT, PATCH, DELETE`, which is acceptable because auth uses an explicit header and not cookies. Errors come back as JSON with the CORS headers; a body that isn't valid JSON gets `400 {"error":"invalid JSON"}`.

### Who can call the API

| Key | Can do | Where it lives |
|---|---|---|
| `APP_TOKEN`, the old token | Everything, until it's turned off in Security (`app_settings` `legacy_token`) | Function secrets |
| `ingest` device key (`sms_...`) | `POST` an SMS (no `action`), and get its notice | The SMS Shortcut |
| `read` device key (`read_...`) | `GET ?action=summary` | The widget and the Siri shortcut |
| `full` device key (`full_...`) | Everything | A computer, for a statement import; revoke it afterwards |
| Face ID session | Everything, for 12 hours | The app, in `sessionStorage`, after an unlock |
| `cron` key | `POST ?action=tick` | Vault (`cron_key`), for `pg_cron` |

- A wrong key gets `401 {"error":"unauthorized"}`; a key outside its job gets `403 {"error":"forbidden"}`.
- Keys and sessions are 32 random bytes, stored only as SHA-256. A key is shown once, when it's made.
- **Lockout:** 10 wrong keys or failed unlocks from one address (Cloudflare's `cf-connecting-ip`) within 10 minutes lock that address for 15 minutes: `429 {"error":"locked"}`. While locked, the old token is refused even when it's right, so it can't be guessed; device keys and sessions still work, because they're random and can't be guessed anyway. So a Shortcut with its own key never loses an SMS to a lockout.
- The old token can be turned off only from a Face ID session, so turning it off can't lock out the last way in. To turn it back on without the app, delete the `legacy_token` row in `app_settings`.

### POST (no query): ingest an SMS

Body: the SMS as plain text, or JSON with `text` or `message`. JSON may also carry an `id` (letters, digits, `_ . : -`, up to 100): `sms.js`, which queues SMS while offline, sends one, and a repeated `id` returns `{"ok":true,"duplicate":true}` without saving or a notice, so retries are safe. Without an `id`, identical SMS are all kept, since they can be real. It may also carry `at`, the ISO time the queue saved it: an SMS whose text has no date is placed at `at` (if within the last 60 days and not ahead of now), else at the time the server got it, so no row is saved without a date.

```json
{"ok":true,"category":"Transport","amount":16.75,"type":"online","kind":"purchase","merchant":"Jeeny","occurred_at":"2026-11-05T09:30:00+03:00","notice":"Jeeny 16.75 · Transport: 410 this month · 3,240 total"}
```

- New SMS go through your renames (`merchant_aliases`) before their category is chosen.
- `notice` is one line for the Shortcut's notification, made by `notice()`: the payment, its category's total this month (from the summary's `categories`) with its limit if one is set ("Food & Cafes: 640 of 1,500 this month"), and all spending this month. Transfers, salary and savings get their own wording. It leaves out the totals if `summarize()` fails.

- `400 {"error":"empty"}` for an empty body, which is what a manual Shortcut run sends.
- `{"ok":true,"ignored":true}` for messages that look like login codes; nothing is stored.

### POST ?action=import: bulk insert

Body: JSON array of rows with the `payments` columns. Rows whose `ref` already exists are skipped. A row that SMS already saved (see "Statement and SMS overlap") is attached to that SMS row instead of being added. Renames and `merchant_rules` are applied to the new rows; rules skip money received (`transfer_in`, `income`, `cash_in`).

```json
{"ok":true,"received":432,"inserted":420,"matched_sms":12,"categorized_by_rules":12}
```

### POST ?action=rename: rename a merchant

`{"id":"uuid","name":"Laundry","all":true}`. Without `all`, only that payment changes. With `all`, every payment whose `merchantKey()` matches, and new SMS and statement rows through `merchant_aliases`; earlier renames to the old name follow, and a category rule for the old name is copied to the new one. Returns `{"ok":true,"updated":n}`.

### POST ?action=category: rename, merge or delete a category

`{"from":"Doha Trip","to":"Travel"}` changes the category on payments and rules everywhere. Its limit moves too, unless the target already has one. Deleting is a move to `Uncategorized`, which never gets a limit. Returns `{"ok":true,"updated":n}`.

### GET and PUT ?action=limits: monthly category limits

GET returns `[{"category":"Food & Cafes","monthly":1500}]`. PUT sends the whole set in the same shape; categories left out lose their limit, and a limit must be above 0.

### GET ?action=summary: this month in numbers

For the widget, Siri and the SMS notice. Riyadh time; computed by `summarize()` with `counts()`, which **must match `spend()` in `index.html`** (a test compares them on the same data).

```json
{"month":"2026-11","day":6,"days_in_month":30,"spent":2376.59,"sent":303,"last_month":"October","last_same_day":3456.54,"last_total":7629.04,"comparable":true,"stale_days":0,"gaps":[],"top":[{"category":"Food & Cafes","amount":688.45},{"category":"Groceries","amount":412.3},{"category":"Transport","amount":230}],"categories":{"Food & Cafes":688.45,"Groceries":412.3,"Transport":230,"Bills & Telecom":215,"Shopping":199.99,"Fuel":180,"Subscriptions":150.5,"Health":98.35,"Entertainment":85,"Personal Care":70,"Uncategorized":47},"limits":{"Food & Cafes":1500},"text":"You've spent 2,377 riyals this month, 1,080 less than October by this day."}
```

- `sent`: money sent to people (`transfer_out` in `Transfers`), which the plan's "left" subtracts too.
- `comparable` is false when nothing arrived for 3 days (`stale_days`), or when either period (this month so far, last month up to the same day) touches a run of 5+ days without payments, as on the dashboard. Runs are measured in full across month boundaries: 1–3 Mar counts when it ends a gap that began 20 Feb. That's why it reads from 5 days before last month. `text` then gives no verdict.
- `gaps`: those runs from the start of last month to the latest payment, clipped to that period, as `[from, to]` dates (Riyadh, `YYYY-MM-DD`). The dashboard's "No data" warning shows the same ones. `gaps()` here repeats `gaps()` and `incomplete()` in `index.html`; a test compares them.
- `top`: this month's 3 biggest categories by `counts()`, refunds taken off, as "Where it went" on Home.
- `categories`: every category's spending this month, the same way. The SMS notice reads the payment's category from it.
- `limits`: the monthly limits from `category_limits`.

### GET: list payments

Returns every payment as an array, without `raw_text` or `ref`. Supabase caps each request at 1000 rows, so `readAll()` reads in pages with `.range()`. Rows come in insert order (`created_at`, then `id`), so a payment arriving mid-read can't shift a page. The dashboard sorts for itself.

### PATCH ?id=uuid: edit a payment

```json
{"category":"Groceries","note":"text or null","excluded":false,"apply_to_merchant":true}
```

- Only `category`, `note` and `excluded` are written to the row.
- With `apply_to_merchant` and a `category`, it upserts a rule and updates every payment with the same `merchantKey()` (capitals and spacing don't matter), except money received (`transfer_in`, `income`, `cash_in`). The edited row is always updated.
- Returns `{"ok":true,"updated":n}`.

### DELETE ?id=uuid

Permanently deletes one row. Returns `{"ok":true}`.

### Face ID: passkeys (WebAuthn, ES256)

The relying party is the site's host (`RP_ID`, from `SITE`; tests set `APP_ORIGIN`). `cbor()`, `authData()`, `coseToJwk()` and `derToRaw()` read the browser's replies, and WebCrypto checks the signature. Challenges are 32 random bytes in `auth_challenges`, used once (any attempt uses its challenge up) and valid for 5 minutes; at most 10 wait per address.

- `POST ?action=passkey-register-options` (full access): creation options for a platform authenticator with user verification (Face ID), no attestation, excluding passkeys already set up.
- `POST ?action=passkey-register` (full access): the credential (`clientDataJSON`, `attestationObject`, base64url) and a `name`. Checks the challenge, `webauthn.create`, the origin, the site hash, and the user present and verified flags, then keeps the credential id and its public key. Returns `{ok, id, jwk, session: {token, expires_at}}`.
- `POST ?action=passkey-options` (no key): unlock options with this account's passkeys, or `404` before any exist.
- `POST ?action=passkey-login` (no key): the assertion (`clientDataJSON`, `authenticatorData`, `signature`). Checks the challenge, `webauthn.get`, the origin, the site hash, user verification, the signature counter (Apple's stay at 0; one that doesn't go up is refused), and the signature. Returns `{ok, token, expires_at}`: a 12-hour session. A failure counts toward the lockout.
- `GET ?action=passkeys`, `POST ?action=passkey-delete {id}`: list and remove passkeys.
- `POST ?action=logout`: ends the calling session (the app does this when it locks).

### Device keys and the old token

- `GET ?action=keys`: `{"keys":[{"id","name","scope","created_at","last_used_at"}],"legacy":{"off":false,"last_used":"..."}}`, without sessions or revoked keys.
- `POST ?action=keys {name, scope: ingest | read | full}`: `{"ok":true,"id":"...","key":"sms_..."}`. The key is not stored and can't be shown again.
- `POST ?action=keys-revoke {id}`: turns a key off at once. The scheduler's key can't be revoked here.
- `PUT ?action=legacy {off}`: turns the old token off (only from a Face ID session) or back on.

### POST ?action=tick: run the scheduled jobs

Called by `pg_cron` every hour with the `cron` key; see "Scheduled jobs and notifications". Returns `{"ok":true,"done":{"limits":1,"bills":0}}`: each job that ran, with the number of notifications sent, or the backup's details. With the full key, `&force=<job>` (`backup`, `limits`, `bills`, `recap`, `weekly`, `stale` or `all`) runs that job now and returns its messages as `"messages":[{"title","body","tag"}]` without sending or recording them. A forced backup is a real backup.

### Push: GET ?action=push-key, POST ?action=subscribe, ?action=unsubscribe and ?action=push-test

- `push-key`: `{"key":"<base64url>"}`, the public VAPID key the app subscribes with. The key pair is made on first use and kept in `app_settings`.
- `subscribe`: the browser's `PushSubscription.toJSON()`, `{endpoint, keys: {p256dh, auth}}`. The endpoint must be on Apple's, Google's, Mozilla's or Microsoft's push service, so the function never posts anywhere else. Subscribing again updates the row.
- `unsubscribe`: `{"endpoint":"..."}`.
- `push-test`: one message to every device. Returns `{"ok":true,"sent":1,"errors":[]}`; an error names the push service, its status and its reply, such as `web.push.apple.com 410 {"reason":"Unregistered"}`.

### GET ?action=status

`{"last_backup":{"at":"...","file":"2026-11-26.json.gz","payments":1520,"bytes":96000},"devices":1}` for the Months page.

### POST ?action=restore: put back deleted payments

`{"file":"2026-11-07.json.gz","ids":["uuid", ...],"dry":true}` (full access, up to 50 ids). Reads that backup on the server and inserts the listed payments that are no longer in `payments`, exactly as they were (id, ref, seq, balance, text). Nothing from the backup is returned: `dry` answers `{"ok":true,"found":n,"missing":[{id, occurred_at, amount, kind, category, source, seq}]}`, and a real run `{"ok":true,"restored":[...]}`. A deleted payment's id is in the function logs (the `DELETE ?id=` request). A payment deleted before the backup was made isn't in it.

### PUT ?action=bills

The app's fixed costs, sent whole when they change: `[{"key":"stc|230.00","label":"STC","amount":230,"day":3,"category":"Bills & Telecom"}]`. `key` is the app's `fixedKey()`. Bills left out are removed. Returns `{"ok":true,"bills":n}`.

### GET and PUT ?action=bnpl: Tabby and Tamara plans

`[{"id":"<uuid>","provider":"Tabby","amount":95.50,"count":4,"first":"2026-09-15","every":"month","paid":0,"note":null}]`. PUT sends the whole set, as for limits. The app makes each `id`, so a plan saved offline keeps it. `every` is `month` or `2weeks`, `count` is 1 to 36, and `paid` (0 to `count`, default 0) is how many instalments the user marked as paid so far.

## Database

The exact definition is in `schema.sql`. RLS is enabled with no policies on every table; the function uses the service role. The Supabase advisor's "RLS enabled, no policy" notice is therefore expected.

### payments

| Column | Type | Details |
|---|---|---|
| `id` | uuid | Primary key |
| `amount` | numeric, nullable | **Always positive.** Null if an SMS amount wasn't found |
| `currency` | text | Default `SAR`; not used elsewhere |
| `merchant` | text | Merchant, or person for transfers |
| `raw_text` | text | SMS text; null for statements |
| `created_at` | timestamptz | Insert time |
| `type` | text | Payment method; values below |
| `occurred_at` | timestamptz | Payment time, with +03:00 applied |
| `kind` | text | Direction and meaning; values below |
| `category` | text | Free text, default `Uncategorized` |
| `city`, `mcc` | text | Statements only |
| `balance` | numeric | Statements only, balance after this row |
| `source` | text | `sms` or `statement` |
| `ref` | text | Dedupe key. Unique when not null. Null for SMS |
| `seq` | integer | Bank order for statements. Null for SMS |
| `note` | text | User note |
| `excluded` | boolean | True means left out of all totals |

**`type`:** `pos`, `online`, `intl`, `transfer`, `bank`, `atm`, `other`.

**`kind`:** `purchase`, `refund`, `fee`, `income`, `cash_in`, `transfer_in`, `transfer_out`, `unknown`.

Neither has a database constraint, so new values won't error. The frontend must handle them.

`sms_id` (text, unique when not null) holds the `id` that `sms.js` sends with an SMS, so a retry isn't saved twice.

### merchant_rules

`merchant_key` (primary key, from `merchantKey()`: lowercase, single spaces, trimmed), `category`, `updated_at`. Read when an SMS is ingested (purchases and outgoing transfers) and on statement import (everything except money received), and written by PATCH, rename and the category action.

### merchant_aliases

`merchant_key` (primary key, `merchantKey()` of the name as the bank writes it), `name` (the name to use), `updated_at`. Written by rename with `all`, and applied to new SMS and imported statement rows.

### category_limits

`category` (primary key), `monthly` (above 0), `updated_at`. A calendar month's limit for one category, set in the app.

### api_keys

`id`, `name`, `scope` (`full`, `read`, `ingest` or `cron`), `hash` (SHA-256 of the key in hex, unique), `created_at`, `last_used_at`, `revoked_at` (set to turn a key off), `expires_at` (set only for Face ID sessions). The scheduler's `cron` key was made inside the database: the key itself is only in Vault, as `cron_key`. Sessions are deleted a day after they end.

### passkeys

`id` (credential id, base64url), `public_key` (JWK), `sign_count`, `name`, `created_at`, `last_used_at`.

### auth_challenges, auth_failures

`auth_challenges`: `challenge`, `kind` (`register` or `login`), `ip`, `created_at`; one row per challenge waiting to be used. `auth_failures`: `ip`, `fails`, `first_at`, `locked_until`; the lockout's counters.

### push_subscriptions

`endpoint` (primary key), `p256dh`, `auth`, `created_at`, `last_ok_at`. A row the push service answers with 404 or 410 is deleted.

### app_settings

`key` (primary key), `value` (jsonb), `updated_at`. `vapid` holds the push key pair; its private key, a JWK, never leaves the database and the function. `last_backup` holds the latest backup's details, `legacy_token` `{off, last_used}` the old token's switch (its last use is written at most every 10 minutes), and `webauthn_user` the stable user id passkeys are made for.

### notify_log

`key` (primary key), `created_at`. One row per alert sent, so each goes out once: `weekly:2026-11-26`, `recap:2026-11`, `limit80:Food & Cafes:2026-11:1500`, `limit100:...`, `bill:stc|230.00:2026-12`, `bnpl:<plan id>:2`, `stale:2026-11-22`, and `backup:2026-11-26` for the backup.

### bills

`key` (primary key, `fixedKey()`), `label` (the merchant, or the category for a transfer, so rent never shows the landlord's name), `amount`, `day`, `category`, `updated_at`. Written only by `PUT ?action=bills`.

### bnpl_plans

`id`, `provider`, `amount` (each instalment), `count`, `first` (date of the first instalment), `every`, `paid` (instalments marked as paid so far, 0 to `count`), `note`, `created_at`.

## SMS pipeline

Function: `parse()` then `categorize()` in `index.ts`.

### Order of checks

Invisible characters are removed and whitespace collapsed, then, **first match wins**:

| Step | Pattern | Result |
|---|---|---|
| 1 | `otp`, `code`, `رمز`, `كلمة المرور`, `التحقق` | Dropped, never stored |
| 2 | `رواتب` or `راتب` in the message type (the words before the first number or `SAR`), and no `صادر` there | `bank`, `income`, merchant `Salary`. This is how `حوالة واردة راتب` arrives. Checking only the type keeps a transfer from a person named راتب a transfer |
| 3 | `حوالة` or `تحويل` | `transfer`. `transfer_in` if it contains `وارد`, else `transfer_out` |
| 4 | `رواتب` or `راتب` anywhere | `bank`, `income`, merchant `Salary` |
| 4b | `سحب نقدي` | `atm`, `purchase`, merchant `ATM cash withdrawal`, category `Cash withdrawal` (counted as spending). The text after `موقع` becomes the city |
| 5 | `إيداع` or `ايداع` | `atm`, `cash_in`, merchant `Cash deposit` |
| 6 | `إعادة`, `اعادة`, `استرداد`, `عكس`, `مرتجع` | `pos`, `refund` |
| 7 | `شراء`, `خصم`, `سداد` | `purchase`. Type `pos` if it contains `POS`, `intl` if `دولي`, else `online` |
| 8 | Anything else | `unknown`, stored with `excluded=true` |

**Checked against real SMS:** online purchase, POS purchase, salary (`حوالة واردة راتب`), outgoing local transfer, incoming internal transfer, cash withdrawal (`سحب نقدي بالريال - صراف الأهلي ... موقع ...`), cash deposit (`ايداع صراف آلي`, no hamza) and POS refund (`اعادة مبلغ-POS`, no hamza). **Step 4 is still a guess** based on statement wording.

The trigger is any message containing `SAR`, so promotions and messages from other senders reach this code. That's why step 7 exists.

### Message formats

Logical text with line breaks flattened. The phone can display these differently because of right-to-left rendering, so **`SAR 16.75` on screen can be `16.75 SAR` in the data**. This caused a real bug; always test with raw text. Numbers below are made up.

```
شراء انترنت بـ16.75 SAR من 1111* من Jeeny مدى-ابل *2222 في 05/11/26 09:30
شراء-POS بـ2.50 SAR من SHOP NAME مدى-ابل*2222 في 05/11/26 12:37
حوالة صادرة محلية بـ250.50 SAR لـ*3333 PERSON NAME 05/11/26 15:22
حوالة واردة داخلية ب300 SAR من4444* PERSON NAME 05/11/26 10:20
حوالة واردة راتب مبلغ SAR 9000 حساب5555* في 27/11/26 08:00
```

A wallet (another provider) texts its own messages, which also contain `SAR`, with `yyyy-mm-dd` dates. Made-up examples:

```
شراء إنترنت فيزا12 USD (75.10 SAR) رصيد3.20 لدىSAMPLE.APP 2026-11-06 14:13
حوالة صادرة داخلية المبلغ: 40.00 SAR إلى : **5555 2026-11-08 22:51
```

They aren't on the bank account, so they never match a statement row. Each repeats a top-up the bank records as an online purchase (MCC 6012, `Wallets & Finance`) a few seconds earlier; see Known issues. An international purchase can also arrive without its type words or date (`بـ34.77 SAR من 1111* من SHOP بطاقة مدى *2222 في في المملكة المتحدة`, made up): it stays `unknown`.

- **Amount:** number before or after `SAR`.
- **Merchant:** text after a `من` that isn't followed by a digit or `*`, up to `مدى`. Online purchases have two `من`; the first is the account. A wallet's Visa purchase names the shop after `لدى`.
- **Date:** `dd/mm/yy`, or `yyyy-mm-dd` in a wallet's messages, with `hh:mm` on either side. Treated as Riyadh time. Without one, the time the SMS arrived (see `at` above).
- SMS line endings are `\r\n`.

### Category order

1. Fixed: money received (`transfer_in`) to `Transfers`, income to `Income`, cash to `Cash deposit`.
2. `merchant_rules` exact match on the normalized merchant. This includes outgoing transfers, so a landlord marked once as `Rent & Housing` stays that way and counts as spending.
3. Outgoing transfers with no rule: `Transfers`, which the dashboard doesn't count as spending.
4. `KEYWORDS` regex list in `index.ts`, for everything else.
5. `Uncategorized`.

### Duplicates

SMS has no dedupe, on purpose. Identical messages can be real: statements show two identical payments at one merchant in the same minute. A test message sent twice therefore creates two rows.

## Statement pipeline

### PDF format

- SNB e-statement, generated with iText, PDF 1.4, no encryption, about 5 rows per page.
- Text uses custom 2-byte font encodings with ToUnicode maps, so `Stmt.cs` inflates the page streams and decodes them itself.
- **Arabic is stored in visual order** and is rebuilt by `Logical()`. `Pay Apple` in extracted text is an artifact of this.
- Page 1 has account details and controls: start balance, credits and count, debits and count, end balance. Row pages start at page 2.
- Column edges in PDF points, from the drawn table: balance under 98.81, debit under 157.01, credit under 215.63, description under 380.1, type under 508.35, date above that. A new row starts at each `dd/mm/yyyy` in the date column.

### Reconciliation (required)

`extract.ps1` prints totals and checks `previous balance - debit + credit = balance` on every row, reporting any break. Compare to page 1:

- Debit total and count, credit total and count, end balance must all match, with `breaks=0`.
- After dedupe, the imported debits and credits must equal the sum across statements minus the overlap.
- The last page can repeat the previous page's last rows exactly (6 rows in November 2026). The reader then reports a page-1 mismatch and a balance break on the last page. The repeats have identical refs, so the import drops them, and the rows without them must match page 1.

### Statement overlap

Date ranges share an edge day, so the same rows can appear in consecutive statements. `import.ps1` builds:

```
ref = "stmt:<date> <time> <debit> <credit> <balance>"
```

The balance makes this unique even for identical payments in the same minute. Duplicates are removed locally and again by the API. `start balance of the next statement` may differ from `end balance of the previous one` for this reason; that alone isn't an error.

### Statement and SMS overlap

The import matches them. A statement row with the same amount and direction as an SMS row within 3 minutes, which no other statement row has claimed, is attached to that SMS row: the SMS row keeps its merchant, category, note and text, and takes the statement's `ref`, `seq`, `balance`, city and MCC. So the payment counts once, the balance line runs through it, and SMS that never arrived are filled in by the statement. Unrecognised (`unknown`) SMS never match. Check `matched_sms` in the import's answer against the number of SMS in the statement's period.

### Transaction types

Matched against the Arabic type column in `import.ps1`. Order in the script matters.

| Arabic type | kind | type | Category |
|---|---|---|---|
| `شراء عبر نقاط بيع - Apple Pay` | purchase | pos | From MCC |
| `شراء انترنت` | purchase | online | From MCC |
| `عملية شراء عبر الإنترنت` | purchase | online | From MCC; these rows often have no MCC |
| `خصم نهائي للتفويض عبر نقاط بيع`, `خصم جزئي...` | purchase | online | From MCC |
| `شراء نقاط بيع دولي` | purchase | intl | From MCC |
| `إعادة مبلغ نقاط بيع`, `إعادة شراء محلي...`, `عكس شراء...` | refund | keeps its method | By merchant, then MCC |
| `إيداع رواتب`, `إيداع راتب`, `تحويل وارد - حساب المواطن`, `حوالة محلية واردة` | income | bank | Income. `إيداع راتب` (the singular, first seen in November 2026) is named `Salary`: its second line is a reference number, not the payer |
| `إيداع نقدي - صراف آلي` | cash_in | atm | Cash deposit |
| `حوالة فورية محلية واردة`, `تحويل داخلي وارد` | transfer_in | transfer | Transfers |
| Incoming transfer whose first description line starts `عكس` and mentions `نقاط بيع` (a card reversal paid back as a transfer) | refund | intl if `دولي` | Merchant `Card refund` |
| `إيداع مكافأة طلاب`, `مستحقات أخرى من صاحب العمل` | income | bank | Income. Merchant is the payer, from the second description line, as for salary |
| `سحب نقدي ...` (ATM withdrawals) | purchase | atm | `Cash withdrawal`, merchant `ATM cash withdrawal`. Counted as spending, since the cash gets spent |
| `مدفوعات سداد` (SADAD) | purchase | bank | From MCC. Merchant is the first description line, such as the fee's name |
| `شراء نقاط بيع الخليج` (GCC countries) | purchase | intl | From MCC |
| `حوالة فورية محلية صادرة`, `تحويل داخلي صادر` | transfer_out | transfer | Transfers |
| `رسوم تحويل`, `ضريبة القيمة المضافة` | fee | bank | Fees |
| `حوالة صادرة` (seen as a traffic fine) | purchase | bank | Government |

An **unrecognized type falls through as a `purchase`**. When importing, check the row's type list for new ones, especially new credits, or they'll be counted wrongly. The reconciliation won't catch this because totals still match.

Instant outgoing transfers come with separate 0.50 fee and VAT rows. International rows list `Charges` and `VAT CHRG` that are already included in the amount, so don't add them again.

### Merchant names

Statement names aren't clean brand names:

| Description looks like | Merchant becomes |
|---|---|
| `,Location Label` | `Location Label`. Usually a street or district, because the bank leaves the name part empty |
| `NAME,Location` | `NAME`. Statements before August 2026 fill in the name part |
| `City,INTL ATM` | `City (intl)` |
| `riyadh,bolt eu` | `Bolt` |
| Online row with no name, city `Jebah`, MCC 4121 | `Jeeny`, confirmed by matching refunds and SMS |
| Online row, MCC 4121, reference marked `MCF` | `Bolt`, confirmed by matching reversals |
| Online row with no name | `Online: <label>`, such as `Online: Food` |
| Line containing `PLAYSTATION` | `PlayStation` |
| Transfer | The line after the ID line, without `السيد` |

The same shop can have several labels, and different shops can share one. Don't describe generic labels as real brands.

### Date correction

The bank lists rows in posting order, so a purchase just after midnight can carry the previous date. If a `purchase` has an hour under 6 and an earlier time than the previous row on the same date, one day is added. `ref` keeps the original date.

### MCC to category

Defined in `$mccCat` in `import.ps1`:

| Category | MCC codes |
|---|---|
| Food & Cafes | 5812, 5814 |
| Groceries | 5331, 5411, 5441, 5499 |
| Fuel | 5541 |
| Transport | 4121 |
| Travel | 4722, 7011 |
| Subscriptions | 5815, 5818, 7372 |
| Bills & Telecom | 4814, 4816 |
| Wallets & Finance | 6012 |
| Rent & Housing | 6513 |
| Health | 5912 |
| Shopping | 5199, 5399, 5651, 5661, 5942, 5947, 5999 |
| Entertainment | 7832, 7941, 7997 |
| Personal Care | 7210, 7230 |

Other codes become `Uncategorized`. Small local shops often have odd codes, so MCC is a starting guess and the user's edits win. Re-importing doesn't overwrite edits, because existing `ref` rows are skipped.

`Wallets & Finance` (6012) is a real unknown: those online payments could be wallet top-ups or other services.

### Import steps

```powershell
# 1. Find the current highest seq (run in SQL): select max(seq) from payments;
# 2. Extract, with output outside the repo. Oldest PDF first.
.\extract.ps1 -Pdf a.pdf,b.pdf -OutDir C:\private\stmt
# 3. Reconcile against page 1, and review the type list.
# 4. Dry run; prints counts by kind and category.
$env:SNB_WORK="C:\private\stmt"; $env:SEQ_START="<max seq>"; .\import.ps1
# 5. Send, after the user agrees.
$env:SMS_URL="<function url>"; $env:APP_TOKEN="<token>"; $env:CONFIRM_IMPORT="yes"; .\import.ps1
# 6. Delete the output folder.
```

Without Windows (a cloud session), the Python port does the same with the same refs: `python3 -I stmt.py <outdir> a.pdf b.pdf`, which also checks each statement against its page 1, then `SNB_WORK=<outdir> SEQ_START=<seq> python3 -I stmt_import.py` for the dry run, adding `SMS_URL`, `CONFIRM_IMPORT=yes` and `APP_TOKEN` to send. In a cloud session, save the token as a network secret for the Supabase host (header `x-api-key`) instead of an environment variable, so it never appears in the session. `stmt_import.py` repeats `import.ps1` rule for rule, in the same order: change both together.

`SEQ_START` matters: the balance line sorts by `seq`, so a new statement must continue from the current highest. Import statements in date order. Importing an older statement after a newer one needs its `seq` values to sit before the existing ones.

Compiling `Stmt.cs` with `Add-Type` limits it to C# 5 syntax. Scripts need a UTF-8 BOM for Windows PowerShell to read the Arabic correctly, so keep it when editing.

## Scheduled jobs and notifications

`pg_cron` runs `spending-tick` at 7 minutes past every hour (UTC; Riyadh is always 3 hours ahead). It posts to `?action=tick` through `pg_net`, with a 60-second timeout and the `cron_key` from Vault. `tick()` then runs whatever is due, in Riyadh time:

| Job | When (Riyadh) | Once per | What it does |
|---|---|---|---|
| `backup` | Thursday 03:00–08:59 | day | See "Backups" below |
| `limits` | Every hour, 09:00–22:59 | month, category and limit | "Food & Cafes: 1,345 of 1,500" at 80%, "Groceries is over its limit" when over. A category that is 90% fixed costs this month only alerts when over, as `mostlyFixed()`. A raised limit can alert again |
| `bills` | 10:00–21:59 | bill and due month, or instalment | "STC 230 is due Saturday" for a bill due within 2 days and not paid this month (a bill paid this month is due next month, as in `dueSoon()`), and "Tabby 95.50 is due Saturday", "Instalment 3 of 4" |
| `recap` | The 1st, 10:00–21:59 | month | Last month against usual, the biggest category changes and new places, as `recapCard()` |
| `weekly` | Thursday 20:00–23:59 | week | The last 7 days. Bills are listed apart, and day-to-day spending is compared with the average of the 8 weeks before that have no missing days (at least 3 needed), so a week with rent in it doesn't look like a splurge |
| `stale` | 21:00–23:59 | quiet spell | "No payments for 4 days" once nothing has arrived for 3 days |

- **Once only.** An alert claims its `notify_log` key before sending and gives it back if no device got it, so a later hour in the window tries again. The windows are several hours long, so one missed run loses nothing.
- **No devices, no work.** Alert jobs run only while `push_subscriptions` has a row. The backup always runs.
- **Mirrors of the app.** `limitAlerts()` follows `mostlyFixed()`, `billAlerts()` follows `dueSoon()`, `bnplState()` is the same as `bnplState()` in `index.html`, `recapPush()` follows `recapCard()`, and `weekly()` leaves out fixed costs as `habits()` does. Change both together.
- **Bills come from the app.** The server doesn't detect fixed costs itself: after each online load the app sends `fixedCosts()` to `bills` if the list changed. A bill whose merchant or category contains a plan's provider gets no reminder of its own; the plan's reminder covers it.
- **Messages** are `{title, body, tag}`, encrypted for each device (RFC 8291, aes128gcm) and signed with the VAPID key (RFC 8292), with WebCrypto only. The VAPID contact is the site URL in `SITE`, never a personal address. A message replaces an older one with the same tag.
- **Checking on real data:** `POST ?action=tick&force=all` with the full key returns every message without sending anything.

### Backups

Every Thursday morning `backup()` saves `payments` (with `raw_text`), `merchant_rules`, `merchant_aliases`, `category_limits`, `bills` and `bnpl_plans` as one gzipped JSON file, `backups/YYYY-MM-DD.json.gz`, and deletes all but the newest 12. Keys, push devices, settings and the alert log are left out on purpose. To put back payments deleted since a backup, use `POST ?action=restore` (dry run first). To restore more, download the file from Storage in the Supabase dashboard: it holds one array of rows per table, to insert with SQL. Ask the user before restoring over live data.

## Frontend

Everything is in `index.html`.

### Key functions

| Function | Job |
|---|---|
| `load()` | Fetch data and add `_d` (Riyadh time as a Date; read with `getUTC*`). Runs again when the app comes back from the background |
| `spend(p)` | **The single definition of what counts as spending.** Transfers out count once their category isn't `Transfers` or `Savings` |
| `getPlan()`, `openPlan()` | The savings plan, kept in `localStorage` under `plan` on the phone |
| `savedByMonth()`, `goalCard()` | Money moved to savings per month (transfers marked `Savings`, minus money sent back from the same account) and the goal card on Months |
| `planLine()` | "X left · Y a day" on Home. Uses `outflow()`: spending plus money sent to people. Bills and instalments still due this month are held back from the daily figure |
| `render()` | Shows the active tab: `renderHome()`, `renderPay()` or `renderMonths()` |
| `totals()`, `cumulative()` | Category totals and running totals by day, both from `spend()` |
| `paceChart()`, `balChart()` | SVG charts: this month against last month, and the statement balance |
| `gaps()`, `incomplete()`, `partial()` | Runs of 5+ days with no payments, measured in full even where they cross into another month (`incomplete()` adds the days before the first payment). Used for the "No data" warning, holding back the comparison, and "partial" months. `gaps()` in `index.ts` must give the same answers |
| `fixedCosts()` | Same merchant and amount about once a month on about the same day; feeds Every month and "Due this week" |
| `saveReminder()`, `reviewNote()`, `forecast()`, `subsNote()`, `unusualNote()`, `overUsual()`, `dueSoon()` | The single heads-up on Home, first match wins. `reviewNote()` returns `{text, go: 'review'}`, which makes it tappable |
| `duplicatePairs()`, `reviewItems()`, `renderReview()` | Review in Payments: SMS with the same merchant, amount and kind within 2 minutes (pairs marked "Both are real" are kept in `localStorage` under `dupOk`), `unknown` SMS, and Uncategorized spending |
| `unusual()` | Purchases at least 3× the median of 3+ earlier ones at the same place, and 100 or more |
| `subsChanges()` | Fixed costs charged a different amount near their usual day, and new `Subscriptions` merchants this month |
| `habits()`, `smallLeaks()`, `renderHabits()` | No-spend days, Fri–Sat against other days (only days with data, fixed costs left out), small frequent purchases |
| `exportCsv()` | CSV of all payments through the share sheet, with a download fallback. Cells starting with `= + - @` are quoted so spreadsheets don't run them |
| `sameMerchantAs()` | The "Use for all" match, the same as `sameMerchant()` in `index.ts` |
| `edit()` and the `dSave`, `dDel` handlers | Edit sheet, including Rename (`?action=rename`) and "History at this place" |
| `estimates()`, `renderLimits()`, `openLimits()`, `limitNote()`, `mostlyFixed()` | Monthly limits. Estimates are the median of the last 6 complete months, rounded up to 50 (100 from 1,000), for categories spent in at least 3 of them, never Uncategorized. Amber from 80%, red over. A category that is mostly fixed costs this month (rent) only warns when over |
| `sheet()`, `openCategory()`, `openMerchant()` | The category page (this month against limit and usual, last 9 months, top places) and the merchant page (total, usual amount, visits, last 6 months, latest) |
| `payPeriods()`, `renderPayday()` | Salary-to-salary periods on Months: each starts on an income of at least half the plan's salary (1,000 without a plan) within 6 days of the plan's salary day, else on that day |
| `balanceNow()`, `balLine()`, `openBal()` | The live balance: what the user typed (`localStorage` `balance` = `{amount, at}`), plus money in and minus money out for every payment after `at`, leaving out excluded and unrecognised rows |
| `recapCard()` | Last month's recap on Home in the first 5 days; dismissing it stores the month in `recapSeen` |
| `openCats()`, `editCat()`, `catAction()` | The category manager (`?action=category`). `BUILT_IN` categories can't be changed, because the rules depend on their names |
| `act()`, `flush()`, `applyOp()`, `outbox()` | Offline. Each load keeps a copy of the payments in Cache Storage (`data-v1`), used when the server can't be reached. Edits go through `act()`: on no connection or a 5xx they're queued in `localStorage` `outbox`, applied to the copy at once, and sent in order before the next load or on the `online` event. Queued changes are applied again on top of a cached copy |
| `syncBills()` | Sends `fixedCosts()` to `?action=bills` after an online load, only when the list changed (`localStorage` `billsSent`) |
| `bnplState()`, `instalmentsDue()`, `planCovers()`, `bnplGuess()`, `renderBnpl()`, `openBnpl()`, `saveBnpl()` | Tabby and Tamara on Months. A plan's instalments paid are payments whose merchant or category contains the provider (a first instalment paid in a shop shows the shop's name, so the category is what says Tamara), within 1 riyal of the instalment, from 3 days before it falls due, earliest first, each counted for one plan only: the same rules as `bnplState()` in `index.ts`. "Paid so far" (`paid`) counts that many instalments without a payment and starts the search after them, so it never double-counts and works as a minimum. Unpaid instalments this month are held back in `planLine()` and `forecast()` and listed in `dueSoon()`; a fixed cost that a plan covers is left out there. A new plan is filled in from the latest Tabby or Tamara payment no plan has claimed. Saving a plan reloads the payments |
| `renderNotify()`, `turnOnPush()`, `testPush()`, `turnOffPush()`, `syncPush()` | Notifications on Months. The server's key is fetched when the button shows, so one tap asks permission and subscribes straight away, as iOS requires. A subscribed phone sends its subscription again once a day (`pushAt`) in case the server dropped it |
| `loadStatus()`, `renderBackup()` | The backup line on Months, from `?action=status` |
| `authKey()`, `keyRefused()` | The key for every request: this unlock's Face ID session (`sessionStorage` `sess`), else the token saved on this phone (`localStorage` `tok`). A refused session locks the app; a refused token asks again; `429` says to wait |
| `passkey()`, `showLock()`, `unlock()`, `checkHere()`, `lockNow()` | Face ID. With a passkey on this phone (`localStorage` `passkey` = `{id, jwk}`) the app opens locked. The unlock challenge is fetched when the lock screen shows (`prefetchLogin()`), so the tap goes straight to Face ID (iOS wants the WebAuthn call on the tap). Until it arrives the button reads Connecting… and does nothing: the live function takes 3–6 seconds when cold, and a tap without a challenge once opened the offline copy while the server was up, for days. A challenge older than 4 minutes is fetched again first, and one is kept fresh while the lock screen shows. Only when the fetch fails (no connection, 10-second timeout or a 5xx; `loginFailed`) does `checkHere()` check the signature against the saved public key and open the copy on this phone (`localUnlock`). Queued changes then wait. Once a challenge comes back (right after that unlock, on `online`, or on returning to the app), the offline line offers "Tap to update", which unlocks online. Leaving the app for 5 minutes calls `lockNow()`, which also ends the session on the server |
| `setupFaceId()`, `renderSecurity()`, `secAction()` | Security on Months: set up Face ID (the token is then removed from this phone), passkeys, device keys (made in `keyDlg`, shown once with steps), and the old token's switch |

### Conventions

- Every total and chart uses `spend()`, so numbers always agree. `Savings` transfers are never spending; they feed the savings goal.
- `counts()` in `index.ts` repeats `spend()` for the summary endpoint, and its `gaps()` repeats the dashboard's gap rules. Change both together.
- Fixed costs skip `EVERYDAY` categories (food, groceries, transport, shopping, fuel), so a coffee at the same price a month apart isn't a bill.
- **Personal numbers stay on the phone.** The savings plan (salary, monthly saving, goal) lives in `localStorage` under `plan`, and the typed balance under `balance`. Never put them in code, tests, docs or the database: the repo is public. Category limits are the exception, by the user's choice: they live in `category_limits` so the SMS notice and push alerts can use them.
- Other `localStorage` keys: `tok` (until Face ID is set up), `passkey`, `dupOk`, `monthsMode`, `recapSeen`, `limits` and `bnpl` (copies for offline use), `outbox`, `dataAt`, `billsSent`, `pushKey`, `pushAt`, `status`. `sessionStorage` holds `sess`, the Face ID session, so it's gone when the app closes.
- `derToRaw()` exists in both files (the app uses it to check Face ID offline).
- `bnplState()` exists in both files with the same rules, and so does the recap's list of new places, which leaves out transfers so a person's name never appears in a notification.
- Calendar months in Riyadh time. "Today" is the real date, not the latest payment.
- Each number needs something to compare with: Home compares with last month up to the same day. Differences under 100 SAR or 5% read "about the same", and there's no ▲/▼ verdict when either month is missing days.
- Missing days are shown next to the total they affect (project rule).
- Keep Home short: one heads-up at most, top 4 categories, 5 payments, plus the balance line and, early in a month, the recap. Other detail belongs in Payments, Months or the category and merchant pages.
- Netlify's free plan pins a "Powered by Netlify" badge, about 200×64px, over the bottom-right corner, and it can't be hidden on that plan. Keep navigation and buttons out of that corner: that's why the tabs are at the top, and pages end with bottom padding so the last row can scroll clear of it.
- Text: 17px base and nothing under 13px. Whole riyals in lists, exact amounts in the edit sheet.
- Escape all data with `esc()` before `innerHTML`, or use `textContent`. Merchant names come from SMS and are untrusted.
- Dark and light themes use CSS variables, following the phone's setting.
- Charts: one color per chart, thin bars with rounded ends, hairline grids, no dual axes, values in text colors. Categories aren't given separate colors, so more categories never need new hues.
- Default categories are in `DEFAULT_CATS`; others come from the data.

### Local testing

On `localhost`, `API` becomes `/api`, so you can test without touching real data or entering the real token:

- Write a small local server that serves this folder and answers `/api` with a data snapshot. Keep both **outside this folder**.
- That switch only applies on `localhost`. Never make the API URL configurable by URL parameter, because a malicious link could then capture the token.
- For Face ID, run the real `index.ts` handler behind `/api` on the same localhost origin, with `APP_ORIGIN` set to it, and use Chromium's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`, transport `internal`, user verification on).
- Check at 375px and 320px wide, in light and dark, since this is a phone app. Test that nothing overflows.

### Widget

`widget.js` runs in the Scriptable app. It reads `spending.token`, `spending.income` and `spending.save` from the iPhone Keychain (entered when the script runs inside the app), calls `?action=summary`, and keeps the last good result in Scriptable's documents folder for offline use. The plan maths (`left = salary − saving − spent − sent`) matches `planLine()`. Lock Screen sizes show only the ring and percentage, never amounts. The large size adds "Where it went" from the summary's `top`; a widget can't stretch a bar to its own width, so the longest bar is sized from `Device.screenSize()`, kept a little short of the real width. When days are missing, the line under the numbers names the first gap ("No data 20 Feb–3 Mar") instead of comparing, as Home does. It contains the API and site URLs, so update it if either changes. Tests run it against stand-ins for Scriptable's APIs, including a check that the large size fits on the smallest iPhone.

### SMS queue

`sms.js` runs in Scriptable, called by the SMS automation's Run Script action with the message as `args.shortcutParameter` (text, a dictionary with `text`, or a list are all read). It writes the SMS to `spending-sms/queue/<id>.json` under `FileManager.local()` (on the phone, never iCloud), as a `.tmp` file renamed into place so a file is never half written. Then it posts `{text, id, at}` (`at`: when it was saved, so an SMS without a date keeps its time when sent later) and deletes the file on any `ok` answer, including `duplicate` and an ignored login code. The `id` is `sms-<yyyyMMdd-HHmmss>-<8 hex>`, so names sort by time; the server keeps each `id` once. The notification text goes back with `Script.setShortcutOutput()`: the server's `notice`, plus a line for anything that waited.

- The new SMS goes first, then older ones, oldest first. A file another run saved in the last minute is left to that run, so its notice isn't lost (Send now in the app sends everything).
- No connection, 401, 403, 429 or 5xx keeps the file and stops the run, since the rest would fail the same way. Another 4xx keeps that file and moves on. An unreadable file is renamed `.bad` and only reported in the app.
- No new send starts after 15 seconds, and each request times out after 10, so the Shortcut never waits long; the rest go next time. Being stopped at any point loses nothing: the file stays until an `ok`.
- If the file can't be written, the SMS is still posted directly, as before the queue.
- The key is in `spending-sms/key`, not the Keychain: the automation usually runs while the phone is locked, and a Keychain item may not be readable then. Only `sms_` keys are accepted, and each is checked by posting an empty SMS: `400 empty` means it may add SMS, and nothing is saved.
- Tapped ▶ in the app, it shows what's waiting and the last run's result (`spending-sms/last.json`), with Send now and Change key.
- It contains the API URL, so update it if that changes. Tests run it against stand-ins for Scriptable's APIs, with its requests answered by the real `index.ts` handler: offline, a lost answer, a revoked key, server errors, a slow network, two runs at once, a full disk.

### Service worker

`sw.js` is network first and caches only same-origin `GET` requests. API calls go straight to the network. Change the cache name when the list of precached files changes. It shows every push as a notification, because iOS stops delivering to a web app that receives pushes without showing them, and a tap opens the app or brings it forward. A new version takes over at once (`skipWaiting`, `clients.claim`), so the push handler that runs is always the latest.

## Deployment

| Part | How | Goes live |
|---|---|---|
| Frontend | Push if Netlify is linked to the repo; otherwise the site's Deploys page | On deploy |
| Function | Supabase CLI or MCP `deploy_edge_function`, name `sms-ingest`, `verify_jwt` false | **Immediately, and SMS depends on it** |
| Schema | Supabase migration, then update `schema.sql` | Immediately |
| Scheduler | SQL: `cron.schedule('spending-tick', ...)`, as at the end of `schema.sql` | Immediately |

The site publishes the repo root, so the statement tools, `index.ts`, `schema.sql` and the docs are also reachable on the site. They contain no secrets, and the repo is public anyway.

Before deploying the function, send a made-up SMS and delete the row afterward. Live test command:

```powershell
$body = [Text.Encoding]::UTF8.GetBytes("<raw test SMS>")
Invoke-RestMethod -Method Post -Uri $env:SMS_URL -Headers @{"x-api-key"=$env:APP_TOKEN} -ContentType "text/plain; charset=utf-8" -Body $body
```

After deploying, check the scheduled jobs on real data with `POST ?action=tick&force=all`: it returns every message and sends nothing (it does make a real backup).

## Known issues

| Issue | Impact | Suggested fix |
|---|---|---|
| The old token is long-lived | Until it's turned off, anyone who has it has full access | Give the Shortcut and widget their own keys, then turn it off in Security |
| A new phone needs a key once | Face ID passkeys are per phone, and the token leaves a phone once Face ID is set up | Make a full key in Security on the old phone, open the new phone with it, set up Face ID, then revoke the key |
| Generic statement merchant names | Labels such as `Online: Food` cover several shops, so renaming one for all renames them all | Rename those payments one at a time |
| Spending and gap rules exist twice | `spend()` and the gap rules in the dashboard, and `counts()` and `gaps()` in the summary (widget, Siri, notice), must stay identical | Keep the consistency test; change both together |
| Widget refresh and taps | iOS refreshes widgets every 15 to 30 minutes, and a tap opens Safari, not the Home Screen app | Platform limits for a web app |
| Fixed costs need an identical amount | A bill that changes each month isn't listed under Every month or "Due this week" | Group by merchant with a tolerance |
| Rent across a month boundary | Paid on the 31st instead of the 1st, one month has two rents and the comparison jumps | Compare without fixed costs |
| Savings withdrawals matched by name | Money sent back from savings is only subtracted when the SMS shows the account name the same way in both directions | Let the user mark the savings account explicitly |
| Savings plan and balance are per phone | A new phone or a cleared app starts without them | Store them server-side if more than one device is used |
| Live balance is an estimate | It drifts when an SMS never arrives, or for money that moves without one | Correct it in the app; a statement import fills missed SMS |
| Statement and SMS amounts assume SAR | Foreign amounts rely on the bank's conversion | Fine unless SMS formats differ |
| Notifications show amounts | They can be read on the Lock Screen | iOS: Settings > Notifications > Spending > Show Previews: When Unlocked |
| Alerts run hourly | A limit crossed at 14:10 is announced by 15:07; the SMS notice is instant | Fine for summaries and reminders |
| Bills for reminders come from the app | A new fixed cost reaches the server only after the app is opened | Open the app now and then |
| Wallet payments can count twice | A top-up from the bank (an online purchase in `Wallets & Finance`) and the wallet's own SMS for what it paid both count, once the wallet SMS is given a spending category | Give the top-up the purpose's category and delete the wallet SMS, or leave the wallet SMS out of totals |
| The first unlock after a quiet spell is slow | The function starts cold, so the lock screen reads Connecting… for 3–6 seconds | Platform limit; keeping it warm would need a ping every minute or two |
| Instalments are matched by name and amount | A plan counts payments whose merchant or category contains the provider's name, within 1 riyal | Give the payment the provider's category, or set "Paid so far" on the plan |

## Ideas not built yet

- Statement upload in the dashboard
- Alert when the balance is low or a subscription changes
- Arabic interface

## Checklist before finishing a change

- [ ] No secrets or personal data in the diff
- [ ] `spend()` is still the only definition of spending, and `counts()` and `gaps()` in `index.ts` still match the dashboard
- [ ] No personal numbers (salary, savings, names) in code, tests or docs
- [ ] Tested at phone width
- [ ] Test rows removed from the live database
- [ ] Deployed function matches the repo
- [ ] `schema.sql` and these docs are updated
