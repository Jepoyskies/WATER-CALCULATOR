/* ============================================================
   parser.js  (v2 - built around real delivery notes)
   Turns raw daily notes into structured business data.

   Notes model
   -----------
   A single paste can cover several days (e.g. Saturday + Sunday).
   The Expenses / Credits Paid / Credits today / Remaining block at
   the top belongs to the whole sheet; trips below are grouped by
   the date header they appear under.

   Trip model
   ----------
     1st trip           <- label (optional)
     35R                <- 35 gallons loaded on the truck
     4 return           <- empty containers handed back
     2 return may laman <- containers still holding water
     6 bahay            <- gallons taken to our own house
     25x23              <- 23 sold at P25
     20x8               <- 8 sold at P20
     2145 total         <- your own written total (cross-check)

   Money always comes from the "PxQ" lines alone. Returns and bahay
   never change revenue - they explain where the loaded gallons went:
        loaded  =  sold  +  returns  +  bahay

   Exposes window.WCParser
   ============================================================ */
(function (global) {
    'use strict';

    var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    var MONTH_INDEX = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };

    var WEEKDAY_RE = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

    /* =========================================================
       Dates
       ========================================================= */

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function toDateKey(y, m, d) {
        if (!(y >= 1970 && y <= 2200) || !(m >= 0 && m <= 11) || !(d >= 1 && d <= 31)) return null;
        var dt = new Date(y, m, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) return null;
        return y + '-' + pad2(m + 1) + '-' + pad2(d);
    }

    function todayKey() {
        var d = new Date();
        return toDateKey(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function prettyDate(dateKey) {
        if (!dateKey) return '';
        var p = String(dateKey).split('-');
        if (p.length !== 3) return String(dateKey);
        return MONTH_NAMES[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
    }

    function weekdayOf(dateKey) {
        if (!dateKey) return '';
        var p = String(dateKey).split('-');
        if (p.length !== 3) return '';
        var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
    }

    /**
     * Reads a date out of one line.
     * Understands "September 12, 2026 (Saturday)", "Oct 17", "10/18/2026",
     * "2026-10-18", and the same with a trailing weekday in or out of brackets.
     */
    function extractDate(rawLine) {
        var line = String(rawLine == null ? '' : rawLine).trim();
        if (!line) return null;

        // Drop a trailing "(Saturday)" or a bare trailing weekday
        line = line.replace(/\([^)]*\)\s*$/, '').trim();
        line = line.replace(new RegExp('\\s*' + WEEKDAY_RE.source + '\\s*$', 'i'), '').trim();
        line = line.replace(/[,;]\s*$/, '').trim();
        if (!line) return null;

        var m;

        // 2026-10-18
        m = line.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return toDateKey(+m[1], +m[2] - 1, +m[3]);

        // September 12, 2026 / Oct 17 / Oct. 5 2025
        m = line.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?$/);
        if (m) {
            var mm = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
            if (mm === undefined) return null;
            var yr = m[3] ? +m[3] : new Date().getFullYear();
            return toDateKey(yr, mm, +m[2]);
        }

        // 10/18 or 10/18/2026
        m = line.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (m) {
            var year = m[3] ? +m[3] : new Date().getFullYear();
            if (year < 100) year += 2000;
            return toDateKey(year, +m[1] - 1, +m[2]);
        }

        return null;
    }

    /* =========================================================
       Sections
       ========================================================= */

    var SECTIONS = [
        {
            key: 'borrowed',
            kind: 'borrow',
            aliases: ['customers that borrowed gallons from me',
                      'customers that borrowed gallons',
                      'customers who borrowed gallons',
                      'borrowed gallons from me',
                      'borrowed gallons',
                      'borrow gallons',
                      'borrowed']
        },
        {
            key: 'change',
            kind: 'namedAmount',
            aliases: ['customers with change', 'customer with change',
                      'customers with sukli', 'with change', 'change', 'sukli']
        },
        {
            key: 'creditsToday',
            kind: 'namedAmount',
            aliases: ['credits today', 'credit today', 'new credits', 'new credit',
                      'credits given', 'credit given', 'utang today', 'bagong utang']
        },
        {
            key: 'creditsPaid',
            kind: 'namedAmount',
            aliases: ['credits paid', 'credit paid', 'paid credits', 'paid credit',
                      'payments', 'payment', 'bayad', 'collections', 'collection',
                      'nagbayad']
        },
        {
            key: 'expenses',
            kind: 'amount',
            aliases: ['expenses', 'expense', 'gastos', 'spending', 'spent', 'costs', 'cost']
        },
        {
            key: 'remaining',
            kind: 'namedAmount',
            aliases: ['remaining credits', 'remaining credit', 'remaining balance',
                      'remaining', 'outstanding', 'balance', 'utang', 'tira']
        }
    ];

    function normalizeLine(line) {
        return String(line == null ? '' : line)
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function detectSection(rawLine) {
        var norm = normalizeLine(rawLine);
        if (!norm) return null;

        for (var i = 0; i < SECTIONS.length; i++) {
            var section = SECTIONS[i];
            for (var j = 0; j < section.aliases.length; j++) {
                var alias = section.aliases[j];
                if (norm === alias || norm.indexOf(alias + ' ') === 0) return section;
            }
        }
        return null;
    }

    /* =========================================================
       Line shapes
       ========================================================= */

    var LEADING_NUMBER_RE = /^(\d+(?:\.\d+)?)\b/;
    var NUMBER_AT_END_RE = /(\d+(?:\.\d+)?)\s*$/;

    /**
     * "35R" -> 35 gallons loaded. Also grabs a label written on the same line:
     *   "34R (1st trip)" -> 34, "1st trip"
     * Not "4 return" - the R needs a word break, and "return" continues with 'e'.
     */
    var LOADED_RE = /^\s*(\d{1,3})\s*R\b\s*(.*)$/i;

    var TRIP_LABEL_RE = /^\s*(\d+)(?:st|nd|rd|th)\s*trip\b\s*(.*)$/i;

    var RETURN_RE = /^\s*(\d+(?:\.\d+)?)\s*returns?\b(.*)$/i;
    var RETURN_PREFIX_RE = /^\s*returns?\b\s*(\d+(?:\.\d+)?)(.*)$/i;

    var BAHAY_RE = /^\s*(\d+(?:\.\d+)?)\s*(?:bahay|house|houses|balay)\b/i;

    var SALE_RE = /^\s*(\d+(?:\.\d+)?)\s*[x*X\u00D7]\s*(\d+(?:\.\d+)?)\s*(.*)$/;

    var TOTAL_LINE_RE = /^\s*(?:total\s*[-:\u2013]?\s*([\d,.]+)|([\d,.]+)\s*total\b)\s*$/i;

    function extractStatedTotal(line) {
        var nums = String(line || '').match(/\d+(?:\.\d+)?/g);
        if (!nums || !nums.length) return null;
        return parseFloat(nums[nums.length - 1]);
    }

    function stripNumbersAndNoise(text) {
        return String(text || '')
            .replace(/\d+(?:\.\d+)?/g, ' ')
            .replace(/[^A-Za-z\u00C0-\u00FF\u00F1\u00D1'.\-\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^[-'.\s]+/, '')
            .replace(/[-'.\s]+$/, '');
    }

    function titleCase(text) {
        return String(text || '')
            .split(' ')
            .map(function (w) {
                if (!w) return w;
                if (w.length <= 3 && w === w.toUpperCase()) return w;
                return w.charAt(0).toUpperCase() + w.slice(1);
            })
            .join(' ');
    }

    function customerKeyOf(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/[^a-z0-9\u00F1\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Plain Levenshtein distance. Short strings only, so the simple version is fine. */
    function editDistance(a, b) {
        a = String(a); b = String(b);
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;

        var prev = [];
        for (var j = 0; j <= b.length; j++) prev[j] = j;

        for (var i = 1; i <= a.length; i++) {
            var cur = [i];
            for (var k = 1; k <= b.length; k++) {
                var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
                cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
            }
            prev = cur;
        }
        return prev[b.length];
    }

    /**
     * Names that might be the same person written two ways.
     *
     * Names like "aling nena" are fine as they are - you often do not know
     * the real name - so this never changes anything by itself. It just offers
     * a merge when two entries look alike: "bernado" / "bernardo",
     * "tita marie" / "marie".
     *
     * rows: [{key, name}] -> [{a, b, distance, reason}]
     */
    function findLookalikes(rows) {
        var list = (rows || []).filter(function (r) {
            return r && r.key && r.key !== '__unassigned__';
        });
        var out = [];

        for (var i = 0; i < list.length; i++) {
            for (var j = i + 1; j < list.length; j++) {
                var A = list[i], B = list[j];
                var ka = String(A.key).replace(/\s+/g, '');
                var kb = String(B.key).replace(/\s+/g, '');
                var reason = null;
                var d = editDistance(ka, kb);

                if (Math.max(ka.length, kb.length) >= 4 && d > 0 && d <= 2) {
                    reason = 'looks like a typo';
                } else if (Math.min(ka.length, kb.length) >= 5 &&
                           (ka.indexOf(kb) >= 0 || kb.indexOf(ka) >= 0)) {
                    reason = 'one name is inside the other';
                }

                if (reason) out.push({ a: A, b: B, distance: d, reason: reason });
            }
        }
        return out;
    }

    /**
     * Pulls an amount and (optionally) a customer name out of one line.
     *   "540 mang tony"          -> 540, "Mang Tony"
     *   "Berto 50"              -> 50,  "Berto"
     *   "50 tito marvin = 225"  -> 225, "Tito Marvin"
     *   "300"                   -> 300, null
     */
    function parseLedgerLine(rawLine, allowNames) {
        var line = String(rawLine == null ? '' : rawLine).trim();
        if (!line) return { amount: null, name: null };

        var amount = null;
        var eqMatch = line.match(/=\s*-?\s*(\d+(?:\.\d+)?)/);

        if (eqMatch) {
            amount = parseFloat(eqMatch[1]);
        } else {
            var lead = line.match(LEADING_NUMBER_RE);
            if (lead) {
                amount = parseFloat(lead[1]);
            } else {
                var trail = line.match(NUMBER_AT_END_RE);
                if (trail) amount = parseFloat(trail[1]);
            }
        }

        if (amount === null || !isFinite(amount)) return { amount: null, name: null };

        var name = null;
        if (allowNames) {
            var namePart = eqMatch ? line.replace(/=.*$/, '') : line;
            namePart = stripNumbersAndNoise(namePart);
            if (namePart.length >= 2 && /[A-Za-z\u00C0-\u00FF\u00F1\u00D1]{2,}/.test(namePart)) {
                name = titleCase(namePart);
            }
        }

        return { amount: amount, name: name };
    }

    /** "1 borrow tindahan sa kanto" -> 1, "Tindahan Sa Kanto" */
    function parseBorrowLine(rawLine) {
        var line = String(rawLine == null ? '' : rawLine).trim();
        if (!line) return null;

        var lead = line.match(LEADING_NUMBER_RE);
        if (!lead) {
            var trail = line.match(NUMBER_AT_END_RE);
            if (!trail) return null;
            lead = trail;
        }

        var gallons = parseFloat(lead[1]);
        if (!isFinite(gallons)) return null;

        var namePart = line
            .replace(/\d+(?:\.\d+)?/g, ' ')
            .replace(/\b(borrowed|borrow|borrows|borrowing|gallons?|gals?)\b/gi, ' ')
            .replace(/[^A-Za-z\u00C0-\u00FF\u00F1\u00D1'.\-\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (namePart.length < 2) return null;

        return { gallons: gallons, name: titleCase(namePart) };
    }

    /**
     * Pulls a trip label out of the text trailing a loaded count.
     *   "(1st trip)" -> "1st trip"      "2nd trip" -> "2nd trip"
     *   "sold out"   -> null  (that is a note, not a label)
     */
    function labelFromRest(rest) {
        var text = String(rest || '').replace(/[()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return null;

        var m = text.match(/\b\d+(?:st|nd|rd|th)\s*trip\b/i);
        if (m) return m[0].replace(/\s+/g, ' ').trim();

        if (/\btrip\b/i.test(text) && text.length <= 24) return text;

        return null;
    }

    function sum(arr) {
        return arr.reduce(function (a, b) { return a + b; }, 0);
    }

    function blankSection() {
        return { items: [], named: [], total: 0, statedTotal: null };
    }

    /* =========================================================
       Main parse
       ========================================================= */

    function parse(rawText) {
        var raw = String(rawText == null ? '' : rawText);
        var lines = raw.split(/\r?\n/);

        var data = {
            dates: [],            // every date header found, in order
            dateKeys: [],
            dateKey: null,        // primary (first) date
            dateLabel: null,
            expenses: blankSection(),
            creditsToday: blankSection(),
            creditsPaid: blankSection(),
            remaining: blankSection(),
            remainingSnapshot: [],  // [{key,name,amount}] - who owes what
            balances: [],           // [{key,name,carried,given,paid,total}]
            change: blankSection(), // customers holding change for us
            borrowed: [],           // [{name,gallons}] - containers out
            days: [],               // [{dateKey,label,trips}]
            trips: [],
            ledger: [],             // credit events for the utang ledger
            writtenTotal: null,
            unparsed: [],
            warnings: []
        };

        var state = 'idle';
        var currentTrip = null;
        var currentDay = null;
        var pendingTripLabel = null;

        function dayFor(dateKey, label) {
            for (var i = 0; i < data.days.length; i++) {
                if (data.days[i].dateKey === dateKey) return data.days[i];
            }
            var day = { dateKey: dateKey, label: label, trips: [] };
            data.days.push(day);
            return day;
        }

        function openTrip(loaded, label) {
            var name = [label, loaded ? loaded + 'R' : null]
                .filter(Boolean).join(' ');

            currentTrip = {
                name: name || label || 'Trip',
                label: label || null,
                loaded: loaded || null,
                sales: [],
                returns: [],
                fullReturns: 0,
                bahay: 0,
                notes: [],
                dayKey: currentDay ? currentDay.dateKey : data.dateKey
            };
            data.trips.push(currentTrip);
            if (currentDay) currentDay.trips.push(currentTrip);
            return currentTrip;
        }

        for (var i = 0; i < lines.length; i++) {
            var rawLine = lines[i];
            var lineNo = i + 1;
            var line = rawLine.replace(/,/g, '').trim();

            /* --- blank line ends the current trip ---------------------- */
            if (line === '') {
                currentTrip = null;
                continue;
            }

            /* --- date header ------------------------------------------- */
            var foundDate = extractDate(rawLine);
            if (foundDate) {
                data.dates.push({ dateKey: foundDate, label: line, lineNo: lineNo });
                if (data.dateKeys.indexOf(foundDate) === -1) data.dateKeys.push(foundDate);
                if (!data.dateKey) {
                    data.dateKey = foundDate;
                    data.dateLabel = line;
                }
                currentDay = dayFor(foundDate, line);
                currentTrip = null;
                pendingTripLabel = null;
                state = 'trips';
                continue;
            }

            /* --- named sections ---------------------------------------- */
            var section = detectSection(line);
            if (section) {
                state = section.key;
                currentTrip = null;
                pendingTripLabel = null;
                // "Expenses -450", "Credits Today - 150" and "Credits Paid - 225"
                // all carry a total the user wrote down, worth cross-checking.
                if (section.kind !== 'borrow') {
                    data[section.key].statedTotal = extractStatedTotal(line);
                }
                continue;
            }

            /* --- our own written total --------------------------------- */
            var totalMatch = line.match(TOTAL_LINE_RE);
            if (totalMatch) {
                data.writtenTotal = parseFloat((totalMatch[1] || totalMatch[2]).replace(/,/g, ''));
                continue;
            }

            /* --- trip label: "1st trip" -------------------------------- */
            var labelMatch = line.match(TRIP_LABEL_RE);
            if (labelMatch) {
                var rest = labelMatch[2].trim();
                pendingTripLabel = labelMatch[0].replace(/\s+/g, ' ').trim();

                // "2nd trip 36R" on one line
                var inlineLoaded = rest.match(/^(\d{1,3})\s*R\b/i);
                openTrip(inlineLoaded ? parseInt(inlineLoaded[1], 10) : null, pendingTripLabel);
                pendingTripLabel = null;
                state = 'trips';
                continue;
            }

            /* --- loaded count: "35R" ----------------------------------- */
            var loadedMatch = line.match(LOADED_RE);
            if (loadedMatch) {
                var loaded = parseInt(loadedMatch[1], 10);
                var trailing = labelFromRest(loadedMatch[2]);

                var openTripMatches = currentTrip && currentTrip.loaded === null &&
                    currentTrip.sales.length === 0 && currentTrip.returns.length === 0;

                if (openTripMatches) {
                    // A bare "35R" right after "1st trip" belongs to that trip
                    currentTrip.loaded = loaded;
                    if (trailing && !currentTrip.label) currentTrip.label = trailing;
                    currentTrip.name = [currentTrip.label, loaded + 'R']
                        .filter(Boolean).join(' ');
                } else {
                    openTrip(loaded, trailing || pendingTripLabel);
                }
                pendingTripLabel = null;
                state = 'trips';
                continue;
            }

            /* --- inside a trip ----------------------------------------- */
            if (state === 'trips' && currentTrip) {
                var retMatch = line.match(RETURN_RE) || line.match(RETURN_PREFIX_RE);
                if (retMatch) {
                    var qty = parseFloat(retMatch[1]);
                    var tail = String(retMatch[2] || '');
                    currentTrip.returns.push(qty);
                    if (/may\s*laman/i.test(tail)) {
                        currentTrip.fullReturns += qty;
                    }
                    continue;
                }

                var bahayMatch = line.match(BAHAY_RE);
                if (bahayMatch) {
                    currentTrip.bahay += parseFloat(bahayMatch[1]);
                    continue;
                }

                var saleMatch = line.match(SALE_RE);
                if (saleMatch) {
                    currentTrip.sales.push({
                        price: parseFloat(saleMatch[1]),
                        qty: parseFloat(saleMatch[2])
                    });
                    continue;
                }

                // Anything else inside a trip is kept as a note, never money
                currentTrip.notes.push(line);
                continue;
            }

            /* --- amounts inside a named section ------------------------- */
            if (['expenses', 'creditsToday', 'creditsPaid', 'remaining',
                 'change', 'borrowed'].indexOf(state) !== -1) {

                if (state === 'borrowed') {
                    var borrow = parseBorrowLine(line);
                    if (borrow) { data.borrowed.push(borrow); continue; }
                    data.unparsed.push({ lineNo: lineNo, line: line, reason: 'Could not read a borrowed gallon count' });
                    continue;
                }

                var allowNames = state !== 'expenses';
                var parsed = parseLedgerLine(line, allowNames);

                if (parsed.amount !== null) {
                    var item = {
                        amount: parsed.amount,
                        label: line,
                        name: parsed.name,
                        lineNo: lineNo
                    };
                    data[state].items.push(item);

                    if (state === 'remaining' && parsed.amount !== 0) {
                        data.remainingSnapshot.push({
                            key: parsed.name ? customerKeyOf(parsed.name) : '__unassigned__',
                            name: parsed.name || 'Unassigned',
                            amount: parsed.amount
                        });
                    }

                    if (state === 'change' && parsed.amount !== 0) {
                        data.change.named.push({
                            key: parsed.name ? customerKeyOf(parsed.name) : '__unassigned__',
                            name: parsed.name || 'Unassigned',
                            amount: parsed.amount
                        });
                    }

                    if ((state === 'creditsToday' || state === 'creditsPaid') &&
                        parsed.name && parsed.amount !== 0) {
                        data.ledger.push({
                            type: state === 'creditsToday' ? 'given' : 'paid',
                            name: parsed.name,
                            key: customerKeyOf(parsed.name),
                            amount: parsed.amount,
                            note: line
                        });
                    }
                    continue;
                }

                data.unparsed.push({
                    lineNo: lineNo,
                    line: line,
                    reason: 'No amount found in the "' + state + '" section'
                });
                continue;
            }

            /* --- anything left over ------------------------------------ */
            data.unparsed.push({
                lineNo: lineNo,
                line: line,
                reason: state === 'idle'
                    ? 'Outside any section - not counted'
                    : 'Not understood in the "' + state + '" section'
            });
        }

        /* ---- section totals ---------------------------------------- */
        ['expenses', 'creditsToday', 'creditsPaid', 'remaining', 'change'].forEach(function (k) {
            data[k].total = sum(data[k].items.map(function (it) { return it.amount; }));
        });

        /* ---- trip maths -------------------------------------------- */
        data.trips.forEach(function (trip) {
            trip.sold = sum(trip.sales.map(function (s) { return s.qty; }));
            trip.revenue = sum(trip.sales.map(function (s) { return s.price * s.qty; }));
            trip.returnedGallons = sum(trip.returns);
            trip.accounted = trip.sold + trip.returnedGallons + trip.bahay;
            trip.gallons = trip.sold;   // sold gallons is what matters for money

            if (trip.loaded !== null && trip.accounted !== trip.loaded) {
                trip.diff = trip.accounted - trip.loaded;
            } else {
                trip.diff = 0;
            }
        });

        /* ---- warnings ---------------------------------------------- */
        data.trips.forEach(function (trip) {
            if (trip.loaded !== null && trip.diff !== 0) {
                data.warnings.push({
                    type: 'trip',
                    text: trip.name + ': loaded ' + trip.loaded + 'R but ' +
                        trip.sold + ' sold + ' + trip.returnedGallons + ' returned' +
                        (trip.bahay ? ' + ' + trip.bahay + ' bahay' : '') +
                        ' = ' + trip.accounted + ' (' +
                        (trip.diff > 0 ? '+' : '') + trip.diff + ')'
                });
            }
            if (trip.diff === null) trip.diff = 0;
        });

        data.balances = computeBalances(data);
        data.totals = calculateTotals(data);
        data.dateKeys.sort();

        return data;
    }

    /* =========================================================
       Customer balances

       How the notes work:
         Remaining      = what the customer already owed (carried in)
         Credits today  = new utang handed out this sheet
         Credits paid   = money collected this sheet

         owes now  =  carried  +  new utang  -  collected

       So "125 Ricky" plus "25 Ricky" under Credits today
       means Ricky owes 150.
       ========================================================= */

    function computeBalances(data) {
        var map = {};

        function touch(key, name) {
            if (!map[key]) {
                map[key] = {
                    key: key, name: name || key,
                    carried: 0, given: 0, paid: 0, total: 0, settled: false
                };
            }
            if (name && map[key].name === map[key].key) map[key].name = name;
            return map[key];
        }

        (data.remainingSnapshot || []).forEach(function (s) {
            if (s.key === '__unassigned__') return;
            touch(s.key, s.name).carried += s.amount;
        });

        (data.ledger || []).forEach(function (e) {
            var row = touch(e.key, e.name);
            if (e.type === 'given') row.given += e.amount;
            else row.paid += e.amount;
        });

        var out = Object.keys(map).map(function (k) {
            var row = map[k];
            row.total = round2(row.carried + row.given - row.paid);
            row.settled = row.total <= 0;
            row.carried = round2(row.carried);
            row.given = round2(row.given);
            row.paid = round2(row.paid);
            return row;
        });

        out.sort(function (a, b) {
            if (b.total !== a.total) return b.total - a.total;
            return String(a.name).localeCompare(String(b.name));
        });

        return out;
    }

    /* =========================================================
       Business math
       ========================================================= */

    function calculateTotals(data) {
        var revenue = 0;
        var sold = 0;
        var returned = 0;
        var fullReturns = 0;
        var bahay = 0;
        var loaded = 0;

        data.trips.forEach(function (t) {
            revenue += t.revenue;
            sold += t.sold;
            returned += t.returnedGallons;
            fullReturns += t.fullReturns || 0;
            bahay += t.bahay || 0;
            loaded += t.loaded || 0;
        });

        var expenses = data.expenses.total;
        var creditsToday = data.creditsToday.total;
        var creditsPaid = data.creditsPaid.total;

        return {
            totalRevenue: revenue,
            totalGallons: sold,
            loadedGallons: loaded,
            returnedGallons: returned,
            fullReturns: fullReturns,
            bahayGallons: bahay,
            expenses: expenses,
            creditsToday: creditsToday,
            creditsPaid: creditsPaid,
            remainingCredits: data.remaining.total,
            netCashFlow: revenue + creditsPaid - expenses - creditsToday
        };
    }

    /* =========================================================
       Carry-over template
       ========================================================= */

    function buildNewDayTemplate(opts) {
        opts = opts || {};
        var dateKey = opts.dateKey || todayKey();
        var carried = Number(opts.previousRemaining || 0);
        var outstanding = opts.customers || [];

        var out = [];
        out.push(prettyDate(dateKey) + ' (' + weekdayOf(dateKey) + ')');
        out.push('');
        out.push('Expenses');
        out.push('');
        out.push('Credits Paid');
        out.push('');
        out.push('Credits today');
        out.push('');
        out.push('Remaining');

        // Carry every customer who still owes, with their balance
        outstanding.forEach(function (c) {
            out.push(c.amount + ' ' + c.name);
        });

        if (!outstanding.length && carried) out.push(String(round2(carried)));

        out.push('');
        out.push('1st trip');
        out.push('');

        return out.join('\n');
    }

    function round2(n) {
        return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    }

    /* =========================================================
       Formatting
       ========================================================= */

    function formatPHP(num) {
        var n = Number(num) || 0;
        var neg = n < 0;
        var s = Math.abs(n).toLocaleString('en-PH', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
        return (neg ? '-' : '') + '\u20B1' + s;
    }

    function formatNumber(num) {
        return (Number(num) || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
    }

    global.WCParser = {
        parse: parse,
        calculateTotals: calculateTotals,
        computeBalances: computeBalances,
        buildNewDayTemplate: buildNewDayTemplate,
        extractDate: extractDate,
        extractStatedTotal: extractStatedTotal,
        parseLedgerLine: parseLedgerLine,
        parseBorrowLine: parseBorrowLine,
        customerKeyOf: customerKeyOf,
        editDistance: editDistance,
        findLookalikes: findLookalikes,
        detectSection: detectSection,
        toDateKey: toDateKey,
        todayKey: todayKey,
        prettyDate: prettyDate,
        weekdayOf: weekdayOf,
        formatPHP: formatPHP,
        formatNumber: formatNumber,
        round2: round2
    };
})(typeof window !== 'undefined' ? window : this);
