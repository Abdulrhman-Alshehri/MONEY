# MONEY

A personal spending tracker for iPhone. Every SNB-AlAhli payment SMS is saved automatically, and a dashboard shows where the money goes. Older history is imported from SNB PDF statements.

**AI agents and developers:** read this file, then [AGENTS.md](AGENTS.md), before changing anything.

## Contents

- [How it works](#how-it-works)
- [Project files](#project-files)
- [Using the dashboard](#using-the-dashboard)
- [How money is counted](#how-money-is-counted)
- [Set up from scratch](#set-up-from-scratch)
- [Common tasks](#common-tasks)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)

## How it works

```
 SNB-AlAhli SMS
       |
       v
 iOS Shortcuts automation      Dashboard PWA (Netlify)      SNB PDF statements
 (message contains "SAR")      (Home Screen app)            (tools/, run on a PC)
       |                              |                            |
       | POST text                    | GET, PATCH, DELETE         | POST ?action=import
       v                              v                            v
 +-----------------------------------------------------------------------+
 |  Supabase Edge Function: sms-ingest  (checks the x-api-key token)     |
 +-----------------------------------------------------------------------+
       |
       v
 Supabase Postgres: payments, merchant_rules (no public access)
```

Why it's built this way:

- **Why a Shortcut:** iOS doesn't let any app read SMS. A Shortcuts automation is the only automatic way to pass a message on.
- **Why a PWA:** a native iOS app needs a Mac or cloud builds, plus an Apple account. A website added to the Home Screen needs neither.
- **Why statements too:** SMS only covers payments from the day the automation started. Statements add history, plus details SMS lacks: balance, city and merchant category code.

## Project files

| Path | What it is |
|---|---|
| `index.html` | The whole dashboard: HTML, CSS and JavaScript. No build step or libraries |
| `sw.js` | Service worker: uses the network first and falls back to cache when offline |
| `manifest.json`, `icon.svg` | Home Screen name and icon |
| `supabase/functions/sms-ingest/index.ts` | Backend: SMS parsing, categories and the API |
| `supabase/schema.sql` | Database tables and indexes |
| `tools/Stmt.cs` | Reads SNB statement PDFs without needing any PDF software |
| `tools/extract.ps1` | Runs the reader and checks every row against the running balance |
| `tools/import.ps1` | Turns extracted rows into payments and uploads them. Dry run by default |
| `.gitignore` | Blocks PDFs, exports and `.env` files from this public repo |
| `AGENTS.md` | Full technical reference |

## Using the dashboard

### Filters

Filters are in the row at the top and apply to everything on the page, except where noted below.

| Filter | Options |
|---|---|
| Period | All time, last 7, 30 or 90 days, or a single month |
| Category | Any category in use, plus the defaults |
| Method | Apple Pay / in store, online, international, transfer, bank, ATM |
| City | Cities in your data |
| Search | Part of a merchant name |
| Min SAR | Hides smaller payments |
| Transfers | Without transfers (default), or count money you send as spending |

Tapping a bar under category, merchant, method or city applies that filter. Active filters appear as chips; tap a chip to remove it.

"Last 7/30/90 days" counts back from your **latest payment**, not from today.

### What's on the page

| Section | What it shows |
|---|---|
| Data gap warning | Any stretch of more than 5 days with no payments, across all your data |
| Spent | Spending after refunds |
| Money in | Salary, deposits and transfers received |
| Average per day | Spent divided by days from the first to the last payment shown |
| Last known balance | The newest statement balance. **It ignores filters, and SMS has no balance, so it can be out of date** |
| What stands out | Top category, most visited merchant, small payments, largest payment, lowest balance |
| Spending over time | Per day, or per week when the period is over 45 days |
| By category, Top merchants | Ranked bars with SAR amounts |
| Balance | Balance line from statements. Follows the period filter only; the dot marks the lowest point |
| When I spend | Heatmap by weekday and hour |
| Each month | Spent, money in and net. Months with missing days are partial |
| Payment method, City | Ranked bars |
| Looks recurring | The same merchant and amount, 26 to 35 days apart |
| Payments | The list. Tap a payment to edit it |

### Editing a payment

Tap a payment in the list to:

- **Change its category**, or choose "New category..." to create one.
- **Apply it to the merchant** with "Use for all...". This changes that merchant's past payments and saves a rule for new SMS.
- **Add a note.**
- **Leave it out of totals**, for things like a duplicate you want to keep or money that isn't really spending.
- **Delete it.** This is permanent, and it's asked to be confirmed first.

## How money is counted

Each payment has a `kind`:

| Kind | Meaning | Effect on the dashboard |
|---|---|---|
| `purchase` | Card, Apple Pay, online or international payment | Adds to Spent |
| `fee` | Transfer fee and its VAT | Adds to Spent |
| `refund` | Refund or reversal | Subtracts from Spent |
| `transfer_out` | Money sent to a person | Only adds to Spent with "Count transfers" on |
| `income` | Salary and government support | Adds to Money in |
| `cash_in` | ATM cash deposit | Adds to Money in |
| `transfer_in` | Money received from a person | Adds to Money in |
| `unknown` | SMS that wasn't recognized | Left out until you review it |

Things to keep in mind:

- Money in includes transfers from friends, and those can be repayments. It isn't the same as income.
- Payments you mark "Leave out of my totals" count nowhere, but stay in the list.

## Set up from scratch

### 1. Database and backend

1. Create a Supabase project and run `supabase/schema.sql` in the SQL editor.
2. Deploy `supabase/functions/sms-ingest/index.ts` as a function named `sms-ingest`, **with JWT verification off**, because the function does its own token check.
3. Under Edge Functions > Secrets, add `APP_TOKEN` with a long random value of letters and numbers.

### 2. Dashboard

1. In `index.html`, set the `API` constant to `https://<project-ref>.supabase.co/functions/v1/sms-ingest`.
2. On Netlify, link this repo with an empty build command and publish the repo root. Or upload the folder on the site's Deploys page.
3. Uploading to `app.netlify.com/drop` creates a new site and link every time, so use the Deploys page for updates.

### 3. iPhone automation

In the Shortcuts app, go to Automation > + > Message (رسالة):

1. Set **Message Contains** to `SAR`. The SMS sender name may not be selectable, which is why the automation matches on text.
2. Choose **Run Immediately** (تشغيل فوري), with notifications off.
3. Add **Get Contents of URL** (إحضار محتويات الرابط):

| Setting | Value |
|---|---|
| URL | `https://<project-ref>.supabase.co/functions/v1/sms-ingest` |
| Method | POST |
| Header | `x-api-key` = your token |
| Request Body | File (الملف), set to the Shortcut Input's Content (المحتوى) |

Type the header on the English keyboard. To debug, temporarily add a **Show Result** (إظهار النتيجة) action after it.

### 4. Home Screen

Open the site in Safari, enter the token, then choose Share > Add to Home Screen.

## Common tasks

### Import a new statement

Download the statement PDF from SNB and keep it **outside this repo**. Then, in PowerShell from the repo folder (no installs needed on Windows):

```powershell
.\tools\extract.ps1 -Pdf "C:\path\statement.pdf" -OutDir "C:\private\stmt"
```

Compare the printed debit total, credit total, row counts and end balance to page 1 of the PDF, and make sure `breaks=0`. Then do a dry run:

```powershell
$env:SNB_WORK = "C:\private\stmt"
$env:SEQ_START = "<highest seq in the database>"
.\tools\import.ps1
```

If the totals look right, send it:

```powershell
$env:SMS_URL = "https://<project-ref>.supabase.co/functions/v1/sms-ingest"
$env:APP_TOKEN = "<your token>"
$env:CONFIRM_IMPORT = "yes"
.\tools\import.ps1
```

Overlapping statements are safe, because rows already imported are skipped. **Rows that SMS already saved are not matched, so they'd be counted twice.** See "Statement and SMS overlap" in [AGENTS.md](AGENTS.md).

### Change the token

Change it in all three places:

1. Supabase secret `APP_TOKEN`
2. The Shortcut's `x-api-key` header
3. The dashboard, which asks again after a failed login

### Update the dashboard or backend

- **Dashboard:** edit `index.html`, then push (if Netlify is linked) or upload on the Deploys page.
- **Backend:** edit `index.ts`, then redeploy `sms-ingest`. Pushing to GitHub doesn't deploy it.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Shortcut shows `unauthorized` | The header doesn't match the secret, or the header row is empty | Retype both on the English keyboard; check that the secret saved |
| Shortcut shows `empty` when run by hand | There's no SMS when run manually | Normal. Test with a real or test message |
| No row after an SMS | Automation isn't set to Run Immediately, or it didn't fire | Check the automation and the function's logs in Supabase |
| Row has no amount or merchant | A new SMS format | Add the format to `parse()`; see [AGENTS.md](AGENTS.md) |
| Row missing from totals | `kind` is `unknown`, or it's excluded | Check the function's parsing and the payment's settings |
| Same payment twice | A test message sent again | Tap it and delete it |
| Old dashboard after an update | Netlify isn't updated, or the old page is still open | Check the Deploys page, then fully close and reopen the app |
| Dashboard keeps asking for the token | Wrong or changed token | Enter the current token |
| Old payments disappear | Row limit reached | See Limitations |
| Project not responding | Free Supabase projects pause when inactive | Restore it in the Supabase dashboard |

## Security and privacy

- **This repo is public.** Never commit tokens, statements, exports or anything from the database.
- **The token protects everything.** Anyone who has it can read, change and delete your financial data. There's no rate limiting, so it must be long and random. A short one can be guessed.
- **Saved on the phone.** The dashboard keeps the token in the browser's local storage.
- **The database is closed.** RLS is on with no policies, so the public Supabase API can't read the tables. All access goes through the function.
- **Statement imports are reduced.** Raw descriptions, national IDs, account numbers and IBANs aren't stored. Names of people you transfer with are kept, because you need them to see where money went.
- **SMS text is stored as received** in `raw_text`, including the last digits of cards and accounts. The API doesn't return it.
- **Login codes aren't saved.** Messages that look like one-time codes are dropped.

## Limitations

- **Row limit:** the API asks for 5000 rows, but Supabase's default limit is 1000 unless the project setting was changed. Past that, the oldest payments silently stop appearing, which also makes totals wrong. Fix this before reaching 1000 payments.
- **One account:** built for one person, one SNB account and SAR.
- **SMS formats:** only online purchase, POS purchase and outgoing transfer messages have been checked against real SMS.
- **Shop names:** statements often have location labels or no shop name for online purchases, so some merchants are generic until renamed in a future version.
- **Merchant rename:** not available in the dashboard yet.
- **Statement upload:** there's no upload in the dashboard; imports run on a PC.
- **Device time:** displayed times are always Riyadh time.
- **Interface:** English only.
