document.addEventListener('DOMContentLoaded', () => {
    const rawLogInput = document.getElementById('raw-log');
    const calcBtn = document.getElementById('calc-btn');
    const clearBtn = document.getElementById('clear-btn');
    const exportBtn = document.getElementById('export-btn');
    const dashboard = document.getElementById('results-dashboard');

    // Load saved notes on startup
    const savedLog = localStorage.getItem('waterLogHistory');
    if (savedLog) rawLogInput.value = savedLog;

    calcBtn.addEventListener('click', () => {
        const text = rawLogInput.value;
        localStorage.setItem('waterLogHistory', text);
        const parsedData = parseLog(text);
        const totals = calculateTotals(parsedData);
        renderUI(parsedData, totals);
    });

    clearBtn.addEventListener('click', () => {
        rawLogInput.value = '';
        localStorage.removeItem('waterLogHistory');
        dashboard.classList.add('hidden');
    });

    exportBtn.addEventListener('click', () => {
        const summaryText = generateExportText();
        navigator.clipboard.writeText(summaryText).then(() => {
            exportBtn.innerText = "✅ Copied!";
            setTimeout(() => exportBtn.innerText = "📋 Copy Summary", 2000);
        });
    });

    // ==========================================
    // 1. STATE MACHINE PARSER (Reads text)
    // ==========================================
    function parseLog(text) {
        // Remove commas, split by line, and trim edges. (We keep empty lines to help separate trips)
        const lines = text.replace(/,/g, '').split('\n').map(l => l.trim());
        
        let state = 'idle';
        let currentTrip = null;

        const data = {
            date: "Today's Summary",
            expenses: { items: [], statedTotal: 0 },
            creditsToday: { items: [], statedTotal: 0 },
            creditsPaid: { items: [], statedTotal: 0 },
            remainingCredits: { items: [], statedTotal: 0 },
            trips: []
        };

        // Looser Regex to catch misspellings (e.g., "Febuary" or "Jan 5")
        const dateRegex = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i;
        const numberStartRegex = /^(\d+(\.\d+)?)/;
        const pxqRegex = /^(\d+)\s*[xX*]\s*(\d+)/; 

        for (let line of lines) {
            // A blank line closes the current trip so the next one starts fresh
            if (line === '') {
                currentTrip = null;
                continue;
            }

            const lowerLine = line.toLowerCase();

            // Auto-detect Date
            if (dateRegex.test(lowerLine) && state === 'idle') {
                data.date = line;
                continue;
            }

            // Detect Sections (Forgiving checks)
            if (lowerLine.startsWith('expense')) { 
                state = 'expenses'; 
                data.expenses.statedTotal = extractStatedTotal(line); 
                currentTrip = null; 
                continue; 
            }
            if (lowerLine.startsWith('credits today')) { 
                state = 'credits_today'; 
                data.creditsToday.statedTotal = extractStatedTotal(line); 
                currentTrip = null; 
                continue; 
            }
            if (lowerLine.startsWith('credits paid')) { 
                state = 'credits_paid'; 
                data.creditsPaid.statedTotal = extractStatedTotal(line); 
                currentTrip = null; 
                continue; 
            }
            if (lowerLine.startsWith('remaining')) { 
                state = 'remaining_credits'; 
                data.remainingCredits.statedTotal = extractStatedTotal(line); 
                currentTrip = null; 
                continue; 
            }

            // Detect Trip Headers (e.g., "37R 1st trip")
            if (line.match(/^\d+R/i)) {
                // If we don't have an active trip, OR if the word "trip" is explicitly written, start a new one
                if (!currentTrip || lowerLine.includes('trip')) {
                    state = 'trips';
                    currentTrip = {
                        name: line,
                        sales: [] // We use an array so we can hold multiple prices (25x4 AND 20x31)
                    };
                    data.trips.push(currentTrip);
                    continue;
                }
                // If it's just a mid-trip note (like "35R"), we just ignore it and keep the current trip open.
                continue;
            }

            // Parse Multiple Trip Details (e.g., "25x4", "20x31")
            if (state === 'trips' && currentTrip) {
                const pxqMatch = line.match(pxqRegex);
                if (pxqMatch) {
                    currentTrip.sales.push({
                        price: parseFloat(pxqMatch[1]),
                        qty: parseFloat(pxqMatch[2])
                    });
                    continue;
                }
            }

            // Extract generic lists (Expenses, Credits, etc.)
            const numMatch = line.match(numberStartRegex);
            if (numMatch && ['expenses', 'credits_today', 'credits_paid', 'remaining_credits'].includes(state)) {
                let val = parseFloat(numMatch[1]);
                
                // SMART FEATURE: If the line contains an "=" sign, extract the final total instead of the first number.
                // (e.g., "125 tito marvin = 225" will extract 225)
                if (line.includes('=')) {
                    const eqMatch = line.match(/=\s*(\d+(\.\d+)?)/);
                    if (eqMatch) val = parseFloat(eqMatch[1]);
                }

                if (state === 'expenses') data.expenses.items.push(val);
                if (state === 'credits_today') data.creditsToday.items.push(val);
                if (state === 'credits_paid') data.creditsPaid.items.push(val);
                if (state === 'remaining_credits') data.remainingCredits.items.push(val);
            }
        }
        return data;
    }

    function extractStatedTotal(line) {
        const match = line.match(/-\s*(\d+(\.\d+)?)/);
        return match ? parseFloat(match[1]) : 0;
    }

    // ==========================================
    // 2. MATH CALCULATOR (Computes logic)
    // ==========================================
    function calculateTotals(data) {
        const sumArray = (arr) => arr.reduce((acc, curr) => acc + curr, 0);

        const totals = {
            expenses: sumArray(data.expenses.items),
            creditsToday: sumArray(data.creditsToday.items),
            creditsPaid: sumArray(data.creditsPaid.items),
            remainingCredits: sumArray(data.remainingCredits.items),
            totalRevenue: 0,
            totalGallonsSold: 0,
            tripBreakdown: []
        };

        // Calculate Trips (Allows multiple Price x Qty per trip)
        data.trips.forEach((trip) => {
            let tripRev = 0;
            let tripSold = 0;

            trip.sales.forEach(sale => {
                tripRev += sale.price * sale.qty;
                tripSold += sale.qty;
            });

            totals.totalRevenue += tripRev;
            totals.totalGallonsSold += tripSold;
            
            totals.tripBreakdown.push({
                name: trip.name,
                sold: tripSold,
                revenue: tripRev
            });
        });

        // FORMULA: Net = Revenue + Credits Paid - Expenses - Credits Today
        totals.netCashFlow = totals.totalRevenue + totals.creditsPaid - totals.expenses - totals.creditsToday;

        return totals;
    }

    // ==========================================
    // 3. UI RENDERER (Updates DOM)
    // ==========================================
    function renderUI(data, totals) {
        dashboard.classList.remove('hidden');

        const fmt = (num) => '₱' + num.toLocaleString();

        document.getElementById('display-date').innerText = data.date;
        document.getElementById('out-revenue').innerText = fmt(totals.totalRevenue);
        document.getElementById('out-gallons').innerText = `${totals.totalGallonsSold} gallons sold`;
        document.getElementById('out-expenses').innerText = fmt(totals.expenses);
        document.getElementById('out-credits-paid').innerText = fmt(totals.creditsPaid);
        
        const netEl = document.getElementById('out-net');
        netEl.innerText = fmt(totals.netCashFlow);
        netEl.style.color = totals.netCashFlow < 0 ? 'var(--red)' : 'var(--green)';

        const warnExp = document.getElementById('warn-expenses');
        if (data.expenses.statedTotal > 0 && data.expenses.statedTotal !== totals.expenses) {
            warnExp.querySelector('span').innerText = data.expenses.statedTotal.toLocaleString();
            warnExp.classList.remove('hidden');
        } else {
            warnExp.classList.add('hidden');
        }

        document.getElementById('out-credits-today').innerText = totals.creditsToday.toLocaleString();
        document.getElementById('out-rem-credits').innerText = totals.remainingCredits.toLocaleString();

        const tripList = document.getElementById('trip-list');
        tripList.innerHTML = '';
        if (totals.tripBreakdown.length === 0) {
            tripList.innerHTML = '<li>No trips detected</li>';
        } else {
            totals.tripBreakdown.forEach(trip => {
                tripList.innerHTML += `
                    <li>
                        <span>${trip.name} (${trip.sold} gal)</span>
                        <strong>${fmt(trip.revenue)}</strong>
                    </li>`;
            });
        }
    }

    // ==========================================
    // 4. TEXT EXPORTER
    // ==========================================
    function generateExportText() {
        const date = document.getElementById('display-date').innerText;
        const rev = document.getElementById('out-revenue').innerText;
        const exp = document.getElementById('out-expenses').innerText;
        const cPaid = document.getElementById('out-credits-paid').innerText;
        const net = document.getElementById('out-net').innerText;

        return `📊 Water Delivery Summary: ${date}\n` +
               `--------------------------\n` +
               `Total Revenue: ${rev}\n` +
               `Credits Paid:  ${cPaid}\n` +
               `Expenses:      ${exp}\n` +
               `--------------------------\n` +
               `NET CASH FLOW: ${net}`;
    }
});