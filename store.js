/* ============================================================
   store.js  (v2)
   Local database for the Water Delivery Manager.

   Design
   ------
   Everything important is derived from the saved sheets, so the
   database can never drift out of sync with itself.

     sheets    - one record per saved notes page (may span days)
     manual    - credits/payments recorded by hand, outside a sheet
     customers - name registry
     meta      - settings (device name, backup handle, timestamps)

   Customer balances come from the "Remaining" snapshot in the newest
   sheet that has one - which is exactly how the notes are written.

   Primary engine  : IndexedDB
   Fallback engine : localStorage
   Exposes window.WCStore
   ============================================================ */
(function (global) {
    'use strict';

    var DB_NAME = 'watercalc';
    var DB_VERSION = 2;
    var LS_PREFIX = 'wc_db_v2:';
    var SCHEMA_VERSION = 2;

    var STORES = ['sheets', 'manual', 'customers', 'meta'];

    var engine = null;
    var dbPromise = null;

    /* =========================================================
       IndexedDB
       ========================================================= */

    function openIDB() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB is not available')); return; }

            var req;
            try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
            catch (e) { reject(e); return; }

            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('sheets')) {
                    var s = db.createObjectStore('sheets', { keyPath: 'id' });
                    s.createIndex('startDateKey', 'startDateKey', { unique: false });
                }
                if (!db.objectStoreNames.contains('manual')) {
                    db.createObjectStore('manual', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('customers')) {
                    db.createObjectStore('customers', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };

            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
            req.onblocked = function () { reject(new Error('IndexedDB is blocked by another tab')); };
        });

        return dbPromise;
    }

    function reqDone(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    function txDone(tx) {
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
        });
    }

    var idbEngine = {
        label: 'IndexedDB',
        getAll: function (store) {
            return openIDB().then(function (db) {
                return reqDone(db.transaction(store, 'readonly').objectStore(store).getAll());
            });
        },
        get: function (store, key) {
            return openIDB().then(function (db) {
                return reqDone(db.transaction(store, 'readonly').objectStore(store).get(key));
            });
        },
        put: function (store, value) {
            return openIDB().then(function (db) {
                var tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(value);
                return txDone(tx);
            });
        },
        putMany: function (store, values) {
            if (!values.length) return Promise.resolve();
            return openIDB().then(function (db) {
                var tx = db.transaction(store, 'readwrite');
                var os = tx.objectStore(store);
                values.forEach(function (v) { os.put(v); });
                return txDone(tx);
            });
        },
        del: function (store, key) {
            return openIDB().then(function (db) {
                var tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).delete(key);
                return txDone(tx);
            });
        },
        delMany: function (store, keys) {
            if (!keys.length) return Promise.resolve();
            return openIDB().then(function (db) {
                var tx = db.transaction(store, 'readwrite');
                var os = tx.objectStore(store);
                keys.forEach(function (k) { os.delete(k); });
                return txDone(tx);
            });
        },
        batch: function (ops) {
            if (!ops || !ops.length) return Promise.resolve();
            return openIDB().then(function (db) {
                var names = [];
                ops.forEach(function (op) {
                    if (names.indexOf(op.store) === -1) names.push(op.store);
                });
                var tx = db.transaction(names, 'readwrite');
                ops.forEach(function (op) {
                    var os = tx.objectStore(op.store);
                    if (op.type === 'put') os.put(op.value);
                    else if (op.type === 'putMany') op.values.forEach(function (v) { os.put(v); });
                    else if (op.type === 'del') os.delete(op.key);
                    else if (op.type === 'delMany') op.keys.forEach(function (k) { os.delete(k); });
                    else if (op.type === 'clear') os.clear();
                });
                return txDone(tx);
            });
        },
        clearAll: function () {
            return openIDB().then(function (db) {
                var tx = db.transaction(STORES, 'readwrite');
                STORES.forEach(function (s) { tx.objectStore(s).clear(); });
                return txDone(tx);
            });
        }
    };

    /* =========================================================
       localStorage fallback
       ========================================================= */

    function lsRead(store) {
        try {
            var raw = global.localStorage.getItem(LS_PREFIX + store);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }
    function lsWrite(store, rows) {
        global.localStorage.setItem(LS_PREFIX + store, JSON.stringify(rows));
    }
    function lsKeyOf(store, row) { return store === 'meta' || store === 'customers' ? row.key : row.id; }

    var lsEngine = {
        label: 'localStorage',
        getAll: function (store) { return Promise.resolve(lsRead(store)); },
        get: function (store, key) {
            return Promise.resolve(lsRead(store).filter(function (r) {
                return lsKeyOf(store, r) === key;
            })[0] || null);
        },
        put: function (store, value) {
            var rows = lsRead(store);
            var k = lsKeyOf(store, value);
            var i = rows.findIndex(function (r) { return lsKeyOf(store, r) === k; });
            if (i >= 0) rows[i] = value; else rows.push(value);
            lsWrite(store, rows);
            return Promise.resolve();
        },
        putMany: function (store, values) {
            return values.reduce(function (chain, v) {
                return chain.then(function () { return lsEngine.put(store, v); });
            }, Promise.resolve());
        },
        del: function (store, key) {
            lsWrite(store, lsRead(store).filter(function (r) { return lsKeyOf(store, r) !== key; }));
            return Promise.resolve();
        },
        delMany: function (store, keys) {
            lsWrite(store, lsRead(store).filter(function (r) {
                return keys.indexOf(lsKeyOf(store, r)) === -1;
            }));
            return Promise.resolve();
        },
        batch: function (ops) {
            return ops.reduce(function (chain, op) {
                return chain.then(function () {
                    if (op.type === 'put') return lsEngine.put(op.store, op.value);
                    if (op.type === 'putMany') return lsEngine.putMany(op.store, op.values);
                    if (op.type === 'del') return lsEngine.del(op.store, op.key);
                    if (op.type === 'delMany') return lsEngine.delMany(op.store, op.keys);
                    if (op.type === 'clear') { lsWrite(op.store, []); return Promise.resolve(); }
                });
            }, Promise.resolve());
        },
        clearAll: function () {
            STORES.forEach(function (s) { lsWrite(s, []); });
            return Promise.resolve();
        }
    };

    /* =========================================================
       Bootstrap
       ========================================================= */

    function open() {
        if (engine) return Promise.resolve(engine);

        return openIDB()
            .then(function () { return idbEngine.put('meta', { key: '__probe', value: Date.now() }); })
            .then(function () { engine = idbEngine; return engine; })
            .catch(function () { engine = lsEngine; return engine; });
    }

    function E() { return engine || lsEngine; }
    function engineName() { return engine ? engine.label : 'not initialized'; }

    /* =========================================================
       Storage health
       ========================================================= */

    function requestPersistence() {
        if (!global.navigator || !navigator.storage || !navigator.storage.persist) {
            return Promise.resolve({ supported: false, persisted: false });
        }
        return navigator.storage.persisted()
            .then(function (already) { return already ? true : navigator.storage.persist(); })
            .then(function (persisted) { return { supported: true, persisted: persisted }; })
            .catch(function () { return { supported: true, persisted: false }; });
    }

    function estimate() {
        if (!global.navigator || !navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
        return navigator.storage.estimate()
            .then(function (e) { return { usage: e.usage || 0, quota: e.quota || 0 }; })
            .catch(function () { return null; });
    }

    /* =========================================================
       Meta
       ========================================================= */

    function getMeta(key, fallback) {
        return E().get('meta', key).then(function (row) {
            return row ? row.value : (fallback === undefined ? null : fallback);
        });
    }
    function setMeta(key, value) { return E().put('meta', { key: key, value: value }); }

    /* =========================================================
       Sheets
       ========================================================= */

    function listSheets() {
        return E().getAll('sheets').then(function (rows) {
            return rows
                .filter(function (r) { return !r.mergedInto; })
                .sort(function (a, b) {
                    return String(b.startDateKey || b.id).localeCompare(String(a.startDateKey || a.id));
                });
        });
    }

    function getAllSheets() {
        return E().getAll('sheets').then(function (rows) {
            return rows.sort(function (a, b) {
                return String(a.startDateKey || a.id).localeCompare(String(b.startDateKey || b.id));
            });
        });
    }

    function getSheet(id) { return E().get('sheets', id); }

    function saveSheet(sheet) {
        return open().then(function () {
            return E().put('sheets', sheet);
        });
    }

    function deleteSheet(id) {
        return E().del('sheets', id);
    }

    /**
     * Merges several sheets into one combined record.
     * The originals are kept but flagged, so this can be undone.
     */
    function combineSheets(ids) {
        if (!ids || ids.length < 2) return Promise.reject(new Error('Pick at least two sheets to combine'));

        var P = global.WCParser;

        return Promise.all(ids.map(getSheet)).then(function (sheets) {
            sheets = sheets.filter(Boolean);
            if (sheets.length < 2) throw new Error('Could not find those sheets');

            sheets.sort(function (a, b) {
                return String(a.startDateKey).localeCompare(String(b.startDateKey));
            });

            var dateKeys = [];
            var trips = [];
            var days = [];

            sheets.forEach(function (s) {
                (s.dateKeys || [s.startDateKey]).forEach(function (k) {
                    if (dateKeys.indexOf(k) === -1) dateKeys.push(k);
                });
                var parsed = s.parsed || {};
                trips = trips.concat(parsed.trips || []);
                (parsed.days || []).forEach(function (d) {
                    var existing = null;
                    days.forEach(function (x) { if (x.dateKey === d.dateKey) existing = x; });
                    if (existing) existing.trips = existing.trips.concat(d.trips);
                    else days.push({ dateKey: d.dateKey, label: d.label, trips: d.trips.slice() });
                });
            });

            dateKeys.sort();
            days.sort(function (a, b) { return String(a.dateKey).localeCompare(String(b.dateKey)); });

            // Expenses / credits are summed, remaining uses the newest snapshot
            var last = sheets[sheets.length - 1];
            var first = sheets[0];

            function sumSection(key) {
                var section = { items: [], named: [], total: 0, statedTotal: null };
                sheets.forEach(function (s) {
                    var sec = (s.parsed || {})[key];
                    if (!sec) return;
                    section.items = section.items.concat(sec.items || []);
                    section.named = section.named.concat(sec.named || []);
                });
                section.total = section.items.reduce(function (a, i) { return a + i.amount; }, 0);
                return section;
            }

            var merged = {
                dateKeys: dateKeys,
                dateLabel: P.prettyDate(dateKeys[0]),
                dateKey: dateKeys[0],
                expenses: sumSection('expenses'),
                creditsToday: sumSection('creditsToday'),
                creditsPaid: sumSection('creditsPaid'),
                remaining: (last.parsed && last.parsed.remaining) || { items: [], named: [], total: 0, statedTotal: null },
                remainingSnapshot: (last.parsed && last.parsed.remainingSnapshot) || [],
                change: (last.parsed && last.parsed.change) || { items: [], named: [], total: 0, statedTotal: null },
                borrowed: [],
                days: days,
                trips: trips,
                ledger: sheets.reduce(function (acc, s) {
                    return acc.concat((s.parsed && s.parsed.ledger) || []);
                }, []),
                writtenTotal: sheets.reduce(function (acc, s) {
                    return (s.parsed && s.parsed.writtenTotal) != null ? s.parsed.writtenTotal : acc;
                }, null),
                unparsed: [],
                warnings: []
            };

            // Borrowed gallons: newest sheet wins per name
            var borrowedMap = {};
            sheets.forEach(function (s) {
                ((s.parsed && s.parsed.borrowed) || []).forEach(function (b) {
                    borrowedMap[P.customerKeyOf(b.name)] = b;
                });
            });
            merged.borrowed = Object.keys(borrowedMap).map(function (k) { return borrowedMap[k]; });

            trips.forEach(function (t) {
                t.sold = t.sold || 0;
                t.returnedGallons = t.returnedGallons || 0;
                t.bahay = t.bahay || 0;
            });

            merged.totals = P.calculateTotals(merged);
            merged.balances = P.computeBalances(merged);

            var now = new Date().toISOString();

            // The id must not collide with any sheet it was built from,
            // otherwise writing the "mergedInto" markers would overwrite it.
            var recordId = 'combo:' + dateKeys[0] + '..' + dateKeys[dateKeys.length - 1];
            sheets.forEach(function (s) {
                if (s.id === recordId) recordId = recordId + '+';
            });

            var record = {
                id: recordId,
                startDateKey: dateKeys[0],
                endDateKey: dateKeys[dateKeys.length - 1],
                dateKeys: dateKeys,
                label: dateKeys.length > 1
                    ? 'Combined ' + P.prettyDate(dateKeys[0]) + ' – ' + P.prettyDate(dateKeys[dateKeys.length - 1])
                    : 'Combined ' + P.prettyDate(dateKeys[0]),
                combined: true,
                combinedFrom: sheets.map(function (s) { return s.id; }),
                rawText: sheets.map(function (s) {
                    return '# ' + P.prettyDate(s.startDateKey) + '\n' + (s.rawText || '');
                }).join('\n\n'),
                parsed: merged,
                totals: merged.totals,
                sourceDevice: first.sourceDevice,
                createdAt: now,
                updatedAt: now
            };

            var ops = [{ type: 'put', store: 'sheets', value: record }];
            sheets.forEach(function (s) {
                var copy = JSON.parse(JSON.stringify(s));
                copy.mergedInto = record.id;
                copy.updatedAt = now;
                ops.push({ type: 'put', store: 'sheets', value: copy });
            });

            return E().batch(ops).then(function () { return record; });
        });
    }

    /** Undo a combine: clears the flags and removes the combined record. */
    function uncombineSheets(id) {
        return getSheet(id).then(function (record) {
            if (!record || !record.combinedFrom) throw new Error('That is not a combined sheet');

            return E().getAll('sheets').then(function (all) {
                var ops = [{ type: 'del', store: 'sheets', key: id }];
                all.forEach(function (s) {
                    if (s.mergedInto === id) {
                        var copy = JSON.parse(JSON.stringify(s));
                        delete copy.mergedInto;
                        copy.updatedAt = new Date().toISOString();
                        ops.push({ type: 'put', store: 'sheets', value: copy });
                    }
                });
                return E().batch(ops);
            });
        });
    }

    /* =========================================================
       Manual entries (credits / payments recorded by hand)
       ========================================================= */

    function listManual() {
        return E().getAll('manual').then(function (rows) {
            return rows.sort(function (a, b) { return String(a.dateKey).localeCompare(String(b.dateKey)); });
        });
    }

    function addManual(entry) {
        var record = {
            id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            dateKey: entry.dateKey || global.WCParser.todayKey(),
            customerKey: entry.customerKey,
            customerName: entry.customerName,
            type: entry.type,
            amount: Math.abs(Number(entry.amount) || 0),
            note: entry.note || '',
            updatedAt: new Date().toISOString()
        };

        return open()
            .then(function () { return E().put('manual', record); })
            .then(function () { return touchCustomer(entry.customerKey, entry.customerName); })
            .then(function () { return record; });
    }

    function deleteManual(id) { return E().del('manual', id); }

    function touchCustomer(key, name) {
        if (!key) return Promise.resolve();
        return E().get('customers', key).then(function (existing) {
            if (existing) return null;
            return E().put('customers', { key: key, name: name, createdAt: new Date().toISOString() });
        });
    }

    function listCustomers() { return E().getAll('customers'); }

    /** Adds any names we have not seen before. Existing rows are untouched. */
    function registerCustomers(rows) {
        if (!rows || !rows.length) return Promise.resolve();
        return E().getAll('customers').then(function (existing) {
            var known = {};
            existing.forEach(function (c) { known[c.key] = true; });
            var fresh = rows.filter(function (r) { return r.key && !known[r.key]; });
            return E().putMany('customers', fresh);
        });
    }

    /**
     * Renames a customer, or folds them into an existing name.
     *
     * "aling nena" is a perfectly good name when you do not know who the
     * person really is. But later you might learn it, or you might have typed
     * the same customer two different ways. Keys are the normalised name, so
     * renaming onto a name that already exists merges the two ledgers.
     *
     * Customer names live inside sheet.parsed, so this rewrites every sheet
     * and manual entry that mentions them, then recomputes balances.
     */
    function relabelCustomer(fromKey, newName) {
        var P = global.WCParser;
        var cleaned = String(newName || '').trim().replace(/\s+/g, ' ');
        var toKey = P.customerKeyOf(cleaned);

        if (!fromKey) return Promise.reject(new Error('Nothing selected.'));
        if (!toKey) return Promise.reject(new Error('Type a name first.'));

        var merged = toKey !== fromKey;

        function fixSheet(sheet) {
            var parsed = sheet.parsed || {};
            var touched = false;

            function sweep(list) {
                if (!Array.isArray(list)) return;
                list.forEach(function (item) {
                    if (item && item.key === fromKey) {
                        item.key = toKey;
                        item.name = cleaned;
                        touched = true;
                    }
                });
            }

            sweep(parsed.remainingSnapshot);
            sweep(parsed.ledger);
            sweep(parsed.borrowed);

            ['expenses', 'creditsToday', 'creditsPaid', 'remaining', 'change'].forEach(function (sec) {
                var s = parsed[sec];
                if (s && Array.isArray(s.named)) sweep(s.named);
            });

            if (touched && P && P.computeBalances) {
                parsed.balances = P.computeBalances(parsed);
            }
            return touched;
        }

        return Promise.all([getAllSheets(), listManual()]).then(function (res) {
            var sheets = res[0];
            var manual = res[1];
            var ops = [];
            var stat = { merged: merged, sheets: 0, manual: 0 };

            sheets.forEach(function (sheet) {
                if (fixSheet(sheet)) {
                    stat.sheets++;
                    ops.push({ type: 'put', store: 'sheets', value: sheet });
                }
            });

            manual.forEach(function (m) {
                if (m.customerKey === fromKey) {
                    m.customerKey = toKey;
                    m.customerName = cleaned;
                    stat.manual++;
                    ops.push({ type: 'put', store: 'manual', value: m });
                }
            });

            ops.push({ type: 'delete', store: 'customers', key: fromKey });
            ops.push({
                type: 'put', store: 'customers',
                value: { key: toKey, name: cleaned, createdAt: new Date().toISOString() }
            });

            return E().batch(ops).then(function () { return stat; });
        });
    }

    /* =========================================================
       Derived view: balances and ledgers
       ========================================================= */

    /**
     * Reads the sheet history the way the notes are written:
     * the newest sheet with a "Remaining" list defines who owes what.
     *
     * Returns {
     *   balances : [{key,name,amount,asOf,status}]
     *   history  : { key: [{dateKey, amount}] }
     *   missing  : [names on the previous list with no entry in the newest]
     *   rollForward : [per-customer differences for the newest sheet]
     *   change   : { list, total }
     *   borrowed : { list, total }
     * }
     */
    function buildSnapshotView(sheets, manual) {
        var P = global.WCParser;

        var history = {};        // key -> [{dateKey, carried, newUtang, collected, total}]
        var names = {};          // key -> display name
        var latest = {};         // key -> row from the newest sheet with a Remaining list
        var before = {};         // key -> row from the sheet before that
        var lastDate = null;
        var beforeDate = null;
        var anySheet = false;

        var change = [];
        var borrowed = [];

        sheets.forEach(function (sheet) {
            var parsed = sheet.parsed || {};
            var dateKey = sheet.startDateKey || sheet.id;
            var list = parsed.balances || [];

            if (list.length) {
                anySheet = true;
                before = latest;
                beforeDate = lastDate;

                var fresh = {};
                list.forEach(function (b) {
                    if (!b.key || b.key === '__unassigned__') return;
                    if (!names[b.key]) names[b.key] = b.name;
                    fresh[b.key] = {
                        key: b.key, name: names[b.key],
                        total: b.total,
                        carried: b.carried, given: b.given, paid: b.paid,
                        dateKey: dateKey
                    };
                    if (!history[b.key]) history[b.key] = [];
                    history[b.key].push({
                        dateKey: dateKey,
                        carried: b.carried, newUtang: b.given,
                        collected: b.paid, total: b.total
                    });
                });

                latest = fresh;
                lastDate = dateKey;
            }

            (parsed.change && parsed.change.named ? parsed.change.named : []).forEach(function (c) {
                if (c.key === '__unassigned__') return;
                if (!names[c.key]) names[c.key] = c.name;
                change.push({ key: c.key, name: c.name, amount: c.amount, dateKey: dateKey });
            });

            (parsed.borrowed || []).forEach(function (b) {
                var k = P.customerKeyOf(b.name);
                if (k && !names[k]) names[k] = b.name;
                borrowed.push({ key: k, name: b.name, gallons: b.gallons, dateKey: dateKey });
            });
        });

        // All-time totals per customer
        var owedAllTime = {};
        var paidAllTime = {};
        sheets.forEach(function (sheet) {
            ((sheet.parsed || {}).ledger || []).forEach(function (e) {
                if (!names[e.key]) names[e.key] = e.name;
                if (e.type === 'given') owedAllTime[e.key] = (owedAllTime[e.key] || 0) + e.amount;
                else paidAllTime[e.key] = (paidAllTime[e.key] || 0) + e.amount;
            });
        });
        (manual || []).forEach(function (m) {
            if (!m.customerKey) return;
            if (!names[m.customerKey]) names[m.customerKey] = m.customerName;
            if (m.type === 'given') owedAllTime[m.customerKey] = (owedAllTime[m.customerKey] || 0) + m.amount;
            else paidAllTime[m.customerKey] = (paidAllTime[m.customerKey] || 0) + m.amount;
        });

        // Payments typed in after the newest sheet ride on top of it
        var adjust = {};
        (manual || []).forEach(function (m) {
            if (!m.customerKey) return;
            if (lastDate && String(m.dateKey || '') < String(lastDate)) return;
            if (!adjust[m.customerKey]) adjust[m.customerKey] = { given: 0, paid: 0 };
            if (m.type === 'given') adjust[m.customerKey].given += m.amount;
            else adjust[m.customerKey].paid += m.amount;
        });

        function buildRow(k, row) {
            var adj = adjust[k] || { given: 0, paid: 0 };
            var amount = P.round2(row.total + adj.given - adj.paid);
            return {
                key: k,
                name: names[k] || row.name,
                amount: amount,
                carriedLast: P.round2(row.carried),
                newUtang: P.round2(row.given + adj.given),
                collected: P.round2(row.paid + adj.paid),
                sheetUtang: P.round2(row.given),
                sheetCollected: P.round2(row.paid),
                manualUtang: P.round2(adj.given),
                manualCollected: P.round2(adj.paid),
                asOf: row.dateKey || null,
                owedAllTime: P.round2(owedAllTime[k] || 0),
                paidAllTime: P.round2(paidAllTime[k] || 0),
                status: amount > 0 ? 'current' : 'settled'
            };
        }

        var balances = Object.keys(latest).map(function (k) {
            return buildRow(k, latest[k]);
        });

        // Customers who only ever show up in manual entries
        Object.keys(owedAllTime).concat(Object.keys(paidAllTime)).forEach(function (k) {
            if (latest[k]) return;
            if (balances.some(function (b) { return b.key === k; })) return;
            balances.push(buildRow(k, { name: names[k] || k, total: 0, carried: 0,
                                        given: 0, paid: 0, dateKey: null }));
        });

        balances.sort(function (a, b) {
            if (b.amount !== a.amount) return b.amount - a.amount;
            return String(a.name).localeCompare(String(b.name));
        });

        // People who owed on the previous list but are not mentioned in the newest one
        var missing = Object.keys(before)
            .filter(function (k) { return !latest[k] && before[k].total > 0; })
            .map(function (k) {
                return { key: k, name: names[k] || k, amount: before[k].total, asOf: beforeDate };
            })
            .sort(function (a, b) { return b.amount - a.amount; });

        // The carried amount should equal what the customer ended at last time
        var rollForward = [];
        Object.keys(latest).forEach(function (k) {
            if (!before[k]) return;
            var endedAt = before[k].total;
            var carried = latest[k].carried;
            var diff = P.round2(carried - endedAt);
            if (Math.abs(diff) >= 0.5) {
                rollForward.push({
                    key: k,
                    name: names[k] || k,
                    endedAt: P.round2(endedAt),
                    carried: P.round2(carried),
                    diff: diff,
                    asOf: beforeDate,
                    dateKey: latest[k].dateKey
                });
            }
        });
        rollForward.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });

        // Merge borrowed gallons by name (newest count wins, they are a live count)
        var borrowMap = {};
        borrowed.forEach(function (b) { borrowMap[b.key] = b; });

        return {
            balances: balances,
            history: history,
            missing: missing,
            rollForward: rollForward,
            lastSnapshotDate: lastDate,
            hasSnapshot: anySheet,
            change: {
                list: change,
                total: P.round2(change.reduce(function (a, c) { return a + c.amount; }, 0))
            },
            borrowed: {
                list: Object.keys(borrowMap).map(function (k) { return borrowMap[k]; }),
                total: P.round2(Object.keys(borrowMap).reduce(function (a, k) {
                    return a + borrowMap[k].gallons;
                }, 0))
            }
        };
    }

    function snapshotView() {
        return Promise.all([getAllSheets(), listManual()]).then(function (res) {
            return buildSnapshotView(res[0], res[1]);
        });
    }

    function outstandingTotal() {
        return snapshotView().then(function (view) {
            return global.WCParser.round2(view.balances.reduce(function (a, b) {
                return a + (b.amount > 0 ? b.amount : 0);
            }, 0));
        });
    }

    /* =========================================================
       Export / import
       ========================================================= */

    function exportPayload(deviceLabel) {
        return Promise.all([getAllSheets(), listManual(), listCustomers()])
            .then(function (res) {
                return {
                    app: 'watercalc',
                    schemaVersion: SCHEMA_VERSION,
                    exportedAt: new Date().toISOString(),
                    device: deviceLabel || 'unknown',
                    sheets: res[0],
                    manual: res[1],
                    customers: res[2]
                };
            });
    }

    function validatePayload(payload) {
        var problems = [];
        if (!payload || typeof payload !== 'object') {
            problems.push('File is not valid JSON.');
            return problems;
        }
        if (payload.app !== 'watercalc') {
            problems.push('This does not look like a Water Calculator backup.');
            return problems;
        }
        if (payload.schemaVersion && payload.schemaVersion > SCHEMA_VERSION) {
            problems.push('Backup was made by a newer version (v' + payload.schemaVersion + '). Update the app first.');
        }
        var hasSheets = Array.isArray(payload.sheets);
        var hasDays = Array.isArray(payload.days);   // older backups
        if (!hasSheets && !hasDays) problems.push('Backup has no sheets list.');
        return problems;
    }

    /**
     * Merges a backup in. Newer updatedAt wins; nothing is ever deleted.
     * Also upgrades v1 backups (which stored days + credit events).
     */
    function importPayload(payload) {
        var plan = { added: 0, updated: 0, skipped: 0, manualAdded: 0, manualUpdated: 0, upgraded: 0 };

        var incoming = (payload.sheets || []).slice();

        // Upgrade a v1 backup: turn days into sheets
        if (!incoming.length && Array.isArray(payload.days)) {
            payload.days.forEach(function (day) {
                incoming.push({
                    id: day.id,
                    startDateKey: day.dateKey || day.id,
                    endDateKey: day.dateKey || day.id,
                    dateKeys: [day.dateKey || day.id],
                    label: day.dateLabel || day.id,
                    rawText: day.rawText || '',
                    parsed: day.parsed || {},
                    totals: day.totals || {},
                    sourceDevice: day.sourceDevice,
                    createdAt: day.createdAt,
                    updatedAt: day.updatedAt
                });
                plan.upgraded++;
            });
        }

        return Promise.all([getAllSheets(), listManual(), listCustomers()]).then(function (res) {
            var local = {};
            res[0].forEach(function (s) { local[s.id] = s; });

            var localManual = {};
            res[1].forEach(function (m) { localManual[m.id] = m; });

            var localCustomers = {};
            res[2].forEach(function (c) { localCustomers[c.key] = c; });

            var ops = [];

            incoming.forEach(function (s) {
                if (!s || !s.id) return;
                var existing = local[s.id];
                if (!existing) {
                    ops.push({ type: 'put', store: 'sheets', value: s });
                    plan.added++;
                    return;
                }
                var inT = Date.parse(s.updatedAt || 0) || 0;
                var exT = Date.parse(existing.updatedAt || 0) || 0;
                if (inT > exT) {
                    ops.push({ type: 'put', store: 'sheets', value: s });
                    plan.updated++;
                } else {
                    plan.skipped++;
                }
            });

            (payload.manual || []).forEach(function (m) {
                if (!m || !m.id) return;
                var existing = localManual[m.id];
                if (!existing) { ops.push({ type: 'put', store: 'manual', value: m }); plan.manualAdded++; }
                else if ((Date.parse(m.updatedAt || 0) || 0) > (Date.parse(existing.updatedAt || 0) || 0)) {
                    ops.push({ type: 'put', store: 'manual', value: m });
                    plan.manualUpdated++;
                }
            });

            (payload.customers || []).forEach(function (c) {
                if (!c || !c.key || localCustomers[c.key]) return;
                ops.push({ type: 'put', store: 'customers', value: c });
            });

            return E().batch(ops).then(function () {
                return setMeta('lastImportAt', new Date().toISOString()).then(function () { return plan; });
            });
        });
    }

    function clearAll() { return E().clearAll(); }

    /* =========================================================
       Public API
       ========================================================= */

    global.WCStore = {
        open: open,
        engineName: engineName,
        requestPersistence: requestPersistence,
        estimate: estimate,

        getMeta: getMeta,
        setMeta: setMeta,

        listSheets: listSheets,
        getAllSheets: getAllSheets,
        getSheet: getSheet,
        saveSheet: saveSheet,
        deleteSheet: deleteSheet,
        combineSheets: combineSheets,
        uncombineSheets: uncombineSheets,

        listManual: listManual,
        addManual: addManual,
        deleteManual: deleteManual,
        listCustomers: listCustomers,
        registerCustomers: registerCustomers,
        touchCustomer: touchCustomer,
        relabelCustomer: relabelCustomer,

        snapshotView: snapshotView,
        buildSnapshotView: buildSnapshotView,
        outstandingTotal: outstandingTotal,

        exportPayload: exportPayload,
        validatePayload: validatePayload,
        importPayload: importPayload,
        clearAll: clearAll,

        SCHEMA_VERSION: SCHEMA_VERSION
    };
})(typeof window !== 'undefined' ? window : this);
