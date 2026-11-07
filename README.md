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
| `widget.js` | Scriptable widget for the Home Screen and Lock Screen. It holds no secrets: the token and plan stay in the iPhone Keychain |
| `manifest.json`, `icon.svg` | Home Screen name and icon |
| `supabase/functions/sms-ingest/index.ts` | Backend: SMS parsing, categories and the API |
| `supabase/schema.sql` | Database tables and indexes |
| `tools/Stmt.cs` | Reads SNB statement PDFs without needing any PDF software |
| `tools/extract.ps1` | Runs the reader and checks every row against the running balance |
| `tools/import.ps1` | Turns extracted rows into payments and uploads them. Dry run by default |
| `.gitignore` | Blocks PDFs, exports and `.env` files from this public repo |
| `AGENTS.md` | Full technical reference |

## Using the dashboard

Three tabs: **Home**, **Payments** and **Months**. Months are calendar months in Riyadh time, and "today" is the real date.

### Home

| Part | What it shows |
|---|---|
| Month name, ‹ › | The month you're looking at. It opens on the current month |
| Spent | Spending in that month, so far for the current month |
| Comparison | Against the month before, up to the same day: ▲ more, ▼ less, or "about the same" when the difference is under 100 SAR or 5%. **Hidden when either month is missing days**, because missing SMS would look like saving. That includes a few empty days at the start of a month when they end a longer gap |
| Warning | Missing days next to the total, or "Last payment was …" when nothing has arrived for 3 days |
| Chart | This month's running total (blue) against last month's (grey) |
| Left this month | With a savings plan: what's left after saving, spending and money sent to people, and how much that is a day. A past month shows how it ended against the plan |
| Heads-up | At most one, current month only, in this order: "Salary is in, move X to savings"; a possible duplicate or unrecognised SMS from the last 7 days (tap it to open Review); a warning when spending at this pace leaves less than your monthly saving; a subscription that changed price or is new; an unusually big payment from the last 3 days; a category far above its usual pace; fixed costs due in the next 7 days |
| Where it went | Top 4 categories plus Other. Tap one to see its payments |
| Latest or Biggest | The last 5 payments for the current month, or the 5 biggest for a past month. Tap one to edit it |

### Payments

Every payment, newest first, grouped by day. Search matches the merchant, category, note or amount. Opened from a category or "See all", it's filtered to that month; tap the chip to clear it. Tap a payment to edit it. A payment far above your normal at that place says "usually X here".

