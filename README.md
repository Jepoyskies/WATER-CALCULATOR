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

`Remaining` is treated as the master record of who owes what, exactly like your
notes. `540 mang tony` and `Berto 50` both work — the number can go before or
after the name.

---

## What the app checks for you

- **Loaded gallons don't add up** — `35R` with 31 sold and 1 returned.
- **Balances that don't roll forward** — last balance + new utang − collected
  should equal the new balance. When it doesn't, you see the difference.
- **People who vanish from the list** — they were on your last `Remaining` list
  but not the newest one. Either they paid up, or you forgot to carry them over.
- **Written totals that don't match** — `Expenses -450` when the lines add up to
  ₱915.
- **Lines that were not counted** — nothing is silently ignored.

Warnings never block saving. They are there to catch mistakes, not to argue.

---

## The tabs

**📝 Entry** — paste your notes, hit **Calculate**, then **Save Sheet**.
**▶ Start New Day** writes a fresh sheet with today's date and carries every
unpaid balance into `Remaining` automatically.

**📊 Dashboard** — all-time revenue, expenses, utang collected, money still owed,
who owes you most, change you owe, gallons lent out, monthly totals.

**👥 Utang** — one row per customer with what they owe now, what they have been
given, and what they have paid. Tap a name to see how their balance moved
week to week. **Record Manually** handles a payment made on a day you wrote no
notes.

**📅 History** — every saved sheet. Tick two or more and press
**🔗 Combine selected** to merge a weekend into one total (the originals are kept
and **↩️ Undo a combine** splits them back apart).

**💾 Backup** — export/import, automatic file backup, CSV exports and your data.

---

## Moving between laptop and phone

The laptop is the master copy. The phone is for entering the day.

1. Enter the day's notes on the phone and **Save Sheet**.
2. Phone → **Backup** → **Export Backup (.json)** → send the file to yourself.
3. Laptop → **Backup** → **Import from another device** → pick the file.

Importing **merges**: newer copies win by timestamp, nothing is ever deleted, and
importing the same file twice changes nothing.

---

## Keeping your data safe

Everything is stored in a real local database (IndexedDB) inside the browser, not
in a cookie or a login. It survives browser restarts and updates, but **clearing
your browsing data will erase it**.

So the app nags you:

- The header badge shows which database is in use and whether the browser agreed
  to keep it permanently.
- The footer warns you when you have saved sheets but have never exported, or
  when the last backup is over a week old.
- On Chrome or Edge you can pick a backup file once under
  **Automatic file backup**, and the app rewrites it every time you save — so a
  copy always exists outside the browser.

**Export before updating your browser or switching computers.**

---

## Running the tests

Open `dev/tests.html` in the browser. It runs 83 checks covering the parser,
the loaded-gallon reconciliation, every date format, and all the section types.
