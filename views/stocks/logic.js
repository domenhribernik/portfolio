// DOM-free logic for the Borza LJSE tracker (views/stocks). Everything here
// is pure and tested by tests/stocks-logic.test.mjs; script.js only wires
// these functions to the DOM and the controller.

const DASH = '–';

/** Slovenian number format: dot thousands, comma decimals. */
export function fmtNum(value, decimals = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) return DASH;
    const fixed = Math.abs(value).toFixed(decimals);
    const [whole, frac] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
    return sign + grouped + (frac !== undefined ? ',' + frac : '');
}

/** EUR amount in Slovenian format, e.g. 1.234,50 €. */
export function fmtEur(value, decimals = 2) {
    const n = fmtNum(value, decimals);
    return n === DASH ? DASH : n + ' €';
}

/** Signed percentage, e.g. +2,35 %. */
export function fmtPct(value, decimals = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) return DASH;
    const n = fmtNum(value, decimals);
    return (value > 0 ? '+' : '') + n + ' %';
}

/** Quantity without trailing decimal zeros: 10, 10,5, 1.250,25. */
export function fmtQty(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return DASH;
    const decimals = Math.min(4, (String(value).split('.')[1] || '').length);
    return fmtNum(value, decimals);
}

/** ISO date (yyyy-mm-dd) to Slovenian short form: 18. 7. 2026. */
export function fmtDateSl(iso) {
    if (!iso || typeof iso !== 'string') return DASH;
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return DASH;
    return `${d}. ${m}. ${y}`;
}

/**
 * FIFO ledger math: fold a flat transaction list (any order) into per-
 * instrument holdings. Buy fees load the lot's cost basis, sell fees reduce
 * proceeds, 'div' rows accumulate net dividend cash without touching shares.
 * Returns { [instrumentId]: { qty, costBasis, avgCost, realized, dividends, lots } }.
 */
export function computeHoldings(transactions) {
    const byInstrument = {};
    const sorted = [...transactions].sort((a, b) =>
        a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : (a.id || 0) - (b.id || 0));

    for (const t of sorted) {
        const key = t.instrument_id;
        const h = byInstrument[key] ||= { qty: 0, costBasis: 0, avgCost: null, realized: 0, dividends: 0, lots: [] };
        const qty = Number(t.quantity);
        const price = Number(t.price);
        const fees = Number(t.fees || 0);

        if (t.side === 'buy') {
            h.lots.push({ date: t.trade_date, qty, unitCost: (qty * price + fees) / qty });
        } else if (t.side === 'sell') {
            let remaining = qty;
            let costOut = 0;
            while (remaining > 0 && h.lots.length > 0) {
                const lot = h.lots[0];
                const take = Math.min(lot.qty, remaining);
                costOut += take * lot.unitCost;
                lot.qty -= take;
                remaining -= take;
                if (lot.qty <= 1e-9) h.lots.shift();
            }
            const soldQty = qty - remaining; // oversell beyond held shares is clamped
            h.realized += (soldQty * price - fees) - costOut;
        } else if (t.side === 'div') {
            h.dividends += qty * price - fees;
        }

        h.qty = h.lots.reduce((sum, lot) => sum + lot.qty, 0);
        h.costBasis = h.lots.reduce((sum, lot) => sum + lot.qty * lot.unitCost, 0);
        h.avgCost = h.qty > 0 ? h.costBasis / h.qty : null;
    }
    return byInstrument;
}

// Slovenian capital-gains ladder (ZDoh-2, securities): rate by completed
// years of holding. Kept as data so a law change is a one-line edit.
export const CGT_LADDER = [
    { fromYears: 15, ratePct: 0 },
    { fromYears: 10, ratePct: 15 },
    { fromYears: 5, ratePct: 20 },
    { fromYears: 0, ratePct: 25 },
];

function yearsBetween(fromIso, toIso) {
    const [fy, fm, fd] = fromIso.slice(0, 10).split('-').map(Number);
    const [ty, tm, td] = toIso.slice(0, 10).split('-').map(Number);
    let years = ty - fy;
    if (tm < fm || (tm === fm && td < fd)) years -= 1;
    return years;
}