- **Review** (top right, when there's something to check): possible duplicates (same place and amount from SMS within 2 minutes; delete one, or tap "Both are real"), SMS that weren't recognised, and Uncategorized payments.
- **Export**: every payment as a CSV file, through the share sheet, for Excel or Numbers.

### Months

| Part | What it shows |
|---|---|
| Savings goal | With a savings plan: saved so far against the goal, and whether that's on track. If you're behind, how much a month still reaches the goal on time. Tap Edit to change the plan |
| Usual month | Average of the last 3 complete months |
| Bars | Spending per month for the last 12 months. "so far" is the current month; "partial" means days are missing. Tap one to open it on Home |
| Habits | No-spend days this month (rent and bills don't count), Fri–Sat against other days over the last 8 weeks, and small payments you make often with their yearly cost |
| Every month | Fixed costs: the same merchant and amount about once a month, on about the same day, and what subscriptions cost a year. A changed price shows "was X". Food, groceries, transport, shopping and fuel are never treated as fixed costs |
| Balance | From bank statements only, so it ends at the latest statement. After 35 days it asks for a newer one |

### Editing a payment

Tap a payment to:

- **Change its category**, or choose "New category..." to create one.
- **Apply it to all of them** with "Use for all...": every payment from that merchant, or every transfer with that person, whatever the capitals or spacing ("JAHEZ " and "Jahez" count as one). Money received from them keeps its own category. This changes past payments and saves a rule for new SMS and for statement imports.
- **Add a note.**
- **Not count it**, for things like a duplicate you want to keep.
- **Delete it.** This is permanent, and it's asked to be confirmed first.

### Savings plan

On Months, tap **Set a savings plan** and enter your monthly salary, salary day, how much you save each month, your goal and the first month. **The plan is kept only on this phone**, so it's never in the public repo or the database, and you'd enter it again on a new phone.

When you move money to your savings account, tap that transfer, choose **Savings**, tick **Use for all transfers with this person**, and save. New transfers to that account are then recognised automatically. Savings never count as spending, and money sent back from the same account is taken off what you've saved.

### Rent paid by transfer

Transfers don't count as spending until they have a category. To count rent: tap the rent transfer, choose **Rent & Housing**, tick **Use for all transfers with this person**, and save. Past rent changes at once, and new rent SMS get the category automatically.

## How money is counted

Each payment has a `kind`:

| Kind | Meaning | Effect on the dashboard |
|---|---|---|
| `purchase` | Card, Apple Pay, online or international payment | Adds to Spent |
| `fee` | Transfer fee and its VAT | Adds to Spent |
| `refund` | Refund or reversal | Subtracts from Spent |
| `transfer_out` | Money sent to a person | Adds to Spent once its category isn't Transfers or Savings, for example Rent & Housing. Savings go to the savings goal instead |
| `income` | Salary and government support | Not spending |
| `cash_in` | ATM cash deposit | Not spending |
| `transfer_in` | Money received from a person | Not spending |
| `unknown` | SMS that wasn't recognized | Left out until you review it |

Things to keep in mind:

- Transfers to friends and family stay out of Spent unless you give them a category.
- Payments you mark "Don't count this payment" count nowhere, but stay in the list.

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

4. Optional, a notification after each payment: add **Get Dictionary Value** (key `notice`, from Contents of URL), then **If** (Dictionary Value has any value) with **Show Notification** (Dictionary Value) inside it. It reads like "Jahez 45.50 · Food & Cafes · 3,240 spent this month". Login codes return no notice, so they stay silent.

### 4. Home Screen

Open the site in Safari, enter the token, then choose Share > Add to Home Screen.

### 5. Optional: Siri and widgets

- **Siri:** make a shortcut named, say, "My spending" with **Get Contents of URL** (the URL above plus `?action=summary`, method GET, header `x-api-key`), **Get Dictionary Value** (key `text`) and **Speak Text**. "Hey Siri, my spending" then says what you've spent this month and how that compares with last month.
- **Widgets:** install the free Scriptable app, add a script, paste `widget.js`, and run it once to enter your token, salary and monthly saving (kept in the iPhone Keychain). Then add a Scriptable widget to the Home Screen (small, medium or large) or the Lock Screen (circular) and choose the script. The large one adds where the money went: your 3 biggest categories this month. When days are missing, the widget names them instead of comparing with last month. The Lock Screen shows only a ring with the percentage of this month's money used.

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
| Old payments disappear | The deployed function is older than `index.ts` and stops at 1000 rows | Redeploy `sms-ingest` |
| Rent isn't in Spent | The rent transfer is still in Transfers | See "Rent paid by transfer" |
| Home says the last payment was days ago | The Shortcut stopped sending | Check the automation, then import a statement for the missing days |
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

- **Widgets** refresh when iOS allows, usually every 15 to 30 minutes, and tapping one opens Safari rather than the Home Screen app.
- **Savings withdrawals** are matched by the account's name, so money sent back from savings is only subtracted when the SMS shows the same name both ways.
- **Fixed costs** must repeat with exactly the same amount, so a phone bill that changes every month isn't listed under Every month.
- **Rent across a month boundary:** paying on the 31st instead of the 1st puts two rents in one month, and the comparison jumps by that amount.
- **One account:** built for one person, one SNB account and SAR.
- **SMS formats:** only online purchase, POS purchase and outgoing transfer messages have been checked against real SMS.
- **Shop names:** statements often have location labels or no shop name for online purchases, so some merchants are generic until renamed in a future version.
- **Merchant rename:** not available in the dashboard yet.
- **Statement upload:** there's no upload in the dashboard; imports run on a PC.
- **Device time:** displayed times are always Riyadh time.
- **Interface:** English only.
