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
 (message contains "SAR")      (Home Screen app)            (run on a PC or in a cloud session)
       |                              |       ^                    |
       | POST text                    | API   | push notifications | POST ?action=import
       v                              v       |                    v
 +-----------------------------------------------------------------------+
 |  Supabase Edge Function: sms-ingest  (checks the x-api-key key)       |
 +-----------------------------------------------------------------------+
       |                                      ^
       v                                      | every hour: ?action=tick
 Supabase Postgres (no public access)    pg_cron scheduler: alerts and the weekly backup
 Storage bucket "backups" (private)
```

Why it's built this way:

- **Why a Shortcut:** iOS doesn't let any app read SMS. A Shortcuts automation is the only automatic way to pass a message on.
- **Why a PWA:** a native iOS app needs a Mac or cloud builds, plus an Apple account. A website added to the Home Screen needs neither.
- **Why statements too:** SMS only covers payments from the day the automation started. Statements add history, plus details SMS lacks: balance, city and merchant category code.

## Project files

| Path | What it is |
|---|---|
| `index.html` | The whole dashboard: HTML, CSS and JavaScript. No build step or libraries |
| `sw.js` | Service worker: uses the network first, falls back to cache when offline, and shows push notifications |
| `widget.js` | Scriptable widget for the Home Screen and Lock Screen. It holds no secrets: the token and plan stay in the iPhone Keychain |
| `sms.js` | Optional Scriptable script for the SMS automation: keeps SMS that arrive without internet on the iPhone and sends them later. It holds no secrets: its key stays in Scriptable's storage on the phone |
| `manifest.json`, `icon.svg` | Home Screen name and icon |
| `index.ts` | Backend (the `sms-ingest` function): SMS parsing, categories and the API |
| `schema.sql` | Database tables and indexes, the backup bucket and the hourly scheduler |
| `Stmt.cs` | Reads SNB statement PDFs without needing any PDF software |
| `extract.ps1` | Runs the reader and checks every row against the running balance |
| `import.ps1` | Turns extracted rows into payments and uploads them. Dry run by default |
| `stmt.py`, `stmt_import.py` | The same reader and import in Python 3, for a Mac or a cloud session. The reader also checks each statement against its page 1 |
| `.gitignore` | Blocks PDFs, exports and `.env` files from this public repo |
| `AGENTS.md` | Full technical reference |

## Using the dashboard

Three tabs: **Home**, **Payments** and **Months**. Months are calendar months in Riyadh time (Months can also show salary to salary), and "today" is the real date. Without internet the app opens with the copy on this phone, says so at the top, and keeps your edits until it can send them.

### Home

| Part | What it shows |
|---|---|
| Month name, ‹ › | The month you're looking at. It opens on the current month |
| Spent | Spending in that month, so far for the current month |
| Comparison | Against the month before, up to the same day: ▲ more, ▼ less, or "about the same" when the difference is under 100 SAR or 5%. **Hidden when either month is missing days**, because missing SMS would look like saving. That includes a few empty days at the start of a month when they end a longer gap |
| Warning | Missing days next to the total, or "Last payment was …" when nothing has arrived for 3 days |
| Chart | This month's running total (blue) against last month's (grey) |
| Left this month | With a savings plan: what's left after saving, spending and money sent to people, and how much that is a day once bills and Tabby or Tamara instalments that usually come later this month are held back. A past month shows how it ended against the plan |
| Balance | Tap "Add your balance" and type what your bank app shows. It then moves with every payment after that ("Balance about 3,240"). Tap it to correct it any time. It's kept only on this phone |
| Recap | In the first 5 days of a month, last month in one card: the total against usual, the biggest category changes and new places. Tap × to dismiss it |
| Heads-up | At most one, current month only, in this order: "Salary is in, move X to savings"; a possible duplicate or unrecognised SMS from the last 7 days (tap it to open Review); a category at 80% of its limit or over it (a category of fixed costs, such as rent, only when it goes over); a warning when spending at this pace leaves less than your monthly saving; a subscription that changed price or is new; an unusually big payment from the last 3 days; a category far above its usual pace; fixed costs and instalments due in the next 7 days |
| Where it went | Top 4 categories plus Other, with their limit if set ("of 1,500"). Tap one for its page: this month against the limit and usual, the last 9 months, and the top places, with buttons for its payments, its limit and renaming it |
| Latest or Biggest | The last 5 payments for the current month, or the 5 biggest for a past month. Tap one to edit it |

### Payments

Every payment, newest first, grouped by day. Search matches the merchant, category, note or amount. Opened from a category, a salary month or "See all", it's filtered to that period; tap the chip to clear it. Tap a payment to edit it. A payment far above your normal at that place says "usually X here".

- **Review** (top right, when there's something to check): possible duplicates (same place and amount from SMS within 2 minutes; delete one, or tap "Both are real"), SMS that weren't recognised, and Uncategorized payments.
- **Export**: every payment as a CSV file, through the share sheet, for Excel or Numbers.

### Months

| Part | What it shows |
|---|---|
| Savings goal | With a savings plan: saved so far against the goal, and whether that's on track. If you're behind, how much a month still reaches the goal on time. Tap Edit to change the plan |
| Calendar months / Salary to salary | How the bars below are cut. Salary to salary starts each period on the day your salary arrived (near your plan's salary day, the 27th without a plan). The choice is remembered |
| Usual month | Average of the last 3 complete months (or salary months) |
| Bars | Spending per month for the last 12 months. "so far" is the current one; "partial" means days are missing. Tap a calendar month to open it on Home, or a salary month to list its payments |
| Monthly limits | Each limit with this month's spending, amber from 80% and red when over. Set them from estimates: the median of your last 6 complete months, rounded up. Change any, or leave a box empty for no limit. Limits are saved in your database, so the SMS notification can say "640 of 1,500" |
| Habits | No-spend days this month (rent and bills don't count), Fri–Sat against other days over the last 8 weeks, and small payments you make often with their yearly cost |
| Every month | Fixed costs: the same merchant and amount about once a month, on about the same day, and what subscriptions cost a year. A changed price shows "was X". Food, groceries, transport, shopping and fuel are never treated as fixed costs |
| Tabby & Tamara | Each plan you add: instalments paid of the total, the next due date and what's left. A payment of that amount counts as paid when its merchant or its category is the provider, so a first instalment paid in a shop counts once you give it the Tamara or Tabby category. If one is still missing, set **Paid so far** on the plan. Add fills in a new plan from your latest Tabby or Tamara payment; check the number of instalments. Tap a plan to change or delete it |
| Balance | From bank statements only, so it ends at the latest statement. After 35 days it asks for a newer one |
| Notifications | Turn them on for this phone, send a test, or turn them off. See "Notifications" below |
| Backup | When the latest weekly copy was made and how many payments it holds |
| Security | Face ID for this phone, your passkeys, the keys your devices use, and the old token's switch. See "Face ID and keys" below |
| Categories | Manage: rename a category, merge it into another (type an existing name), or delete it (its payments move to Uncategorized). It changes past payments, rules and limits. Transfers, Savings, Income, Cash deposit and Uncategorized are built in and can't be changed |

### Editing a payment

Tap a payment to:

- **Rename the place** with Rename next to its name: this payment only, or every payment with that name and future ones (the bank's "SAMPLE LAUNDRY CO" can become "Laundry"). Its category rule follows the new name.
- **See its history** with "History at this place": the total, how often, the usual amount and the last 6 months.
- **Change its category**, or choose "New category..." to create one.
- **Apply it to all of them** with "Use for all...": every payment from that merchant, or every transfer with that person, whatever the capitals or spacing ("JAHEZ " and "Jahez" count as one). Money received from them keeps its own category. This changes past payments and saves a rule for new SMS and for statement imports.
- **Add a note.**
- **Not count it**, for things like a duplicate you want to keep.
- **Delete it.** This is permanent, and it's asked to be confirmed first.

### Notifications

On Months, tap **Turn on notifications** and allow them. The iPhone shows notifications only for the app opened from the Home Screen, on iOS 16.4 or later. You get:

- **Thursday evening:** your week. Bills are listed apart, and day-to-day spending is compared with your usual week ("Day to day 790, 12% less than your usual week").
- **The 1st of the month:** last month against usual, the biggest changes and new places, like the recap card.
- **Two days before a bill or an instalment:** "STC 230 is due Saturday", "Tabby 95.50 is due Saturday".
- **Limits:** when a category reaches 80% of its limit, and when it goes over. A category of fixed costs, such as rent, only when it goes over.
- **No SMS for 3 days:** in case the Shortcut has stopped.

Each one is sent once. Alerts are checked every hour, so a limit crossed at 2 pm is announced by about 3 pm; the notification after each SMS is still instant. Notifications show amounts, so if you don't want them on the Lock Screen, set Settings > Notifications > Spending > Show Previews to When Unlocked.

### Face ID and keys

On Months, under Security:

1. **Set up Face ID.** The app then opens locked, and Face ID unlocks it. It locks again when you leave it for 5 minutes. The button reads Connecting… for a few seconds while the server wakes up. Without internet, Face ID opens the copy saved on the phone; once you're back online, tap "Tap to update" at the top (your changes are sent then). The token is removed from the phone, so keep a copy somewhere safe.
2. **New key for the Shortcut.** Choose "The SMS Shortcut", tap Create, then Copy. In Shortcuts, open the SMS automation, then Get Contents of URL, and paste it as the `x-api-key` header's value. If the automation runs the Spending SMS script instead (iPhone automation, step 5), tap ▶ on it in Scriptable and paste the key there. This key can only add SMS.
3. **New key for the widget and Siri.** Choose "The widget and Siri". In Scriptable, run the widget script and paste it in the token field; put it in the "My spending" shortcut's header too. This key can only read the month's summary.
4. **Turn off the old token**, once "Last used" stops changing: anything still using it stops working. You can only turn it off after unlocking with Face ID, so you can't lock yourself out.

Each key is shown only once, and Revoke turns one off at once. 10 wrong keys from one place within 10 minutes lock that place out for 15 minutes; your device keys and Face ID keep working through it. On a new phone, make a full key here first, open the new phone with it, set up Face ID there, and revoke the key.

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
- **Wallet payments count once.** Paying through your wallet sends two SMS: the bank's top-up and the wallet's own message. The wallet's message counts (it names the shop and the real amount), and the top-up next to it is left out with the note "Paid through your wallet". If the wallet's message never arrives, the top-up still counts. A top-up made more than 5 minutes before paying isn't matched, so both count: tick "Don't count this payment" on the top-up.

## Set up from scratch

### 1. Database and backend

1. Create a Supabase project and run `schema.sql` in the SQL editor, after putting the project's ref in the scheduler's URL at the end. It creates the tables, the private `backups` bucket and the hourly scheduler with its own key.
2. Deploy `index.ts` as a function named `sms-ingest`, **with JWT verification off**, because the function does its own token check.
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

4. Optional, a notification after each payment: add **Get Dictionary Value** (key `notice`, from Contents of URL), then **If** (Dictionary Value has any value) with **Show Notification** (Dictionary Value) inside it. It reads like "Jahez 45.50 · Food & Cafes: 410 this month · 3,240 total": the payment, what you've spent in its category this month, and all your spending this month. Login codes return no notice, so they stay silent.

5. Optional, keep SMS that arrive without internet. SMS come in over the phone network even when there's no data (abroad with data roaming off, or a weak signal), but the Shortcut needs internet to send them, so without this they're missing until a statement import fills them in. This step uses Scriptable, the free app the widget runs in. Its script `sms.js` saves each SMS on the iPhone first, sends it, deletes it once the server has it, and sends whatever is still waiting the next time it runs. Everything stays in Scriptable's storage on the phone, not in iCloud, so a full or switched-off iCloud doesn't matter.

   **a. The script.** On the iPhone, open `sms.js` on your site (`https://<your-site>/sms.js`), select all and copy it. In Scriptable tap +, paste it, and name it `Spending SMS`. Then make its key in the app: Months › Security › New key › The SMS Shortcut, Create, Copy. Back in Scriptable, tap ▶ on Spending SMS and paste the key. The script checks the key with the server and keeps it on this iPhone. It only takes SMS keys, which can do nothing but add SMS.

   **b. The SMS automation.** Replace Get Contents of URL (step 3) and the notice (step 4) with:
   1. **Run Script** (Scriptable): Script `Spending SMS`, Parameter: Shortcut Input, then tap it and choose Content (المحتوى). Turn off Run In App and Show When Run.
   2. **If** (إذا) Script Result has any value, with **Show Notification** (إظهار الإشعار) of Script Result inside it.

   The notification is the same notice as before. With no internet it reads "No internet: this SMS is saved on your iPhone and sent once you're online (2 waiting)". When the key is refused, it says what to do.

   **c. Optional: send what's waiting when you join Wi-Fi.** Add an automation: Wi-Fi › Any Network › When Joining, Run Immediately, with the same two actions and no Parameter. Every new SMS also sends what's waiting, so this only matters when you're back online and no SMS comes for a while.

   Sending the same SMS twice is safe: each one carries an `id`, which the server keeps once. A refused key doesn't lose SMS: they wait, with a notification, until you change the key (tap ▶ on Spending SMS › Change key). Tap ▶ any time to see what's waiting, or to Send now.

   To try it: lock the phone with Wi-Fi and Mobile Data off, and have someone text you `شراء-POS بـ1 SAR من TEST SHOP مدى-ابل*0000 في 08/11/26 12:00`. The "No internet" notification should appear. Turn data back on, tap ▶ › Send now, then delete the test payment in the app.