function addYears(iso, years) {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return `${y + years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Capital-gains rate (percent) for a lot bought on buyDate, sold on onDate. */
export function cgtRatePct(buyDateIso, onDateIso) {
    const held = yearsBetween(buyDateIso, onDateIso);
    return CGT_LADDER.find((step) => held >= step.fromYears).ratePct;
}

/**
 * Estimate tax if everything were sold today: per-lot gain at last price,
 * the lot's current rate, tax on positive gains only, and when the next
 * cheaper rate kicks in. An estimate: the yearly return also nets losses.
 */
export function taxReport(lots, lastPrice, todayIso) {
    const rows = lots.map((lot) => {
        const gain = lot.qty * (lastPrice - lot.unitCost);
        const ratePct = cgtRatePct(lot.date, todayIso);
        const held = yearsBetween(lot.date, todayIso);
        const nextStep = [...CGT_LADDER].reverse().find((step) => step.fromYears > held);
        return {
            date: lot.date,
            qty: lot.qty,
            unitCost: lot.unitCost,
            gain,
            ratePct,
            tax: gain > 0 ? gain * (ratePct / 100) : 0,
            nextDropDate: nextStep ? addYears(lot.date, nextStep.fromYears) : null,
            nextRatePct: nextStep ? nextStep.ratePct : null,
        };
    });
    return {
        lots: rows,
        totalGain: rows.reduce((sum, r) => sum + r.gain, 0),
        totalTax: rows.reduce((sum, r) => sum + r.tax, 0),
    };
}

/** Daily move in percent against previous close; null when there is no base. */
export function changePct(last, prevClose) {
    if (last === null || last === undefined || !prevClose) return null;
    return (last - prevClose) / prevClose * 100;
}

/** Position of the last price inside the 52-week range, clamped to 0..1. */
export function weekPos52(last, low, high) {
    if (high === low) return 0.5;
    return Math.min(1, Math.max(0, (last - low) / (high - low)));
}

/**
 * Which alert rules fire for the given quotes. Mirrors the server-side rules
 * in stocks-sync-service.php so the view can preview what a rule would do.
 * Returns [{ alert, quote, movePct }].
 */
export function evaluateAlerts(alerts, quotes) {
    const fired = [];
    for (const alert of alerts) {
        if (!Number(alert.active)) continue;
        for (const quote of quotes) {
            if (alert.instrument_id !== null && alert.instrument_id !== quote.instrument_id) continue;
            const threshold = Number(alert.threshold);
            const movePct = changePct(quote.last, quote.prevClose);
            const hit =
                (alert.kind === 'above' && quote.last >= threshold) ||
                (alert.kind === 'below' && quote.last <= threshold) ||
                (alert.kind === 'move' && movePct !== null && Math.abs(movePct) >= threshold);
            if (hit) fired.push({ alert, quote, movePct });
        }
    }
    return fired;
}

/** Compact SVG path for a sparkline; needs at least two points. */
export function sparklinePath(values, width, height, pad = 2) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const innerW = width - 2 * pad;
    const innerH = height - 2 * pad;
    const points = values.map((v, i) => {
        const x = pad + (i / (values.length - 1)) * innerW;
        const y = span === 0 ? height / 2 : pad + (1 - (v - min) / span) * innerH;
        return `${round2(x)},${round2(y)}`;
    });
    return 'M' + points.join('L');
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/** Round axis ticks covering [min, max] in roughly `count` steps. */
export function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const rawStep = (max - min) / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const candidates = [1, 2, 2.5, 5, 10];
    const step = candidates.find((c) => c * magnitude >= rawStep) * magnitude;
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v < max + step - 1e-9; v += step) {
        ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return ticks;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(iso) {
    return Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY_MS;
}

/**
 * Scale a [{date, value}] series into an SVG path inside a plot box whose
 * y-domain is [min, max]. X is proportional to real time, not to the index,
 * so weekend gaps do not distort the line.
 */
export function seriesToPath(series, { width, height, min, max }) {
    if (!series || series.length < 2) return '';
    const x0 = dayNumber(series[0].date);
    const x1 = dayNumber(series[series.length - 1].date);
    const xSpan = x1 - x0 || 1;
    const ySpan = max - min || 1;
    const points = series.map((p) => {
        const x = ((dayNumber(p.date) - x0) / xSpan) * width;
        const y = (1 - (p.value - min) / ySpan) * height;
        return `${round2(x)},${round2(y)}`;
    });
    return 'M' + points.join('L');
}

/**
 * Join FIFO holdings to live quotes: market value, unrealized P/L, day move
 * and portfolio weight per open position. Sold-out instruments are omitted
 * (their realized P/L still counts via computeHoldings).
 */
export function enrichHoldings(holdings, quotes) {
    const quoteById = Object.fromEntries(quotes.map((q) => [q.instrument_id, q]));
    const rows = [];
    for (const [instrumentId, h] of Object.entries(holdings)) {
        if (h.qty <= 0) continue;
        const quote = quoteById[instrumentId] || {};
        const last = quote.last ?? null;
        const prev = quote.prevClose ?? null;
        rows.push({
            instrument_id: Number(instrumentId),
            symbol: quote.symbol ?? null,
            ...h,
            last,
            value: last !== null ? h.qty * last : null,
            unrealized: last !== null ? h.qty * last - h.costBasis : null,
            dayChange: last !== null && prev !== null ? h.qty * (last - prev) : null,
        });
    }
    const total = rows.reduce((sum, r) => sum + (r.value || 0), 0);
    for (const r of rows) {
        r.weightPct = total > 0 && r.value !== null ? (r.value / total) * 100 : null;
    }
    return rows;
}

/** Portfolio totals over enriched rows. */
enrichHoldings.totals = function (rows) {
    const sum = (pick) => rows.reduce((acc, r) => acc + (pick(r) || 0), 0);
    return {
        value: sum((r) => r.value),
        costBasis: sum((r) => r.costBasis),
        unrealized: sum((r) => r.unrealized),
        dayChange: sum((r) => r.dayChange),
        realized: sum((r) => r.realized),
        dividends: sum((r) => r.dividends),
    };
};

export const SEGMENT_LABELS = { A: 'Prva kotacija', B: 'Standardna kotacija', E: 'ETF' };

/** Group instruments into the board's fixed segment order. */
export function groupBySegment(instruments) {
    const order = ['A', 'B', 'E'];
    return order
        .map((segment) => ({
            segment,
            label: SEGMENT_LABELS[segment],
            instruments: instruments
                .filter((i) => i.segment === segment)
                .sort((a, b) => a.symbol.localeCompare(b.symbol)),
        }))
        .filter((g) => g.instruments.length > 0);
}

/**
 * Daily portfolio value series for the chart: at every trading date from the
 * first transaction on, quantity held per instrument times the last known
 * close (carried forward across gaps), plus cumulative net invested cash
 * (buy cost incl. fees, minus net sale proceeds; dividends do not move it).
 * closesByInstrument: { [instrumentId]: [{date, close}] } sorted or not.
 */
export function portfolioTimeline(transactions, closesByInstrument) {
    if (!transactions.length) return [];
    const txs = [...transactions].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    const firstDate = txs[0].trade_date;

    const dates = [...new Set(
        Object.values(closesByInstrument).flat().map((c) => c.date),
    )].filter((d) => d >= firstDate).sort();

    const sortedCloses = {};
    for (const [id, list] of Object.entries(closesByInstrument)) {
        sortedCloses[id] = [...list].sort((a, b) => a.date.localeCompare(b.date));
    }

    const timeline = [];
    let txIndex = 0;
    const qty = {};
    let invested = 0;
    const cursor = {}; // per-instrument index of the last close <= current date
    const lastClose = {};

    for (const date of dates) {
        while (txIndex < txs.length && txs[txIndex].trade_date <= date) {
            const t = txs[txIndex++];
            const q = Number(t.quantity);
            const price = Number(t.price);
            const fees = Number(t.fees || 0);
            if (t.side === 'buy') {
                qty[t.instrument_id] = (qty[t.instrument_id] || 0) + q;
                invested += q * price + fees;
            } else if (t.side === 'sell') {
                qty[t.instrument_id] = Math.max(0, (qty[t.instrument_id] || 0) - q);
                invested -= q * price - fees;
            }
        }
        let value = 0;
        for (const [id, held] of Object.entries(qty)) {
            if (held <= 0) continue;
            const list = sortedCloses[id] || [];
            let i = cursor[id] ?? 0;
            while (i < list.length && list[i].date <= date) {
                lastClose[id] = list[i].close;
                i++;
            }
            cursor[id] = i;
            if (lastClose[id] !== undefined) value += held * lastClose[id];
        }
        timeline.push({ date, value, invested });
    }
    return timeline;
}

/**
 * Parse a user-typed Slovenian number: comma decimals, optional thousands
 * dots (1.250,25). A bare dot with no comma is treated as a decimal point
 * (268.5), since nobody types thousands separators without decimals.
 */
export function parseSlNum(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') return null;
    let normalized;
    if (raw.includes(',')) {
        normalized = raw.replace(/\./g, '').replace(',', '.');
    } else if ((raw.match(/\./g) || []).length === 1) {
        normalized = raw;
    } else {
        normalized = raw.replace(/\./g, '');
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}

/**
 * Payouts a holder can still expect: calendar rows whose pay date is today
 * or later (or not yet announced, dates null), for instruments held now.
 * Returns { rows: [{...row, mine}], total } with mine = qty * amount.
 */
export function expectedDividends(dividends, holdings, todayIso) {
    const rows = [];
    let total = 0;
    for (const d of dividends) {
        const holding = holdings[d.instrument_id];
        if (!holding || holding.qty <= 0) continue;
        if (d.pay_date !== null && d.pay_date !== undefined && d.pay_date < todayIso) continue;
        const mine = holding.qty * d.amount;
        rows.push({ ...d, mine });
        total += mine;
    }
    return { rows, total };
}

/**
 * The calendar's visible rows: payouts whose payment day is today or later,
 * plus undated announcements. Record-day order, undated rows last.
 */
export function upcomingDividends(dividends, todayIso) {
    return dividends
        .filter((d) => d.pay_date === null || d.pay_date === undefined || d.pay_date >= todayIso)
        .sort((a, b) => {
            if (!a.ex_date && !b.ex_date) return (a.id || 0) - (b.id || 0);
            if (!a.ex_date) return 1;
            if (!b.ex_date) return -1;
            return a.ex_date.localeCompare(b.ex_date);
        });
}
