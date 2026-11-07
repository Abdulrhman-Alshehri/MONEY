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
- Keep `supabase/functions/sms-ingest/index.ts` and the deployed function identical.

## System map

| Part | Where | Notes |
|---|---|---|
| Frontend | Netlify, from this repo's root | Static, no build step |
| API | Supabase Edge Function `sms-ingest` | Deno, `verify_jwt` off, deploys separately from the repo |
| Database | Supabase Postgres | Project ref is in the `API` constant in `index.html` |
| Secret | `APP_TOKEN` in Supabase function secrets | Value is never in the repo. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase |
| SMS input | iOS Shortcuts automation on the user's phone | Agents can't see or change it |
| Widgets | `widget.js` in the Scriptable app on the phone | Calls `?action=summary`; the token, salary and saving are in the iPhone Keychain |
| Statement import | `Stmt.cs`, `extract.ps1`, `import.ps1` on Windows PowerShell 5.1, or `stmt.py` and `stmt_import.py` on Python 3 | No Node, Python or PDF tools were available on the user's laptop. The Python port runs in a cloud session |

## API

Base URL: `https://<project-ref>.supabase.co/functions/v1/sms-ingest`

Every request needs `x-api-key: <APP_TOKEN>`, or it gets `401 {"error":"unauthorized"}`. Before comparing, both values are normalized: whitespace and invisible direction characters are removed, and Arabic digits are converted. CORS allows all origins, which is acceptable because auth uses an explicit header and not cookies.

### POST (no query): ingest an SMS

Body: the SMS as plain text, or JSON with `text` or `message`. JSON may also carry an `id` (letters, digits, `_ . : -`, up to 100): a Shortcut that queues SMS while offline sends one, and a repeated `id` returns `{"ok":true,"duplicate":true}` without saving or a notice, so retries are safe. Without an `id`, identical SMS are all kept, since they can be real.

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

## Database

The exact definition is in `supabase/schema.sql`. RLS is enabled with no policies on both tables; the function uses the service role. The Supabase advisor's "RLS enabled, no policy" notice is therefore expected.

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

`sms_id` (text, unique when not null) holds the `id` a queuing Shortcut sends with an SMS, so a retry isn't saved twice.

### merchant_rules

`merchant_key` (primary key, from `merchantKey()`: lowercase, single spaces, trimmed), `category`, `updated_at`. Read when an SMS is ingested (purchases and outgoing transfers) and on statement import (everything except money received), and written by PATCH, rename and the category action.

### merchant_aliases

`merchant_key` (primary key, `merchantKey()` of the name as the bank writes it), `name` (the name to use), `updated_at`. Written by rename with `all`, and applied to new SMS and imported statement rows.

### category_limits

`category` (primary key), `monthly` (above 0), `updated_at`. A calendar month's limit for one category, set in the app.

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

- **Amount:** number before or after `SAR`.
- **Merchant:** text after a `من` that isn't followed by a digit or `*`, up to `مدى`. Online purchases have two `من`; the first is the account.
- **Date:** `dd/mm/yy` with `hh:mm` on either side. Treated as Riyadh time.
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
| `إيداع رواتب`, `تحويل وارد - حساب المواطن`, `حوالة محلية واردة` | income | bank | Income |
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

## Frontend

Everything is in `index.html`.

### Key functions

| Function | Job |
|---|---|
| `load()` | Fetch data and add `_d` (Riyadh time as a Date; read with `getUTC*`). Runs again when the app comes back from the background |
| `spend(p)` | **The single definition of what counts as spending.** Transfers out count once their category isn't `Transfers` or `Savings` |
| `getPlan()`, `openPlan()` | The savings plan, kept in `localStorage` under `plan` on the phone |
| `savedByMonth()`, `goalCard()` | Money moved to savings per month (transfers marked `Savings`, minus money sent back from the same account) and the goal card on Months |
| `planLine()` | "X left · Y a day" on Home. Uses `outflow()`: spending plus money sent to people |
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
| `edit()` and the `dSave`, `dDel` handlers | Edit sheet and API calls |

### Conventions