### 4. Home Screen

Open the site in Safari, enter the token, then choose Share > Add to Home Screen.

### 5. Optional: Siri and widgets

- **Siri:** make a shortcut named, say, "My spending" with **Get Contents of URL** (the URL above plus `?action=summary`, method GET, header `x-api-key`), **Get Dictionary Value** (key `text`) and **Speak Text**. "Hey Siri, my spending" then says what you've spent this month and how that compares with last month.
- **Widgets:** install the free Scriptable app, add a script, paste `widget.js`, and run it once to enter your token, salary and monthly saving (kept in the iPhone Keychain). Then add a Scriptable widget to the Home Screen (small, medium or large) or the Lock Screen (circular) and choose the script. The large one adds where the money went: your 3 biggest categories this month. When days are missing, the widget names them instead of comparing with last month. The Lock Screen shows only a ring with the percentage of this month's money used.

## Common tasks

### Import a new statement

Download the statement PDF from SNB and keep it **outside this repo**. Then, in PowerShell from the repo folder (no installs needed on Windows):

```powershell
.\extract.ps1 -Pdf "C:\path\statement.pdf" -OutDir "C:\private\stmt"
```

Compare the printed debit total, credit total, row counts and end balance to page 1 of the PDF, and make sure `breaks=0`. Then do a dry run:

