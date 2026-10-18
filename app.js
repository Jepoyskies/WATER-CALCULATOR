/* ============================================================
   app.js  (v2) - Water Delivery Manager
   Entry sheet, business dashboard, utang ledger, history, backup.
   ============================================================ */
(function () {
    'use strict';

    var P = window.WCParser;
    var S = window.WCStore;

    var DRAFT_KEY = 'wc_draft_v2';

    var state = {
        parsed: null,
        currentSheetId: null,
        sheets: [],
        view: null,          // snapshot view: balances, change, borrowed...
        autoBackupHandle: null,
        device: 'unknown',
        modalKey: null,      // customer open in the modal
        dismissedPairs: {},  // lookalike names the user said are different people
        selected: {}         // history checkboxes
    };

    /* =========================================================
       Helpers
       ========================================================= */

    function $(id) { return document.getElementById(id); }
    function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }
    function show(el) { if (el) el.classList.remove('hidden'); }
    function hide(el) { if (el) el.classList.add('hidden'); }
    function isHidden(el) { return !el || el.classList.contains('hidden'); }

    var toastTimer = null;
    function toast(message, kind) {
        var el = $('toast');
        el.textContent = message;
        el.className = 'toast' + (kind ? ' ' + kind : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { hide(el); }, 3400);
    }

    function copyText(text) {
        return new Promise(function (resolve, reject) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(resolve, function () {
                    try { resolve(legacyCopy(text)); } catch (e) { reject(e); }
                });
                return;
            }
            try { resolve(legacyCopy(text)); } catch (e) { reject(e); }
        });
    }

    function legacyCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        if (!ok) throw new Error('copy failed');
        return true;
    }

    function downloadText(filename, text, mime, noBom) {
        var body = noBom ? text : '\uFEFF' + text;
        var blob = new Blob([body], { type: (mime || 'text/plain') + ';charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 500);
    }

    /**
     * On a phone a plain download lands in a folder nobody can find. If the
     * phone can share files, offer the share sheet instead so the backup can
     * go straight to Drive, email, or a chat with yourself.
     *
     * Resolves with 'shared', 'downloaded' or 'cancelled'.
     */
    function shareOrDownload(filename, text, mime, noBom) {
        var type = mime || 'text/plain';
        var body = noBom ? text : '\uFEFF' + text;
        var file;

        try {
            file = new File([body], filename, { type: type + ';charset=utf-8' });
        } catch (err) {
            file = null;
        }

        if (file && navigator.canShare) {
            var shareData = { files: [file], title: filename, text: filename };
            if (navigator.canShare(shareData)) {
                return navigator.share(shareData).then(function () {
                    return 'shared';
                }).catch(function (err) {
                    // The user closing the share sheet is not an error
                    if (err && err.name === 'AbortError') return 'cancelled';
                    downloadText(filename, text, type, noBom);
                    return 'downloaded';
                });
            }
        }

        downloadText(filename, text, type, noBom);
        return Promise.resolve('downloaded');
    }

    function csvCell(v) {
        var s = String(v == null ? '' : v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function toCsv(rows) {
        return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    }
    function peso(n) { return P.formatPHP(n); }

    /* =========================================================
       Boot
       ========================================================= */

    function boot() {
        $('today-badge').textContent = P.prettyDate(P.todayKey()) +
            ' (' + P.weekdayOf(P.todayKey()) + ')';

        S.open()
            .then(detectDevice)
            .then(function () { return S.getMeta('deviceLabel', null); })
            .then(function (label) {
                if (label) state.device = label;
                return S.setMeta('deviceLabel', state.device);
            })
            .then(function () { return S.getMeta('autobackupHandle', null); })
            .then(function (handle) {
                if (handle) {
                    state.autoBackupHandle = handle;
                    updateAutoBackupUI('needs a click', 'warn');
                }
            })
            .then(function () { return S.getMeta('dismissedPairs', null); })
            .then(function (pairs) {
                state.dismissedPairs = pairs && typeof pairs === 'object' ? pairs : {};
            })
            .then(refreshAll)
            .then(function () { return S.requestPersistence(); })
            .then(function (result) {
                renderStorageBadge(result);
                return renderStorageInfo(result);
            })
            .catch(function (err) {
                console.error(err);
                toast('Could not open the local database: ' + err.message, 'bad');
            });

        restoreDraft();
        bindEvents();
        runShortcut();
        watchConnection();
    }

    /** Home-screen shortcuts: ?action=newday and ?action=utang */
    function runShortcut() {
        var action = null;
        try {
            action = new URLSearchParams(location.search).get('action');
        } catch (err) { return; }
        if (!action) return;

        // Do not leave the query string around - it makes the next reload repeat it
        try { history.replaceState(null, '', location.pathname); } catch (err) { /* file:// */ }

        if (action === 'utang') {
            switchView('customers');
        } else if (action === 'newday') {
            switchView('entry');
            startNewDay();
        }
    }

    /** Warns when the phone loses signal mid-trip. The app keeps working. */
    function watchConnection() {
        var banner = $('offline-banner');
        if (!banner) return;

        function update() {
            if (navigator.onLine) hide(banner);
            else show(banner);
        }

        on(window, 'online', update);
        on(window, 'offline', update);
        update();
    }

    function detectDevice() {
        var ua = navigator.userAgent || '';
        var isPhone = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua) ||
            (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 500);
        var isTablet = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua);
        state.device = isPhone ? 'Phone' : (isTablet ? 'Tablet' : 'Laptop');
    }

    function renderStorageBadge(result) {
        var badge = $('storage-badge');
        badge.textContent = '💾 ' + S.engineName();
        if (result && result.persisted) {
            badge.className = 'badge ok';
            badge.title = 'Storage is persistent - the browser will not clear it automatically.';
        } else {
            badge.className = 'badge warn';
            badge.title = 'Storage is best-effort. Keep exporting backups.';
        }
    }

    /* =========================================================
       Draft
       ========================================================= */

    function saveDraft() {
        try {
            var text = $('raw-log').value;
            if (text.trim()) localStorage.setItem(DRAFT_KEY, text);
            else localStorage.removeItem(DRAFT_KEY);
        } catch (e) { /* ignore */ }
    }

    function clearDraft() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    }

    function restoreDraft() {
        try {
            var draft = localStorage.getItem(DRAFT_KEY);
            if (draft && draft.trim()) {
                $('raw-log').value = draft;
                $('draft-note').innerHTML =
                    '📄 Restored an unsaved draft from last time. Press <strong>Calculate</strong> to see it, ' +
                    'or <strong>Clear</strong> to start over.';
                show($('draft-note'));
            }
        } catch (e) { /* ignore */ }
    }

    /* =========================================================
       Entry
       ========================================================= */

    function runCalculate() {
        var text = $('raw-log').value;
        if (!text.trim()) { toast('The notes box is empty.', 'bad'); return null; }

        var parsed = P.parse(text);
        state.parsed = parsed;
        renderResults(parsed);
        return parsed;
    }

    function renderResults(parsed) {
        var t = parsed.totals;

        $('display-date').textContent = parsed.dateKeys.length
            ? (parsed.dateKeys.length === 1
                ? P.prettyDate(parsed.dateKeys[0]) + ' (' + P.weekdayOf(parsed.dateKeys[0]) + ')'
                : parsed.dateKeys.map(function (k) { return P.prettyDate(k); }).join('  +  '))
            : "Today's Summary";

        $('out-revenue').textContent = peso(t.totalRevenue);
        $('out-gallons').textContent = P.formatNumber(t.totalGallons) + ' gallons sold';
        $('out-expenses').textContent = peso(t.expenses);
        $('out-credits-today-card').textContent = peso(t.creditsToday);
        $('out-credits-paid').textContent = peso(t.creditsPaid);

        var netEl = $('out-net');
        netEl.textContent = peso(t.netCashFlow);
        netEl.style.color = t.netCashFlow < 0 ? 'var(--red)' : 'var(--green)';

        var warnExp = $('warn-expenses');
        if (parsed.expenses.statedTotal != null && parsed.expenses.statedTotal !== t.expenses) {
            warnExp.querySelector('span').textContent = P.formatNumber(parsed.expenses.statedTotal);
            show(warnExp);
        } else {
            hide(warnExp);
        }

        $('out-load').textContent = P.formatNumber(t.loadedGallons) + ' gal';
        $('out-returned').textContent = P.formatNumber(t.returnedGallons) + ' gal';
        $('out-fullload').textContent = P.formatNumber(t.fullReturns) + ' gal';
        $('out-bahay').textContent = P.formatNumber(t.bahayGallons) + ' gal';
        $('out-rem-credits') && ($('out-rem-credits').textContent = P.formatNumber(t.remainingCredits));

        renderTrips(parsed);
        renderDayTable(parsed);
        renderWrittenTotal(parsed);
        renderTripWarnings(parsed);
        renderUnparsed(parsed);
        renderStatedMismatch(parsed);
        renderBalancesPanel(parsed);
        renderRollForward(parsed);
        show($('results-dashboard'));

        S.snapshotView().then(function (view) {
            state.view = view;
            $('out-all-utang').textContent = P.formatNumber(
                view.balances.reduce(function (a, b) { return a + (b.amount > 0 ? b.amount : 0); }, 0));
            $('out-change').textContent = P.formatNumber(view.change.total);
            $('out-borrowed').textContent = P.formatNumber(view.borrowed.total);
        });
    }

    function renderTrips(parsed) {
        var list = $('trip-list');
        list.innerHTML = '';

        if (!parsed.trips.length) {
            list.innerHTML = '<li class="empty">No trips detected</li>';
            return;
        }

        parsed.trips.forEach(function (trip) {
            var li = document.createElement('li');
            var left = document.createElement('span');
            var right = document.createElement('strong');

            var bits = ['sold ' + P.formatNumber(trip.sold)];
            if (trip.returnedGallons) bits.push(trip.returnedGallons + ' returned');
            if (trip.fullReturns) bits.push(trip.fullReturns + ' may laman');
            if (trip.bahay) bits.push(trip.bahay + ' bahay');

            left.textContent = trip.name;
            var small = document.createElement('small');
            small.className = 'muted';
            small.textContent = ' — ' + bits.join(', ');
            left.appendChild(small);

            right.textContent = peso(trip.revenue);
            li.appendChild(left);
            li.appendChild(right);
            list.appendChild(li);
        });
    }

    function renderDayTable(parsed) {
        var tbody = $('day-table').querySelector('tbody');

        if (parsed.days.length < 2) {
            hide($('day-breakdown-wrap'));
            tbody.innerHTML = '';
            return;
        }

        show($('day-breakdown-wrap'));
        tbody.innerHTML = parsed.days.map(function (day) {
            var sold = 0, rev = 0, load = 0, ret = 0, bahay = 0;
            day.trips.forEach(function (t) {
                sold += t.sold; rev += t.revenue; load += t.loaded || 0;
                ret += t.returnedGallons; bahay += t.bahay || 0;
            });
            return '<tr>' +
                '<td>' + P.prettyDate(day.dateKey) + ' <small class="muted">' +
                    P.weekdayOf(day.dateKey).slice(0, 3) + '</small></td>' +
                '<td class="num">' + P.formatNumber(sold) + '</td>' +
                '<td class="num">' + peso(rev) + '</td>' +
                '<td class="num">' + P.formatNumber(load) + '</td>' +
                '<td class="num">' + P.formatNumber(ret) + '</td>' +
                '<td class="num">' + P.formatNumber(bahay) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderWrittenTotal(parsed) {
        var box = $('written-total-note');
        if (parsed.writtenTotal == null) { hide(box); return; }

        var computed = parsed.totals.totalRevenue;
        var diff = P.round2(parsed.writtenTotal - computed);

        box.className = 'notice' + (Math.abs(diff) < 0.5 ? ' info' : ' warn');
        box.innerHTML = '✍️ You wrote <strong>' + peso(parsed.writtenTotal) + '</strong> as the total. ' +
            'The sold lines add up to <strong>' + peso(computed) + '</strong>' +
            (Math.abs(diff) < 0.5 ? ' — they match ✓' : '. Difference: <strong>' + peso(diff) + '</strong>.');
        show(box);
    }

    function renderTripWarnings(parsed) {
        var box = $('tripwarn-box');
        var list = $('tripwarn-list');

        if (!parsed.warnings.length) { hide(box); return; }

        list.innerHTML = parsed.warnings.map(function (w) {
            return '<li>' + w.text + '</li>';
        }).join('');
        show(box);
    }

    /**
     * Shows the maths the notes ask for:
     *   Remaining (what they already owed) + Credits today − Credits paid
     */
    function renderBalancesPanel(parsed) {
        var wrap = $('balances-wrap');
        var rows = (parsed.balances || []).filter(function (b) {
            return b.key !== '__unassigned__';
        });

        if (!rows.length) { hide(wrap); return; }

        var tbody = $('balances-table').querySelector('tbody');
        tbody.innerHTML = '';

        rows.forEach(function (b) {
            var tr = document.createElement('tr');
            var cls = b.total > 0 ? 'pos' : 'zero';
            tr.innerHTML =
                '<td>' + escapeHtml(b.name) + '</td>' +
                '<td class="num">' + peso(b.carried) + '</td>' +
                '<td class="num">' + (b.given ? '+' + peso(b.given) : '—') + '</td>' +
                '<td class="num">' + (b.paid ? '−' + peso(b.paid) : '—') + '</td>' +
                '<td class="num ' + cls + '"><strong>' + peso(b.total) + '</strong></td>';
            tbody.appendChild(tr);
        });

        var owing = rows.filter(function (b) { return b.total > 0; });
        var total = owing.reduce(function (a, b) { return a + b.total; }, 0);

        $('balances-note').innerHTML = owing.length
            ? '<strong>' + owing.length + '</strong> ' +
              (owing.length === 1 ? 'person still owes' : 'people still owe') + ' you <strong>' +
              peso(total) + '</strong>. This is what carries over when you start a new day.'
            : 'Nobody owes you anything after this sheet 🎉';

        show(wrap);
    }

    function renderRollForward(parsed) {
        var box = $('rollforward-box');
        var list = $('rollforward-list');

        S.snapshotView().then(function (view) {
            // Only meaningful when the notes being previewed carry a Remaining list
            if (!(parsed.balances || []).length || !view.rollForward.length) {
                hide(box);
                return;
            }

            var mine = {};
            (parsed.balances || []).forEach(function (b) { mine[b.key] = b.carried; });

            var rows = view.rollForward.filter(function (r) { return mine[r.key] !== undefined; });
            if (!rows.length) { hide(box); return; }

            list.innerHTML = rows.map(function (r) {
                return '<li><strong>' + escapeHtml(r.name) + '</strong>: ended at ' + peso(r.endedAt) +
                    ' on ' + P.prettyDate(r.asOf) + ', but this list starts at ' + peso(r.carried) +
                    ' (off by ' + peso(r.diff) + ')</li>';
            }).join('');
            show(box);
        });
    }

    function renderUnparsed(parsed) {
        var box = $('unparsed-box');
        var list = $('unparsed-list');
        if (!parsed.unparsed.length) { hide(box); return; }

        list.innerHTML = parsed.unparsed.map(function (u) {
            return '<li>Line ' + u.lineNo + ': <code>' + escapeHtml(u.line) + '</code> — ' + u.reason + '</li>';
        }).join('');
        show(box);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderStatedMismatch(parsed) {
        var box = $('stated-box');
        var list = $('stated-list');
        var labels = {
            expenses: 'Expenses', creditsToday: 'Credits Today',
            creditsPaid: 'Credits Paid', remaining: 'Remaining'
        };
        var rows = [];

        Object.keys(labels).forEach(function (key) {
            var sec = parsed[key];
            if (!sec || sec.statedTotal == null) return;
            if (sec.statedTotal === sec.total) return;
            rows.push('<li>' + labels[key] + ': you wrote <strong>' + peso(sec.statedTotal) +
                '</strong>, the lines add up to <strong>' + peso(sec.total) + '</strong></li>');
        });

        if (!rows.length) { hide(box); return; }
        list.innerHTML = rows.join('');
        show(box);
    }

    /* ---- saving ---- */

    function saveSheet() {
        var parsed = P.parse($('raw-log').value);
        state.parsed = parsed;

        if (!parsed.trips.length && !parsed.expenses.items.length &&
            !parsed.creditsToday.items.length && !parsed.creditsPaid.items.length &&
            !parsed.balances.length) {
            toast('Nothing worth saving yet.', 'bad');
            return;
        }

        var dateKeys = parsed.dateKeys.length ? parsed.dateKeys.slice() : [P.todayKey()];
        dateKeys.sort();
        var id = dateKeys[0];
        var now = new Date().toISOString();

        S.getSheet(id).then(function (existing) {
            if (existing) {
                var when = existing.updatedAt ? new Date(existing.updatedAt).toLocaleString() : 'earlier';
                if (!window.confirm('A sheet already starts on ' + P.prettyDate(id) +
                        ' (saved ' + when + ').\n\nReplace it?')) return null;
            }

            var record = {
                id: id,
                startDateKey: dateKeys[0],
                endDateKey: dateKeys[dateKeys.length - 1],
                dateKeys: dateKeys,
                label: dateKeys.length > 1
                    ? P.prettyDate(dateKeys[0]) + ' – ' + P.prettyDate(dateKeys[dateKeys.length - 1])
                    : P.prettyDate(dateKeys[0]),
                rawText: $('raw-log').value,
                parsed: parsed,
                totals: parsed.totals,
                sourceDevice: state.device,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now
            };

            return ensureCustomers(parsed).then(function () {
                return S.saveSheet(record);
            }).then(function () {
                clearDraft();
                hide($('draft-note'));
                state.currentSheetId = id;
                toast('Saved ' + record.label + ' ✓', 'good');
                return writeAutoBackup(false);
            }).then(refreshAll);
        }).catch(function (err) {
            console.error(err);
            toast('Could not save: ' + err.message, 'bad');
        });
    }

    function ensureCustomers(parsed) {
        var seen = {};
        var rows = [];
        var now = new Date().toISOString();

        function add(name) {
            if (!name) return;
            var key = P.customerKeyOf(name);
            if (!key || key === '__unassigned__' || seen[key]) return;
            seen[key] = true;
            rows.push({ key: key, name: name, createdAt: now });
        }

        (parsed.remainingSnapshot || []).forEach(function (s) {
            if (s.key !== '__unassigned__') add(s.name);
        });
        (parsed.balances || []).forEach(function (b) { add(b.name); });
        (parsed.ledger || []).forEach(function (e) { add(e.name); });
        (parsed.change && parsed.change.named ? parsed.change.named : []).forEach(function (s) {
            if (s.key !== '__unassigned__') add(s.name);
        });
        (parsed.borrowed || []).forEach(function (b) { add(b.name); });

        return S.registerCustomers(rows);
    }

    /* ---- new day / load ---- */

    function startNewDay() {
        loadSheets().then(function () {
            return S.snapshotView().then(function (view) {
                var owing = view.balances
                    .filter(function (b) { return b.amount > 0; })
                    .map(function (b) { return { name: b.name, amount: b.amount }; });

                var dateKey = P.todayKey();
                var text = P.buildNewDayTemplate({ dateKey: dateKey, customers: owing });

                $('raw-log').value = text;
                state.currentSheetId = null;
                state.parsed = null;

                hide($('results-dashboard'));
                hide($('draft-note'));
                hide($('tripwarn-box'));
                hide($('unparsed-box'));
                hide($('stated-box'));
                hide($('rollforward-box'));
                saveDraft();
                renderQuickAddChips();

                var already = state.sheets.some(function (s) { return s.id === dateKey; });
                var parts = [];

                if (owing.length) {
                    parts.push('Carried over <strong>' + owing.length + '</strong> unpaid ' +
                        (owing.length === 1 ? 'balance' : 'balances') +
                        ' (' + peso(owing.reduce(function (a, b) { return a + b.amount; }, 0)) + ').');
                } else {
                    parts.push('Fresh sheet for <strong>' + P.prettyDate(dateKey) + '</strong>.');
                }

                parts.push('Expenses, Credits and trip headings are already written in — just fill in the numbers.');

                if (already) {
                    parts.push('<br><strong>⚠️ A sheet already starts on today</strong> — saving will ask before replacing it.');
                }

                var note = $('carry-note');
                note.innerHTML = '▶ ' + parts.join(' ');
                show(note);
                $('raw-log').focus();
                toast('New sheet ready — ' + P.prettyDate(dateKey), 'good');
            });
        }).catch(function (err) {
            console.error(err);
            toast('Could not build a new sheet: ' + err.message, 'bad');
        });
    }

    function loadLastSaved() {
        loadSheets().then(function () {
            if (!state.sheets.length) { toast('Nothing saved yet.', 'bad'); return; }
            var last = state.sheets[0];
            $('raw-log').value = last.rawText || '';
            state.currentSheetId = last.id;
            state.parsed = null;
            hide($('carry-note'));
            runCalculate();
            toast('Loaded ' + last.label, 'good');
        });
    }

    /* ---- quick add ---- */

    function renderQuickAddChips() {
        return S.snapshotView().then(function (view) {
            var holder = $('qa-customer-chips');
            holder.innerHTML = '';
            state.view = view;

            var owing = view.balances.filter(function (b) {
                return b.amount > 0 && b.key !== '__unassigned__';
            }).slice(0, 12);

            owing.forEach(function (b) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'chip owed';
                btn.innerHTML = escapeHtml(b.name) + ' <strong>' + peso(b.amount) + '</strong>';
                btn.title = 'Add a payment line for ' + b.name;
                btn.addEventListener('click', function () { insertLedgerLine('creditsPaid', b.name); });
                holder.appendChild(btn);
            });

            var dl = $('customer-names');
            dl.innerHTML = view.balances
                .filter(function (b) { return b.key !== '__unassigned__'; })
                .map(function (b) { return '<option value="' + escapeHtml(b.name) + '"></option>'; })
                .join('');
        });
    }

    function insertLedgerLine(sectionKey, name) {
        var textarea = $('raw-log');
        var text = textarea.value;
        var lines = text.split('\n');

        var headerFor = {
            creditsToday: 'Credits today',
            creditsPaid: 'Credits Paid'
        };

        var headerIndex = -1;
        for (var i = 0; i < lines.length; i++) {
            var sec = P.detectSection(lines[i].replace(/,/g, '').trim());
            if (sec && sec.key === sectionKey) { headerIndex = i; break; }
        }

        var newLine = (name && name !== '__new__') ? '0 ' + name : '0 customer name';

        if (headerIndex === -1) {
            textarea.value = text.replace(/\s+$/, '') + '\n\n' + headerFor[sectionKey] + '\n' + newLine + '\n';
            toast('Added a "' + headerFor[sectionKey] + '" section at the bottom.');
        } else {
            var insertAt = headerIndex + 1;
            while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
            lines.splice(insertAt, 0, newLine);
            textarea.value = lines.join('\n');
            toast('Line added — type the amount over the 0.');
        }

        var idx = textarea.value.lastIndexOf(newLine);
        textarea.focus();
        try { textarea.setSelectionRange(idx + 1, idx + 1); } catch (e) { /* ignore */ }
        saveDraft();
    }

    /* =========================================================
       Dashboard
       ========================================================= */

    function loadSheets() {
        return S.listSheets().then(function (sheets) {
            state.sheets = sheets;
            return sheets;
        });
    }

    function refreshAll() {
        return Promise.all([loadSheets(), S.snapshotView()])
            .then(function (res) {
                state.sheets = res[0];
                state.view = res[1];
                renderDashboard();
                renderCustomers();
                renderHistory();
                renderQuickAddChips();
                renderUtangPill();
                renderFooter();
                if (state.device) $('device-input').value = state.device;
            })
            .catch(function (err) {
                console.error(err);
                toast('Could not load saved data: ' + err.message, 'bad');
            });
    }

    function renderUtangPill() {
        var pill = $('utang-pill');
        var count = state.view.balances.filter(function (b) {
            return b.amount > 0 && b.key !== '__unassigned__';
        }).length;
        if (count > 0) { pill.textContent = count; show(pill); } else hide(pill);
    }

    function card(title, value, sub, cls, extra) {
        return '<div class="card ' + (extra || '') + '">' +
            '<h3>' + escapeHtml(title) + '</h3>' +
            '<p class="' + (cls || '') + '">' + escapeHtml(value) + '</p>' +
            (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</div>';
    }

    function totalsOf(sheet) { return (sheet.parsed && sheet.parsed.totals) || sheet.totals || {}; }

    function sumBy(sheets, fn) {
        return sheets.reduce(function (a, s) { return a + (Number(fn(totalsOf(s))) || 0); }, 0);
    }

    function renderDashboard() {
        var sheets = state.sheets;
        var view = state.view;

        var revenue = sumBy(sheets, function (t) { return t.totalRevenue; });
        var gallons = sumBy(sheets, function (t) { return t.totalGallons; });
        var expenses = sumBy(sheets, function (t) { return t.expenses; });
        var collected = sumBy(sheets, function (t) { return t.creditsPaid; });
        var given = sumBy(sheets, function (t) { return t.creditsToday; });
        var net = sumBy(sheets, function (t) { return t.netCashFlow; });
        var owing = view.balances.reduce(function (a, b) { return a + (b.amount > 0 ? b.amount : 0); }, 0);

        $('biz-cards').innerHTML = [
            card('All-time Revenue', peso(revenue), P.formatNumber(gallons) + ' gallons', 'text-blue'),
            card('All-time Expenses', peso(expenses), '', 'text-red'),
            card('Utang Collected', peso(collected), 'paid back to you', 'text-green'),
            card('New Utang Given', peso(given), '', 'text-orange'),
            card('Still Owed To You', peso(owing), view.balances.filter(function (b) { return b.amount > 0; }).length + ' people', 'text-orange', 'alert'),
            card('Net Cash Flow', peso(net), 'all saved sheets', net < 0 ? 'text-red' : 'text-green', 'highlight')
        ].join('');

        var recent = $('recent-days');
        recent.innerHTML = sheets.length
            ? sheets.slice(0, 8).map(function (s) {
                var t = totalsOf(s);
                return '<li><span>' + escapeHtml(s.label) +
                    ' <small class="muted">' + P.formatNumber(t.totalGallons) + ' gal</small></span>' +
                    '<strong>' + peso(t.netCashFlow) + '</strong></li>';
            }).join('')
            : '<li class="empty">Nothing saved yet.</li>';

        var top = $('top-utang');
        var owingList = view.balances.filter(function (b) {
            return b.amount > 0 && b.key !== '__unassigned__';
        }).slice(0, 8);
        top.innerHTML = owingList.length
            ? owingList.map(function (b) {
                return '<li><span>' + escapeHtml(b.name) + '</span>' +
                    '<strong class="text-orange">' + peso(b.amount) + '</strong></li>';
            }).join('')
            : '<li class="empty">Nobody owes you right now 🎉</li>';

        var changeList = $('change-list');
        changeList.innerHTML = (view.change.list || []).length
            ? view.change.list.map(function (c) {
                return '<li><span>' + escapeHtml(c.name) + '</span><strong>' + peso(c.amount) + '</strong></li>';
            }).join('') + '<li><span><strong>Total change owed</strong></span><strong>' +
                peso(view.change.total) + '</strong></li>'
            : '<li class="empty">No change owed. ✓</li>';

        var borrowedList = $('borrowed-list');
        borrowedList.innerHTML = (view.borrowed.list || []).length
            ? view.borrowed.list.map(function (b) {
                return '<li><span>' + escapeHtml(b.name) + '</span><strong>' +
                    P.formatNumber(b.gallons) + ' gal</strong></li>';
            }).join('') + '<li><span><strong>Total gallons out</strong></span><strong>' +
                P.formatNumber(view.borrowed.total) + ' gal</strong></li>'
            : '<li class="empty">No gallons borrowed out. ✓</li>';

        renderMonthTable(sheets);
    }

    function renderMonthTable(sheets) {
        var byMonth = {};

        sheets.forEach(function (s) {
            var key = String(s.startDateKey || s.id).slice(0, 7);
            if (!byMonth[key]) {
                byMonth[key] = { sheets: 0, gallons: 0, revenue: 0, expenses: 0, collected: 0, given: 0, net: 0 };
            }
            var t = totalsOf(s);
            var m = byMonth[key];
            m.sheets++;
            m.gallons += t.totalGallons || 0;
            m.revenue += t.totalRevenue || 0;
            m.expenses += t.expenses || 0;
            m.collected += t.creditsPaid || 0;
            m.given += t.creditsToday || 0;
            m.net += t.netCashFlow || 0;
        });

        var keys = Object.keys(byMonth).sort().reverse();
        var tbody = $('month-table').querySelector('tbody');

        if (!keys.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="muted">No data yet.</td></tr>';
            return;
        }

        tbody.innerHTML = keys.map(function (key) {
            var m = byMonth[key];
            var label = P.prettyDate(key + '-01').replace(/, 1$/, '');
            return '<tr><td>' + escapeHtml(label) + '</td>' +
                '<td class="num">' + m.sheets + '</td>' +
                '<td class="num">' + P.formatNumber(m.gallons) + '</td>' +
                '<td class="num">' + peso(m.revenue) + '</td>' +
                '<td class="num">' + peso(m.expenses) + '</td>' +
                '<td class="num">' + peso(m.collected) + '</td>' +
                '<td class="num">' + peso(m.given) + '</td>' +
                '<td class="num ' + (m.net < 0 ? 'neg' : 'pos') + '">' + peso(m.net) + '</td></tr>';
        }).join('');
    }

    /* =========================================================
       Customers
       ========================================================= */

    function renderCustomers() {
        var view = state.view;
        var rows = view.balances.filter(function (b) { return b.key !== '__unassigned__'; });

        var owing = rows.filter(function (b) { return b.amount > 0; });
        var outstanding = owing.reduce(function (a, b) { return a + b.amount; }, 0);
        var lifetimeGiven = rows.reduce(function (a, b) { return a + (b.owedAllTime || 0); }, 0);
        var lifetimePaid = rows.reduce(function (a, b) { return a + (b.paidAllTime || 0); }, 0);

        $('ledger-cards').innerHTML = [
            card('People With Utang', String(owing.length), 'still owing', 'text-orange'),
            card('Outstanding', peso(outstanding), 'still to collect', 'text-orange', 'alert'),
            card('Utang Given', peso(lifetimeGiven), 'all time', ''),
            card('Paid Back', peso(lifetimePaid), 'all time', 'text-green'),
            card('Change You Owe', peso(view.change.total), '', ''),
            card('Gallons Borrowed Out', P.formatNumber(view.borrowed.total), 'containers', '')
        ].join('');

        // People who dropped off the newest Remaining list
        var missingBox = $('missing-box');
        if (view.missing.length) {
            $('missing-list').innerHTML = view.missing.map(function (m) {
                return '<li><strong>' + escapeHtml(m.name) + '</strong> — owed ' + peso(m.amount) +
                    ' on ' + P.prettyDate(m.asOf) + '</li>';
            }).join('');
            show(missingBox);
        } else hide(missingBox);

        // Balances that were carried in at a different amount than they ended at
        var rfBox = $('rollforward-box2');
        if (view.rollForward.length) {
            $('rollforward-list2').innerHTML = view.rollForward.map(function (r) {
                return '<li><strong>' + escapeHtml(r.name) + '</strong>: ended at ' + peso(r.endedAt) +
                    ' on ' + P.prettyDate(r.asOf) + ', next list started at ' + peso(r.carried) +
                    ' (off by ' + peso(r.diff) + ')</li>';
            }).join('');
            show(rfBox);
        } else hide(rfBox);

        renderLookalikes(rows);

        var tbody = $('customers-table').querySelector('tbody');
        tbody.innerHTML = '';

        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            var cls = row.amount > 0 ? 'pos' : 'zero';
            tr.innerHTML =
                '<td>' + escapeHtml(row.name) + '</td>' +
                '<td class="num ' + cls + '"><strong>' + peso(row.amount) + '</strong></td>' +
                '<td class="num">' + peso(row.carriedLast || 0) + '</td>' +
                '<td class="num">' + (row.newUtang ? '+' + peso(row.newUtang) : '—') + '</td>' +
                '<td class="num">' + (row.collected ? '−' + peso(row.collected) : '—') + '</td>' +
                '<td>' + (row.asOf ? P.prettyDate(row.asOf) : '—') + '</td>';
            tr.addEventListener('click', function () { openCustomerModal(row.key); });
            tbody.appendChild(tr);
        });

        if (tbody.children.length) hide($('ledger-empty'));
        else show($('ledger-empty'));
    }

    /** Offers a merge when two names look like the same person. Never merges by itself. */
    function renderLookalikes(rows) {
        var box = $('lookalike-box');
        var list = $('lookalike-list');

        var dismissed = state.dismissedPairs || {};
        var pairs = P.findLookalikes(rows).filter(function (p) {
            return !dismissed[pairKey(p.a.key, p.b.key)];
        });

        if (!pairs.length) { hide(box); return; }

        list.innerHTML = '';

        pairs.forEach(function (p) {
            var li = document.createElement('li');
            li.innerHTML = '<strong>' + escapeHtml(p.a.name) + '</strong> (' + peso(p.a.amount) + ')  ' +
                'vs <strong>' + escapeHtml(p.b.name) + '</strong> (' + peso(p.b.amount) + ') — ' +
                p.reason + ' ';

            var mergeBtn = document.createElement('button');
            mergeBtn.className = 'btn small';
            mergeBtn.textContent = 'Same person';
            mergeBtn.addEventListener('click', function () {
                mergeCustomers(p.a, p.b);
            });

            var skipBtn = document.createElement('button');
            skipBtn.className = 'btn small secondary';
            skipBtn.textContent = 'Not the same';
            skipBtn.addEventListener('click', function () {
                var next = Object.assign({}, state.dismissedPairs);
                next[pairKey(p.a.key, p.b.key)] = true;
                S.setMeta('dismissedPairs', next).then(function () {
                    state.dismissedPairs = next;
                    return refreshAll();
                });
            });

            li.appendChild(mergeBtn);
            li.appendChild(document.createTextNode(' '));
            li.appendChild(skipBtn);
            list.appendChild(li);
        });

        show(box);
    }

    function pairKey(a, b) {
        return [a, b].sort().join('|');
    }

    function mergeCustomers(from, into) {
        var msg = 'Merge these into one customer?\n\n' +
            '  ' + from.name + '  ->  ' + into.name + '\n\n' +
            'Their utang will be added together (' +
            peso((from.amount || 0) + (into.amount || 0)) + ' total) and every saved sheet will be updated.\n\n' +
            'This cannot be undone automatically, so export a backup first if you are unsure.';

        if (!window.confirm(msg)) return;

        S.relabelCustomer(from.key, into.name).then(function () {
            toast('Merged into ' + into.name + ' ✓', 'good');
            return writeAutoBackup(false).then(refreshAll);
        }).catch(function (err) {
            console.error(err);
            toast('Could not merge: ' + err.message, 'bad');
        });
    }

    function openCustomerModal(key) {
        var row = null;
        state.view.balances.forEach(function (b) { if (b.key === key) row = b; });
        if (!row) return;

        state.modalKey = key;
        $('modal-title').textContent = row.name;
        $('modal-quickpay').dataset.key = key;
        $('modal-quickpay').dataset.name = row.name;

        var head = row.amount > 0
            ? '<p class="notice warn">Owes you <strong>' + peso(row.amount) + '</strong></p>'
            : '<p class="notice info">All settled up ✓</p>';

        // The sum the notes use: Remaining + Credits today − Credits paid
        var math = '<div class="math-line">' +
            '<span><em>Remaining last</em>' + peso(row.carriedLast || 0) + '</span>' +
            '<span><em>+ New utang</em>' + peso(row.newUtang || 0) + '</span>' +
            '<span><em>− Paid</em>' + peso(row.collected || 0) + '</span>' +
            '<span class="total"><em>Owes now</em>' + peso(row.amount) + '</span>' +
            '</div>';

        if (row.manualUtang || row.manualCollected) {
            math += '<p class="muted">Includes ' + peso(row.manualUtang || 0) +
                ' new utang and ' + peso(row.manualCollected || 0) +
                ' paid that you typed in by hand (not from a sheet).</p>';
        }

        var hist = (state.view.history[key] || []).slice().reverse();

        var body = head + math +
            '<div class="summary-cards">' +
            '<div class="card"><h3>Owes now</h3><p>' + peso(row.amount) + '</p></div>' +
            '<div class="card"><h3>Utang given</h3><p>' + peso(row.owedAllTime || 0) +
                '</p><small>all time</small></div>' +
            '<div class="card"><h3>Paid back</h3><p>' + peso(row.paidAllTime || 0) +
                '</p><small>all time</small></div>' +
            '</div>';

        if (hist.length) {
            body += '<h4 style="margin-top:16px">Every Remaining list this name was on</h4>' +
                '<div class="table-scroll"><table class="table"><thead><tr>' +
                '<th>Sheet</th><th class="num">Carried</th><th class="num">+ New</th>' +
                '<th class="num">− Paid</th><th class="num">Ended At</th>' +
                '</tr></thead><tbody>' +
                hist.map(function (h) {
                    return '<tr><td>' + P.prettyDate(h.dateKey) + '</td>' +
                        '<td class="num">' + peso(h.carried || 0) + '</td>' +
                        '<td class="num">' + peso(h.newUtang || 0) + '</td>' +
                        '<td class="num">' + peso(h.collected || 0) + '</td>' +
                        '<td class="num"><strong>' + peso(h.total || 0) + '</strong></td></tr>';
                }).join('') +
                '</tbody></table></div>';
        } else {
            body += '<p class="muted">This name has not been on a Remaining list yet.</p>';
        }

        $('modal-body').innerHTML = body;
        show($('modal-backdrop'));
    }

    function closeModal() { hide($('modal-backdrop')); }

    /** Rename a customer, or fold them into another name they were written as. */
    function renameCustomer() {
        var key = state.modalKey;
        if (!key) return;

        var row = null;
        state.view.balances.forEach(function (b) { if (b.key === key) row = b; });
        if (!row) return;

        var entered = window.prompt(
            'Name for this customer.\n\n' +
            'You are allowed to write anything here - "aling nena", "yung sa kanto", ' +
            'whatever helps you recognise them. Type an existing name to merge the two.',
            row.name);

        if (entered === null) return;
        entered = entered.trim();
        if (!entered || entered === row.name) return;

        var target = null;
        var targetKey = P.customerKeyOf(entered);
        state.view.balances.forEach(function (b) {
            if (b.key === targetKey && b.key !== key) target = b;
        });

        if (target) {
            var msg = 'Merge ' + row.name + ' into ' + target.name + '?\n\n' +
                'Their utang will be added together (' +
                peso((row.amount || 0) + (target.amount || 0)) + ' total) and every saved sheet updated.';
            if (!window.confirm(msg)) return;
        }

        S.relabelCustomer(key, entered).then(function () {
            closeModal();
            toast(target ? 'Merged into ' + target.name + ' ✓' : 'Renamed to ' + entered + ' ✓', 'good');
            return writeAutoBackup(false).then(refreshAll);
        }).catch(function (err) {
            console.error(err);
            toast('Could not rename: ' + err.message, 'bad');
        });
    }

    function saveManual() {
        var name = $('mf-name').value.trim();
        var amount = parseFloat($('mf-amount').value);
        var type = $('mf-type').value;
        var dateKey = $('mf-date').value || P.todayKey();
        var note = $('mf-note').value.trim();

        if (!name) { toast('Enter a customer name.', 'bad'); return; }
        if (!isFinite(amount) || amount <= 0) { toast('Enter an amount above zero.', 'bad'); return; }

        var pretty = name.split(/\s+/).map(function (w) {
            return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');

        S.addManual({
            customerName: pretty,
            customerKey: P.customerKeyOf(name),
            type: type, amount: amount, dateKey: dateKey, note: note
        }).then(function () {
            $('mf-name').value = '';
            $('mf-amount').value = '';
            $('mf-note').value = '';
            hide($('manual-form'));
            toast('Recorded ' + peso(amount) + ' for ' + pretty, 'good');
            return writeAutoBackup(false).then(refreshAll);
        }).catch(function (err) {
            console.error(err);
            toast('Could not record it: ' + err.message, 'bad');
        });
    }

    /* =========================================================
       History + combine
       ========================================================= */

    function renderHistory() {
        var tbody = $('history-table').querySelector('tbody');
        tbody.innerHTML = '';

        if (!state.sheets.length) {
            show($('history-empty'));
            updateCombineBar();
            return;
        }
        hide($('history-empty'));

        state.sheets.forEach(function (s) {
            var t = totalsOf(s);
            var tr = document.createElement('tr');

            var check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = !!state.selected[s.id];
            check.addEventListener('change', function () {
                if (check.checked) state.selected[s.id] = true;
                else delete state.selected[s.id];
                updateCombineBar();
            });

            var firstCell = document.createElement('td');
            firstCell.appendChild(check);
            tr.appendChild(firstCell);

            var rest = document.createElement('td');
            rest.innerHTML = '<strong>' + escapeHtml(s.label) + '</strong>' +
                (s.combined ? ' <span class="badge ghost">combined</span>' : '');
            tr.appendChild(rest);

            [
                P.formatNumber(t.totalGallons),
                peso(t.totalRevenue),
                peso(t.expenses),
                peso(t.creditsPaid),
                peso(t.creditsToday),
                peso(t.remainingCredits)
            ].forEach(function (v) {
                var td = document.createElement('td');
                td.className = 'num';
                td.textContent = v;
                tr.appendChild(td);
            });

            var netTd = document.createElement('td');
            netTd.className = 'num ' + (t.netCashFlow < 0 ? 'neg' : 'pos');
            netTd.textContent = peso(t.netCashFlow);
            tr.appendChild(netTd);

            var cell = document.createElement('td');
            cell.className = 'actions-cell';

            var openBtn = document.createElement('button');
            openBtn.className = 'btn small ghost';
            openBtn.textContent = 'Open';
            openBtn.addEventListener('click', function () {
                $('raw-log').value = s.rawText || '';
                state.currentSheetId = s.id;
                state.parsed = null;
                switchView('entry');
                runCalculate();
                toast('Loaded ' + s.label);
            });

            var delBtn = document.createElement('button');
            delBtn.className = 'btn small ghost';
            delBtn.textContent = '🗑';
            delBtn.title = 'Delete this sheet';
            delBtn.addEventListener('click', function () {
                if (!window.confirm('Delete ' + s.label + ' permanently?')) return;
                S.deleteSheet(s.id).then(function () {
                    delete state.selected[s.id];
                    toast('Deleted ' + s.label);
                    return writeAutoBackup(false).then(refreshAll);
                });
            });

            cell.appendChild(openBtn);
            cell.appendChild(document.createTextNode(' '));
            cell.appendChild(delBtn);
            tr.appendChild(cell);
            tbody.appendChild(tr);
        });

        updateCombineBar();
    }

    function updateCombineBar() {
        var count = Object.keys(state.selected).length;
        $('combine-btn').disabled = count < 2;
        $('combine-hint').textContent = count
            ? count + ' sheet(s) ticked' + (count < 2 ? ' — tick at least two.' : '.')
            : 'Tick two or more sheets to combine them into one total.';
    }

    function doCombine() {
        var ids = Object.keys(state.selected);
        if (ids.length < 2) { toast('Tick at least two sheets first.', 'bad'); return; }

        var labels = ids.map(function (id) {
            var s = state.sheets.filter(function (x) { return x.id === id; })[0];
            return s ? s.label : id;
        });

        if (!window.confirm('Combine these into a single sheet?\n\n' + labels.join('\n') +
                '\n\nThe originals are kept and you can undo this.')) return;

        S.combineSheets(ids).then(function (record) {
            state.selected = {};
            toast('Combined into ' + record.label, 'good');
            return writeAutoBackup(false).then(refreshAll);
        }).catch(function (err) {
            console.error(err);
            toast('Could not combine: ' + err.message, 'bad');
        });
    }

    function openUncombine() {
        var combined = state.sheets.filter(function (s) { return s.combined; });
        var list = $('uncombine-list');

        if (!combined.length) {
            list.innerHTML = '<li class="empty">No combined sheets to undo.</li>';
        } else {
            list.innerHTML = '';
            combined.forEach(function (s) {
                var li = document.createElement('li');
                var label = document.createElement('span');
                label.textContent = s.label;

                var btn = document.createElement('button');
                btn.className = 'btn small secondary';
                btn.textContent = 'Split apart';
                btn.addEventListener('click', function () {
                    S.uncombineSheets(s.id).then(function () {
                        hide($('uncombine-backdrop'));
                        toast('Split ' + s.label + ' back into single days.', 'good');
                        return refreshAll();
                    }).catch(function (err) {
                        toast('Could not undo: ' + err.message, 'bad');
                    });
                });

                li.appendChild(label);
                li.appendChild(btn);
                list.appendChild(li);
            });
        }
        show($('uncombine-backdrop'));
    }

    /* =========================================================
       Backup
       ========================================================= */

    function exportJson() {
        S.exportPayload(state.device).then(function (payload) {
            var stamp = new Date().toISOString().slice(0, 10);
            var name = 'water-backup-' + String(state.device).toLowerCase() + '-' + stamp + '.json';
            var text = JSON.stringify(payload, null, 2);

            return shareOrDownload(name, text, 'application/json', true).then(function (how) {
                if (how === 'cancelled') {
                    toast('Export cancelled — nothing was saved to a file.', 'bad');
                    return null;
                }
                return S.setMeta('lastExportAt', new Date().toISOString()).then(function () {
                    toast(how === 'shared'
                        ? 'Backup shared: ' + name
                        : 'Backup downloaded: ' + name, 'good');
                    renderStorageInfo();
                });
            });
        }).catch(function (err) {
            console.error(err);
            toast('Export failed: ' + err.message, 'bad');
        });
    }

    function importJson(file) {
        var reader = new FileReader();

        reader.onload = function () {
            var payload;
            try { payload = JSON.parse(reader.result); }
            catch (e) { toast('That file is not valid JSON.', 'bad'); return; }

            var problems = S.validatePayload(payload);
            if (problems.length) { toast(problems[0], 'bad'); return; }

            var count = (payload.sheets || payload.days || []).length;
            var when = payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : 'unknown';
            var from = payload.device || 'unknown device';

            if (!window.confirm('Import ' + count + ' sheet(s) from "' + from + '" (exported ' + when + ')?\n\n' +
                    'Only newer copies replace what you have. Nothing is deleted.')) return;

            S.importPayload(payload).then(function (plan) {
                toast('Imported: ' + plan.added + ' new, ' + plan.updated + ' updated, ' +
                    plan.skipped + ' already current' +
                    (plan.upgraded ? ', ' + plan.upgraded + ' upgraded from an older backup' : '') + '.', 'good');
                return writeAutoBackup(false).then(refreshAll);
            }).catch(function (err) {
                console.error(err);
                toast('Import failed: ' + err.message, 'bad');
            });
        };

        reader.onerror = function () { toast('Could not read that file.', 'bad'); };
        reader.readAsText(file);
    }

    function autoBackupSupported() { return typeof window.showSaveFilePicker === 'function'; }

    function updateAutoBackupUI(label, cls) {
        var el = $('ab-state');
        el.textContent = label;
        el.className = 'badge ' + (cls || 'ghost');
    }

    function enableAutoBackup() {
        if (!autoBackupSupported()) {
            toast('This browser cannot auto-backup. Use "Export Backup" instead.', 'bad');
            updateAutoBackupUI('not supported', 'warn');
            return;
        }

        window.showSaveFilePicker({
            suggestedName: 'water-backup-' + String(state.device).toLowerCase() + '.json',
            types: [{ description: 'Water backup', accept: { 'application/json': ['.json'] } }]
        }).then(function (handle) {
            state.autoBackupHandle = handle;
            return S.setMeta('autobackupHandle', handle);
        }).then(function () {
            updateAutoBackupUI('on', 'ok');
            return writeAutoBackup(true);
        }).then(function () {
            toast('Auto-backup is on. It rewrites that file every time you save.', 'good');
        }).catch(function (err) {
            if (err && err.name === 'AbortError') return;
            console.error(err);
            toast('Could not set the backup file: ' + err.message, 'bad');
        });
    }

    function ensurePermission(handle, interactive) {
        var opts = { mode: 'readwrite' };
        if (!handle.queryPermission) return Promise.resolve(true);

        return handle.queryPermission(opts).then(function (status) {
            if (status === 'granted') return true;
            if (!interactive) {
                updateAutoBackupUI('needs a click', 'warn');
                return false;
            }
            return handle.requestPermission(opts).then(function (next) { return next === 'granted'; });
        });
    }

    function writeAutoBackup(interactive) {
        if (!state.autoBackupHandle) return Promise.resolve(false);

        return ensurePermission(state.autoBackupHandle, interactive).then(function (granted) {
            if (!granted) {
                if (interactive) toast('Backup permission was not granted.', 'bad');
                return false;
            }
            return S.exportPayload(state.device).then(function (payload) {
                return state.autoBackupHandle.createWritable().then(function (writable) {
                    return writable.write(JSON.stringify(payload, null, 2)).then(function () {
                        return writable.close();
                    });
                }).then(function () {
                    updateAutoBackupUI('on', 'ok');
                    return S.setMeta('lastAutoBackupAt', new Date().toISOString());
                });
            });
        }).then(function (result) {
            if (result === true && interactive) toast('Backup file updated ✓', 'good');
            return result;
        }).catch(function (err) {
            console.error(err);
            updateAutoBackupUI('error', 'warn');
            if (interactive) toast('Backup failed: ' + err.message, 'bad');
            return false;
        });
    }

    function disableAutoBackup() {
        state.autoBackupHandle = null;
        S.setMeta('autobackupHandle', null).then(function () {
            updateAutoBackupUI('off', 'ghost');
            toast('Auto-backup turned off.');
        });
    }

    function renderStorageInfo() {
        var list = $('storage-info');
        var rows = [];

        function row(label, value) { rows.push([label, value]); }

        function paint() {
            list.innerHTML = rows.map(function (r) {
                return '<li><span>' + escapeHtml(r[0]) + '</span><strong>' +
                    escapeHtml(r[1]) + '</strong></li>';
            }).join('');
        }

        row('Database engine', S.engineName());
        row('Saved sheets', String(state.sheets.length));
        row('Customer records', String(state.view ? state.view.balances.length : 0));
        row('Device name', state.device);
        paint();

        return Promise.all([
            S.getMeta('lastExportAt', null),
            S.getMeta('lastImportAt', null),
            S.getMeta('lastAutoBackupAt', null),
            S.estimate()
        ]).then(function (res) {
            row('Last manual export', res[0] ? new Date(res[0]).toLocaleString() : 'never');
            row('Last import', res[1] ? new Date(res[1]).toLocaleString() : 'never');
            row('Last auto-backup', res[2] ? new Date(res[2]).toLocaleString() : 'never');
            if (res[3] && res[3].quota) {
                row('Space used', (res[3].usage / 1048576).toFixed(2) + ' MB of ' +
                    (res[3].quota / 1073741824).toFixed(1) + ' GB');
            }
            paint();
        });
    }

    function renderFooter() {
        var note = $('footer-note');
        S.getMeta('lastExportAt', null).then(function (last) {
            if (!state.sheets.length) { note.textContent = 'No data saved yet.'; return; }
            if (!last) {
                note.innerHTML = '⚠️ You have ' + state.sheets.length +
                    ' saved sheet(s) and have never exported a backup. Do that in the <strong>Backup</strong> tab.';
                return;
            }
            var days = Math.floor((Date.now() - Date.parse(last)) / 86400000);
            if (days >= 7) {
                note.innerHTML = '⚠️ Last backup was ' + days + ' days ago. Export again in the <strong>Backup</strong> tab.';
            } else {
                note.textContent = 'Last backup ' + new Date(last).toLocaleDateString() + ' ✓';
            }
        });
    }

    /* ---- CSV ---- */

    function exportSheetsCsv() {
        if (!state.sheets.length) { toast('Nothing to export yet.', 'bad'); return; }

        var rows = [['Dates', 'Gallons', 'Revenue', 'Expenses', 'Collected', 'New Utang',
                     'Remaining', 'Loaded', 'Returned', 'Bahay', 'Net', 'Device']];

        state.sheets.slice().reverse().forEach(function (s) {
            var t = totalsOf(s);
            rows.push([
                (s.dateKeys || [s.startDateKey]).join(' + '),
                t.totalGallons || 0, t.totalRevenue || 0, t.expenses || 0,
                t.creditsPaid || 0, t.creditsToday || 0, t.remainingCredits || 0,
                t.loadedGallons || 0, t.returnedGallons || 0, t.bahayGallons || 0,
                t.netCashFlow || 0, s.sourceDevice || ''
            ]);
        });

        downloadText('water-sheets-' + new Date().toISOString().slice(0, 10) + '.csv', toCsv(rows), 'text/csv');
        toast('Sheets CSV downloaded.', 'good');
    }

    function exportTripsCsv() {
        var rows = [['Date', 'Trip', 'Loaded', 'Sold', 'Returned', 'May Laman', 'Bahay', 'Diff', 'Revenue']];
        var any = false;

        state.sheets.slice().reverse().forEach(function (s) {
            (s.parsed && s.parsed.trips ? s.parsed.trips : []).forEach(function (t) {
                any = true;
                rows.push([
                    t.dayKey || s.startDateKey, t.name, t.loaded || 0, t.sold || 0,
                    t.returnedGallons || 0, t.fullReturns || 0, t.bahay || 0, t.diff || 0,
                    t.revenue || 0
                ]);
            });
        });

        if (!any) { toast('No trips to export yet.', 'bad'); return; }
        downloadText('water-trips-' + new Date().toISOString().slice(0, 10) + '.csv', toCsv(rows), 'text/csv');
        toast('Trips CSV downloaded.', 'good');
    }

    function exportUtangCsv() {
        var view = state.view;
        var rows = [['Customer', 'Owes Now', 'Remaining Last', 'New Utang (this sheet)',
                     'Paid (this sheet)', 'Balance As Of', 'Utang Given (all time)', 'Paid (all time)']];

        view.balances.forEach(function (b) {
            rows.push([b.name, b.amount, b.carriedLast || 0, b.newUtang || 0, b.collected || 0,
                       b.asOf || '', b.owedAllTime || 0, b.paidAllTime || 0]);
        });

        rows.push([]);
        rows.push(['Change you owe', '', '', '', '']);
        view.change.list.forEach(function (c) { rows.push([c.name, c.amount, c.dateKey, '', '']); });

        rows.push([]);
        rows.push(['Gallons borrowed from you', '', '', '', '']);
        view.borrowed.list.forEach(function (b) { rows.push([b.name, b.gallons, b.dateKey, '', '']); });

        downloadText('water-utang-' + new Date().toISOString().slice(0, 10) + '.csv', toCsv(rows), 'text/csv');
        toast('Utang ledger downloaded.', 'good');
    }

    /* ---- copy summary ---- */

    function generateExportText() {
        var parsed = state.parsed;
        if (!parsed) return '';

        var t = parsed.totals;
        var L = [];

        L.push('📊 Water Delivery: ' + (parsed.dateKeys.length
            ? parsed.dateKeys.map(function (k) { return P.prettyDate(k); }).join(' + ')
            : 'Today'));
        L.push('--------------------------');
        L.push('Revenue:        ' + peso(t.totalRevenue));
        L.push('Gallons sold:   ' + P.formatNumber(t.totalGallons));
        L.push('Loaded / back:  ' + P.formatNumber(t.loadedGallons) + ' / ' + P.formatNumber(t.returnedGallons));
        L.push('Credits paid:   ' + peso(t.creditsPaid));
        L.push('Credits today:  ' + peso(t.creditsToday));
        L.push('Expenses:       ' + peso(t.expenses));
        L.push('--------------------------');
        L.push('NET CASH FLOW:  ' + peso(t.netCashFlow));
        L.push('Remaining utang:' + peso(t.remainingCredits));

        if (parsed.trips.length) {
            L.push('--------------------------');
            parsed.trips.forEach(function (trip) {
                L.push(trip.name + ': ' + P.formatNumber(trip.sold) + ' gal - ' + peso(trip.revenue));
            });
        }

        return L.join('\n');
    }

    /* =========================================================
       Views + events
       ========================================================= */

    function switchView(name) {
        qsa('.tab').forEach(function (tab) {
            tab.classList.toggle('is-active', tab.dataset.view === name);
        });
        qsa('.view').forEach(function (view) {
            view.classList.toggle('is-active', view.id === 'view-' + name);
        });

        if (name === 'dashboard') renderDashboard();
        if (name === 'customers') renderCustomers();
        if (name === 'history') renderHistory();
        if (name === 'backup') renderStorageInfo();
        saveDraft();
    }

    function bindEvents() {
        qsa('.tab').forEach(function (tab) {
            on(tab, 'click', function () { switchView(tab.dataset.view); });
        });

        on($('calc-btn'), 'click', function () { runCalculate(); });
        on($('save-btn'), 'click', saveSheet);
        on($('new-day-btn'), 'click', startNewDay);
        on($('load-last-btn'), 'click', loadLastSaved);

        on($('clear-btn'), 'click', function () {
            if ($('raw-log').value.trim() && !window.confirm('Clear the notes box?')) return;
            $('raw-log').value = '';
            state.parsed = null;
            state.currentSheetId = null;
            clearDraft();
            ['results-dashboard', 'draft-note', 'unparsed-box', 'stated-box',
             'tripwarn-box', 'rollforward-box', 'carry-note'].forEach(hideId);
            toast('Cleared.');
        });

        function hideId(id) { hide($(id)); }

        on($('editor-toggle'), 'click', function () {
            if (isHidden($('quick-add'))) { show($('quick-add')); renderQuickAddChips(); }
            else hide($('quick-add'));
        });

        qsa('#quick-add .chip[data-name]').forEach(function (chip) {
            on(chip, 'click', function () { insertLedgerLine(chip.dataset.target, chip.dataset.name); });
        });

        on($('raw-log'), 'input', saveDraft);
        on($('raw-log'), 'keydown', function (ev) {
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); saveSheet(); }
        });

        on($('export-btn'), 'click', function () {
            var text = generateExportText();
            if (!text) { toast('Press Calculate first.', 'bad'); return; }
            copyText(text).then(function () {
                $('export-btn').textContent = '✅ Copied!';
                setTimeout(function () { $('export-btn').textContent = '📋 Copy Summary'; }, 2000);
            }).catch(function () {
                downloadText('water-summary.txt', text, 'text/plain');
                toast('Clipboard blocked - downloaded a text file instead.', 'bad');
            });
        });

        on($('csv-day-btn'), 'click', function () {
            var text = generateExportText();
            if (!text) { toast('Press Calculate first.', 'bad'); return; }
            downloadText('water-summary-' + (P.todayKey()) + '.txt', text, 'text/plain');
            toast('Summary downloaded.');
        });

        on($('refresh-dash-btn'), 'click', function () {
            refreshAll().then(function () { toast('Refreshed ✓', 'good'); });
        });

        on($('add-credit-btn'), 'click', function () {
            if (isHidden($('manual-form'))) {
                show($('manual-form'));
                $('mf-date').value = P.todayKey();
                renderQuickAddChips();
                $('mf-name').focus();
            } else hide($('manual-form'));
        });
        on($('mf-cancel'), 'click', function () { hide($('manual-form')); });
        on($('mf-save'), 'click', saveManual);

        on($('refresh-history-btn'), 'click', function () {
            refreshAll().then(function () { toast('Refreshed ✓', 'good'); });
        });
        on($('combine-btn'), 'click', doCombine);
        on($('uncombine-btn'), 'click', openUncombine);
        on($('uncombine-close'), 'click', function () { hide($('uncombine-backdrop')); });

        on($('modal-close'), 'click', closeModal);
        on($('modal-close-2'), 'click', closeModal);
        on($('modal-backdrop'), 'click', function (ev) {
            if (ev.target === $('modal-backdrop')) closeModal();
        });
        on($('modal-quickpay'), 'click', function (ev) {
            var row = ev.currentTarget;
            closeModal();
            switchView('customers');
            show($('manual-form'));
            $('mf-name').value = row.dataset.name;
            $('mf-type').value = 'paid';
            $('mf-date').value = P.todayKey();
            renderQuickAddChips();
            $('mf-amount').focus();
        });
        on($('modal-rename'), 'click', renameCustomer);

        on($('export-json-btn'), 'click', exportJson);
        on($('import-json-btn'), 'click', function () { $('import-file').click(); });
        on($('import-file'), 'change', function (ev) {
            var file = ev.target.files && ev.target.files[0];
            if (file) importJson(file);
            ev.target.value = '';
        });

        on($('ab-enable'), 'click', enableAutoBackup);
        on($('ab-run'), 'click', function () { writeAutoBackup(true); });
        on($('ab-disable'), 'click', disableAutoBackup);

        on($('persist-btn'), 'click', function () {
            S.requestPersistence().then(function (result) {
                renderStorageBadge(result);
                renderStorageInfo(result);
                toast(result.persisted
                    ? 'Browser agreed to keep your data permanently ✓'
                    : 'Browser kept it as best-effort - keep exporting backups.',
                    result.persisted ? 'good' : 'bad');
            });
        });

        on($('csv-sheets-btn'), 'click', exportSheetsCsv);
        on($('csv-trips-btn'), 'click', exportTripsCsv);
        on($('csv-utang-btn'), 'click', exportUtangCsv);

        on($('device-save'), 'click', function () {
            var name = $('device-input').value.trim();
            if (!name) { toast('Enter a name first.', 'bad'); return; }
            state.device = name;
            S.setMeta('deviceLabel', name).then(function () {
                renderStorageInfo();
                toast('Device name saved: ' + name, 'good');
            });
        });

        on($('wipe-btn'), 'click', function () {
            if (!window.confirm('This deletes ALL saved sheets and customers on this device.\n\nExport first! Continue?')) return;
            if (!window.confirm('Really erase everything? This cannot be undone.')) return;

            S.clearAll().then(function () {
                clearDraft();
                state.selected = {};
                $('raw-log').value = '';
                state.parsed = null;
                state.currentSheetId = null;
                hide($('results-dashboard'));
                toast('All local data erased.', 'good');
                return refreshAll();
            });
        });

        window.addEventListener('beforeunload', saveDraft);

        if (!autoBackupSupported()) {
            hide($('ab-run'));
            hide($('ab-disable'));
            $('ab-help').innerHTML = 'Automatic file backup needs Chrome or Edge on a desktop. ' +
                'In this browser use <strong>Export Backup</strong> and keep the file safe.';
            updateAutoBackupUI('not supported', 'warn');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
