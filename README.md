# 💧 Water Delivery Manager

Tracks your delivery trips, utang and expenses across days — built around the way
you already write your notes, so you can keep pasting them in as-is.

Open `start.bat` (or launch the app at `http://localhost:8000`).

---

## The notes format

A single paste can cover **more than one day** (your Saturday + Sunday weekend).
The `Expenses` / `Credits` / `Remaining` block at the top belongs to the whole
sheet, and each dated section below holds that day's trips.

```
Expenses
100 load
150 angkas
200 gas (800+200 ecosport)
200 food

Credits Paid
200 ricky
75 nene

Credits today
125 oscar
75 perez

Remaining
Berto 50
540 mang tony
100 lito

September 12, 2026 (Saturday)
1st trip
35R
4 return
25x23
20x8

September 13, 2026 (Sunday)
1st trip
35R
2 return may laman
25x30
20x3
```

### Trip lines

| You write | It means |
|---|---|
| `1st trip` | Trip label (optional) |
| `35R` | 35 gallons loaded on the truck |
| `4 return` | 4 empty containers handed back |
| `2 return may laman` | 2 came back still full (never sold) |
| `6 bahay` | 6 gallons taken to your own house |
| `25x23` | 23 sold at ₱25 |
| `20x8` | 8 sold at ₱20 |
| `2145 total` | Your own written total — checked against the lines |

### The maths

Money comes **only** from the `price x qty` lines. Returns and bahay never change
revenue — they explain where the loaded gallons went:

```
loaded  =  sold  +  returned  +  bahay
```

Every trip is checked against that. If `47R` has 47 sold and 1 returned, the app
tells you it is off by one instead of quietly accepting it.

### Sections it understands

| Section | What it tracks |
|---|---|
| `Expenses` | Money out |
| `Credits Paid` | Customers paying you back |
| `Credits today` | New utang you handed out |
| `Remaining` | **Who owes you what** — per person |
| `Customers with change` | Change you owe them |
| `Customers that borrowed gallons` | Containers lent out |

`Remaining` is the master record of who owes what, exactly like your notes.
`540 mang tony` and `Berto 50` both work — the number can go before or after
the name.

### How a balance is worked out

`Remaining` is what the customer **already owed** when you started writing.
`Credits today` is new utang on top of it. `Credits paid` is what they handed
back. So:

```
owes now  =  Remaining  +  Credits today  -  Credits paid
```

Which is exactly how you write it down:

```
Remaining          Credits today
150 Lito           75 Lito        ->  Lito owes 225
125 Ricky          25 Ricky       ->  Ricky owes 150
```

The Entry tab shows that sum as a table (Remaining last / + New utang /
− Paid / Owes now) before you save, and the Utang tab keeps it per customer.

---

## What the app checks for you

- **Loaded gallons don't add up** — `35R` with 31 sold and 1 returned.
- **Balances carried in at the wrong amount** — you ended at one number, then
  started the next `Remaining` list at another.
- **People who vanish from the list** — they were on your last `Remaining` list
  but not the newest one. Either they paid up, or you forgot to carry them over.
- **Written totals that don't match** — `Expenses -450` when the lines add up to
  ₱915.
- **Lines that were not counted** — nothing is silently ignored.
- **Names that might be the same person** — `bernado` vs `bernardo`,
  `tita marie` vs `marie`. It only suggests; it never merges on its own.

Warnings never block saving. They are there to catch mistakes, not to argue.

---

## The tabs

**📝 Entry** — paste your notes, hit **Calculate**, then **Save Sheet**.
**▶ Start New Day** writes a fresh sheet with today's date and carries every
unpaid balance into `Remaining` automatically.

**📊 Dashboard** — all-time revenue, expenses, utang collected, money still owed,
who owes you most, change you owe, gallons lent out, monthly totals.

**👥 Utang** — one row per customer: what they owe now, what they carried in,
what was added, what was paid. Tap a name for the full breakdown and every
`Remaining` list they have been on. **Record Manually** handles a payment made on
a day you wrote no notes. **✏️ Rename / merge** fixes a name later — writing
anything you like is fine, including `aling nena` when you do not know who
they really are; type an existing name and the two ledgers join up.

**📅 History** — every saved sheet. Tick two or more and press
**🔗 Combine selected** to merge a weekend into one total (the originals are kept
and **↩️ Undo a combine** splits them back apart).

**💾 Backup** — export/import, automatic file backup, CSV exports and your data.

---

## Installing it on your phone

The app is a PWA, so it can live on your home screen and open with **no signal
at all** — the whole thing is cached on the device the first time you visit.

**Android (Chrome):** open the site, tap **⋮** → **Add to Home screen** /
**Install app**. It then opens full-screen with its own icon, like a normal app.

**iPhone (Safari):** open the site, tap **Share** → **Add to Home Screen**.

Once installed it works offline, so a trip with no signal is fine. If the phone
has no signal you get a small banner at the bottom; everything still saves.

> Do not use Incognito / Private mode — the browser throws the data away when
> you close the tab.

---

## Moving between laptop and phone

The laptop is the master copy. The phone is for entering the day.

1. Enter the day's notes on the phone and **Save Sheet**.
2. Phone → **Backup** → **Export Backup (.json)**. On a phone this opens the
   share sheet, so you can send it straight to Drive, email, or a chat with
   yourself.
3. Laptop → **Backup** → **Import from another device** → pick the file.

Importing **merges**: newer copies win by timestamp, nothing is ever deleted, and
importing the same file twice changes nothing.

---

## Keeping your data safe

Everything is stored in a real local database (IndexedDB) inside the browser, not
in a cookie or a login. It survives browser restarts, updates, running out of
memory, and the phone rebooting. **Clearing your browsing data or uninstalling
the browser will erase it.**

So the app nags you:

- The header badge shows which database is in use and whether the browser agreed
  to keep it permanently.
- The footer warns you when you have saved sheets but have never exported, or
  when the last backup is over a week old.
- On Chrome or Edge (desktop) you can pick a backup file once under
  **Automatic file backup**, and the app rewrites it every time you save — so a
  copy always exists outside the browser.

**Export before clearing browsing data or switching phones.**

---

## Files

| File | What it is |
|---|---|
| `index.html` | The 5-tab interface |
| `parser.js` | Reads your notes; all the business maths |
| `store.js` | The local database, combining, export/import |
| `app.js` | Screen wiring, tables, modals |
| `style.css` | Styling and the phone layout |
| `sw.js` | Service worker — makes it work offline |
| `manifest.webmanifest` | Makes it installable |
| `dev/tests.html` | The test suite |
| `dev/make-icons.py` | Redraws the app icons |

`sw.js` starts with a `VERSION` line. Bump it whenever you change any file so
phones pick up the new copy.

---

## Running the tests

Open `dev/tests.html` in the browser. It runs 110 checks covering the parser,
the carry-forward balances, the loaded-gallon reconciliation, name matching,
every date format, and all the section types.