```powershell
$env:SNB_WORK = "C:\private\stmt"
$env:SEQ_START = "<highest seq in the database>"
.\import.ps1
```

If the totals look right, send it:

```powershell
$env:SMS_URL = "https://<project-ref>.supabase.co/functions/v1/sms-ingest"
$env:APP_TOKEN = "<your token>"
$env:CONFIRM_IMPORT = "yes"
.\import.ps1
```

Overlapping statements are safe, because rows already imported are skipped. Rows that SMS already saved are matched to those SMS rows instead of being added again, and the dry run's answer says how many were matched. See "Statement and SMS overlap" in [AGENTS.md](AGENTS.md).

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
| "No internet" or "SMS waiting" notifications | Spending SMS couldn't reach the server: no internet, or the key was refused | They're sent with the next SMS, or when you join Wi-Fi. If the key was refused, make a new SMS key and tap ▶ on Spending SMS › Change key |
| A payment shows twice: a wallet top-up and the wallet's own message | The top-up came more than 5 minutes before the wallet payment, so they weren't matched | Tick "Don't count this payment" on the top-up |
| "Spending SMS stopped: …" | An unexpected error in the script | The SMS is normally saved already: tap ▶ on Spending SMS to see what's waiting, and report the message |
| Old dashboard after an update | Netlify isn't updated, or the old page is still open | Check the Deploys page, then fully close and reopen the app |
| Dashboard keeps asking for the token | Wrong or changed token | Enter the current token |
| Old payments disappear | The deployed function is older than `index.ts` and stops at 1000 rows | Redeploy `sms-ingest` |
| Rent isn't in Spent | The rent transfer is still in Transfers | See "Rent paid by transfer" |
| Home says the last payment was days ago | The Shortcut stopped sending | Check the automation, then import a statement for the missing days |
| Project not responding | Free Supabase projects pause when inactive | Restore it in the Supabase dashboard |
| No notifications | Not turned on for this phone, the app wasn't opened from the Home Screen, or a Focus mode hides them | On Months, check it says "On for this phone" and tap Send a test. Then check Settings > Notifications > Spending |
| "Too many wrong tries" | 10 wrong keys from this place within 10 minutes | Wait 15 minutes. Face ID and device keys keep working meanwhile |
| Shortcut shows `unauthorized` after a change | The old token was turned off, or its key was revoked | Make a new Shortcut key in Security and paste it into the Shortcut |
| App says Offline though you have internet | It couldn't reach the server when you unlocked | Tap "Tap to update" at the top, or close and reopen the app |
| Face ID doesn't open the app | The passkey was deleted from the phone or removed in Security | Tap "Use the token instead", or use a full key, then set up Face ID again |
| Notifications stopped after a while | iOS dropped the subscription | Turn notifications off and on again on Months |

