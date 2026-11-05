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
| Statement import | `tools/`, run on Windows PowerShell 5.1 | No Node, Python or PDF tools were available on the user's laptop |

## API

Base URL: `https://<project-ref>.supabase.co/functions/v1/sms-ingest`

Every request needs `x-api-key: <APP_TOKEN>`, or it gets `401 {"error":"unauthorized"}`. Before comparing, both values are normalized: whitespace and invisible direction characters are removed, and Arabic digits are converted. CORS allows all origins, which is acceptable because auth uses an explicit header and not cookies.

### POST (no query): ingest an SMS

Body: the SMS as plain text, or JSON with `text` or `message`.

```json
{"ok":true,"category":"Transport","amount":16.75,"type":"online","kind":"purchase","merchant":"Jeeny","occurred_at":"2026-11-05T09:30:00+03:00"}
```

- `400 {"error":"empty"}` for an empty body, which is what a manual Shortcut run sends.
- `{"ok":true,"ignored":true}` for messages that look like login codes; nothing is stored.

### POST ?action=import: bulk insert

Body: JSON array of rows with the `payments` columns. Rows whose `ref` already exists are skipped.

```json
{"ok":true,"received":432,"inserted":432}
```

### GET: list payments

Returns every payment as an array, without `raw_text` or `ref`. Supabase caps each request at 1000 rows, so `readAll()` reads in pages with `.range()`. Rows come in insert order (`created_at`, then `id`), so a payment arriving mid-read can't shift a page. The dashboard sorts for itself.

### PATCH ?id=uuid: edit a payment

```json
{"category":"Groceries","note":"text or null","excluded":false,"apply_to_merchant":true}
```

- Only `category`, `note` and `excluded` are written to the row.
- With `apply_to_merchant` and a `category`, it upserts a rule and updates every payment with **exactly the same** `merchant` text. The rule matches case-insensitively, but the bulk update doesn't.
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

### merchant_rules

`merchant_key` (primary key, from `merchantKey()`: lowercase, single spaces, trimmed), `category`, `updated_at`. Read when an SMS is ingested, for purchases and outgoing transfers, and written by PATCH. Statement imports don't use it.

## SMS pipeline

Function: `parse()` then `categorize()` in `index.ts`.

### Order of checks

Invisible characters are removed and whitespace collapsed, then, **first match wins**:

| Step | Pattern | Result |
|---|---|---|
| 1 | `otp`, `code`, `رمز`, `كلمة المرور`, `التحقق` | Dropped, never stored |
| 2 | `حوالة` or `تحويل` | `transfer`. `transfer_in` if it contains `وارد`, else `transfer_out` |
| 3 | `رواتب` or `راتب` | `bank`, `income`, merchant `Salary` |
| 4 | `إيداع` | `atm`, `cash_in`, merchant `Cash deposit` |
| 5 | `إعادة`, `استرداد`, `عكس`, `مرتجع` | `pos`, `refund` |
| 6 | `شراء`, `خصم`, `سداد` | `purchase`. Type `pos` if it contains `POS`, `intl` if `دولي`, else `online` |
| 7 | Anything else | `unknown`, stored with `excluded=true` |

**Checked against real SMS:** online purchase, POS purchase. The transfer pattern was tested with a made-up message in the real layout. **Steps 3 to 5 are unconfirmed guesses** based on statement wording, and need checking against real messages when they arrive.

The trigger is any message containing `SAR`, so promotions and messages from other senders reach this code. That's why step 7 exists.

### Message formats

Logical text with line breaks flattened. The phone can display these differently because of right-to-left rendering, so **`SAR 16.75` on screen can be `16.75 SAR` in the data**. This caused a real bug; always test with raw text. Numbers below are made up.