- Every total and chart uses `spend()`, so numbers always agree. `Savings` transfers are never spending; they feed the savings goal.
- `counts()` in `index.ts` repeats `spend()` for the summary endpoint, and its `gaps()` repeats the dashboard's gap rules. Change both together.
- Fixed costs skip `EVERYDAY` categories (food, groceries, transport, shopping, fuel), so a coffee at the same price a month apart isn't a bill.
- **Personal numbers stay on the phone.** The savings plan (salary, monthly saving, goal) lives in `localStorage` under `plan`. Never put it in code, tests, docs or the database: the repo is public.
- Calendar months in Riyadh time. "Today" is the real date, not the latest payment.
- Each number needs something to compare with: Home compares with last month up to the same day. Differences under 100 SAR or 5% read "about the same", and there's no ▲/▼ verdict when either month is missing days.
- Missing days are shown next to the total they affect (project rule).
- Keep Home short: one heads-up at most, top 4 categories, 5 payments. Other detail belongs in Payments or Months.
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
- Check at 375px and 320px wide, in light and dark, since this is a phone app. Test that nothing overflows.

### Widget

`widget.js` runs in the Scriptable app. It reads `spending.token`, `spending.income` and `spending.save` from the iPhone Keychain (entered when the script runs inside the app), calls `?action=summary`, and keeps the last good result in Scriptable's documents folder for offline use. The plan maths (`left = salary − saving − spent − sent`) matches `planLine()`. Lock Screen sizes show only the ring and percentage, never amounts. The large size adds "Where it went" from the summary's `top`; a widget can't stretch a bar to its own width, so the longest bar is sized from `Device.screenSize()`, kept a little short of the real width. When days are missing, the line under the numbers names the first gap ("No data 20 Feb–3 Mar") instead of comparing, as Home does. It contains the API and site URLs, so update it if either changes. Tests run it against stand-ins for Scriptable's APIs, including a check that the large size fits on the smallest iPhone.

### Service worker

`sw.js` is network first and caches only same-origin `GET` requests. API calls go straight to the network. Change the cache name when the list of precached files changes.

## Deployment

| Part | How | Goes live |
|---|---|---|
| Frontend | Push if Netlify is linked to the repo; otherwise the site's Deploys page | On deploy |
| Function | Supabase CLI or MCP `deploy_edge_function`, name `sms-ingest`, `verify_jwt` false | **Immediately, and SMS depends on it** |
| Schema | Supabase migration, then update `supabase/schema.sql` | Immediately |

The site publishes the repo root, so `tools/`, `supabase/` and the docs are also reachable on the site. They contain no secrets, and the repo is public anyway.

Before deploying the function, send a made-up SMS and delete the row afterward. Live test command:

```powershell
$body = [Text.Encoding]::UTF8.GetBytes("<raw test SMS>")
Invoke-RestMethod -Method Post -Uri $env:SMS_URL -Headers @{"x-api-key"=$env:APP_TOKEN} -ContentType "text/plain; charset=utf-8" -Body $body
```

## Known issues

| Issue | Impact | Suggested fix |
|---|---|---|
| One shared token, no rate limiting | A weak token can be guessed | Long random token; consider real auth |
| Generic statement merchant names | Labels such as `Online: Food` cover several shops, so renaming one for all renames them all | Rename those payments one at a time |
| Spending and gap rules exist twice | `spend()` and the gap rules in the dashboard, and `counts()` and `gaps()` in the summary (widget, Siri, notice), must stay identical | Keep the consistency test; change both together |
| Widget refresh and taps | iOS refreshes widgets every 15 to 30 minutes, and a tap opens Safari, not the Home Screen app | Platform limits for a web app |
| No in-app review list for `unknown` rows | Unrecognized SMS sit in the list, dimmed | Add a review filter |
| Fixed costs need an identical amount | A bill that changes each month isn't listed under Every month or "Due this week" | Group by merchant with a tolerance |
| Rent across a month boundary | Paid on the 31st instead of the 1st, one month has two rents and the comparison jumps | Compare without fixed costs |
| Savings withdrawals matched by name | Money sent back from savings is only subtracted when the SMS shows the account name the same way in both directions | Let the user mark the savings account explicitly |
| Savings plan is per phone | A new phone or a cleared app starts without the plan | Store it server-side if more than one device is used |
| Statement and SMS amounts assume SAR | Foreign amounts rely on the bank's conversion | Fine unless SMS formats differ |

## Ideas not built yet

- Monthly budgets per category
- Statement upload in the dashboard
- Alert when the balance is low or a subscription changes
- Salary-to-salary view, since balance follows the pay cycle
- Arabic interface

## Checklist before finishing a change

- [ ] No secrets or personal data in the diff
- [ ] `spend()` is still the only definition of spending, and `counts()` and `gaps()` in `index.ts` still match the dashboard
- [ ] No personal numbers (salary, savings, names) in code, tests or docs
- [ ] Tested at phone width
- [ ] Test rows removed from the live database
- [ ] Deployed function matches the repo
- [ ] `schema.sql` and these docs are updated