## Security and privacy

- **This repo is public.** Never commit tokens, statements, exports or anything from the database.
- **Face ID opens the app.** The server checks each unlock (a passkey signature) and gives a 12-hour session, kept only until the app closes. The long-lived token is removed from the phone.
- **Each device has its own key:** the Shortcut's can only add SMS, the widget's can only read the summary. Keys are stored only as hashes and can be revoked at once.
- **Waiting SMS stay on the phone.** Spending SMS keeps them, and its key, in Scriptable's storage on the iPhone, never in iCloud, until the server has them.
- **Wrong keys are locked out:** 10 from one place within 10 minutes block it for 15 minutes.
- **The old token still opens everything until you turn it off** in Security. Turn it off once your devices use their own keys.
- **The database is closed.** RLS is on with no policies, so the public Supabase API can't read the tables. All access goes through the function.
- **Statement imports are reduced.** Raw descriptions, national IDs, account numbers and IBANs aren't stored. Names of people you transfer with are kept, because you need them to see where money went.
- **SMS text is stored as received** in `raw_text`, including the last digits of cards and accounts. The API doesn't return it.
- **Login codes aren't saved.** Messages that look like one-time codes are dropped.
- **The scheduler has its own key.** It can only run the scheduled jobs. It was made inside the database and is kept in Supabase Vault; only its hash is in the `api_keys` table.
- **Notifications are encrypted** for your phone, so Apple's push service can't read them. The key that signs them stays in the database. They do show amounts on the Lock Screen unless you hide previews.
- **Backups stay in Supabase:** a private bucket that only the function can read. They include SMS text, as the database does.