```
شراء انترنت بـ16.75 SAR من 1111* من Jeeny مدى-ابل *2222 في 05/11/26 09:30
شراء-POS بـ2.50 SAR من SHOP NAME مدى-ابل*2222 في 05/11/26 12:37
حوالة صادرة محلية بـ250.50 SAR لـ*3333 PERSON NAME 05/11/26 15:22
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

**Not handled.** Statement rows have no link to SMS rows, so importing a period SMS already covers counts those payments twice. Before such an import, either skip dates already covered by SMS or match them (same minute and amount) and remove one, after asking the user. The dashboard's balance also relies on statement rows only.

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
.\tools\extract.ps1 -Pdf a.pdf,b.pdf -OutDir C:\private\stmt
# 3. Reconcile against page 1, and review the type list.
# 4. Dry run; prints counts by kind and category.
$env:SNB_WORK="C:\private\stmt"; $env:SEQ_START="<max seq>"; .\tools\import.ps1
# 5. Send, after the user agrees.
$env:SMS_URL="<function url>"; $env:APP_TOKEN="<token>"; $env:CONFIRM_IMPORT="yes"; .\tools\import.ps1
# 6. Delete the output folder.
```

`SEQ_START` matters: the balance line sorts by `seq`, so a new statement must continue from the current highest. Import statements in date order. Importing an older statement after a newer one needs its `seq` values to sit before the existing ones.

Compiling `Stmt.cs` with `Add-Type` limits it to C# 5 syntax. Scripts need a UTF-8 BOM for Windows PowerShell to read the Arabic correctly, so keep it when editing.

## Frontend

Everything is in `index.html`.

### Key functions

| Function | Job |
|---|---|
| `load()` | Fetch data and add `_d` (Riyadh time as a Date; read with `getUTC*`). Runs again when the app comes back from the background |
| `spend(p)` | **The single definition of what counts as spending.** Transfers out count once their category isn't `Transfers` |
| `render()` | Shows the active tab: `renderHome()`, `renderPay()` or `renderMonths()` |
| `totals()`, `cumulative()` | Category totals and running totals by day, both from `spend()` |
| `paceChart()`, `balChart()` | SVG charts: this month against last month, and the statement balance |
| `gaps()`, `partial()` | Runs of 5+ days with no payments, used for warnings and "partial" months |
| `fixedCosts()` | Same merchant and amount about once a month on about the same day; feeds Every month and "Due this week" |
| `overUsual()`, `dueSoon()` | The single heads-up on Home |
| `edit()` and the `dSave`, `dDel` handlers | Edit sheet and API calls |

### Conventions

- Every total and chart uses `spend()`, so numbers always agree.
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
| No SMS and statement matching | Double counting if periods overlap | Match on minute and amount during import |
| One shared token, no rate limiting | A weak token can be guessed | Long random token; consider real auth |
| Generic statement merchant names | Weak merchant ranking | Add a merchant rename feature with an alias table |
| Statement imports don't apply `merchant_rules` | User rules aren't used for later imports; rent paid by transfer arrives as `Transfers` and must be marked again | Apply rules in `?action=import` |
| `apply_to_merchant` only matches exact merchant text | Spelling variants stay unchanged | Compare using `merchantKey()` |
| No in-app review list for `unknown` rows | Unrecognized SMS sit in the list, dimmed | Add a review filter |
| Fixed costs need an identical amount | A bill that changes each month isn't listed under Every month or "Due this week" | Group by merchant with a tolerance |
| Rent across a month boundary | Paid on the 31st instead of the 1st, one month has two rents and the comparison jumps | Compare without fixed costs |
| Statement and SMS amounts assume SAR | Foreign amounts rely on the bank's conversion | Fine unless SMS formats differ |
| `tools/` is Windows-only | Other systems can't run imports | Port if needed |

## Ideas not built yet

- Monthly budgets per category
- Statement upload in the dashboard
- Alert when the balance is low or a subscription changes
- Salary-to-salary view, since balance follows the pay cycle
- Arabic interface
- CSV export

## Checklist before finishing a change

- [ ] No secrets or personal data in the diff
- [ ] `spend()` is still the only definition of spending
- [ ] Tested at phone width
- [ ] Test rows removed from the live database
- [ ] Deployed function matches the repo
- [ ] `schema.sql` and these docs are updated