## Limitations

- **Widgets** refresh when iOS allows, usually every 15 to 30 minutes, and tapping one opens Safari rather than the Home Screen app.
- **Savings withdrawals** are matched by the account's name, so money sent back from savings is only subtracted when the SMS shows the same name both ways.
- **Fixed costs** must repeat with exactly the same amount, so a phone bill that changes every month isn't listed under Every month.
- **Rent across a month boundary:** paying on the 31st instead of the 1st puts two rents in one month, and the comparison jumps by that amount.
- **One account:** built for one person, one SNB account and SAR.
- **SMS formats:** checked against real SMS for online and POS purchases, salary, outgoing and incoming transfers, cash withdrawal, cash deposit and POS refund. Salary written as رواتب without a transfer is still a guess.
- **Shop names:** statements often have location labels or no shop name for online purchases, so some merchants are generic until you rename them. A generic label such as "Online: Food" can cover several shops, so rename those one payment at a time.
- **Alerts are hourly,** and bill reminders use the fixed costs the app last found, so open the app now and then.
- **Instalment plans** count payments whose merchant or category contains the provider's name, within 1 riyal of the instalment. For anything else, set "Paid so far".
- **Statement upload:** there's no upload in the dashboard; imports run on a PC.
- **Device time:** displayed times are always Riyadh time.
- **Interface:** English only.
