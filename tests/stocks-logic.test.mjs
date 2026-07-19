// Unit tests for views/stocks/logic.js, the DOM-free brain of the Borza
// LJSE tracker: Slovenian number formatting, FIFO portfolio math, the
// Slovenian capital-gains ladder, alert evaluation and chart geometry.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtEur, fmtPct, fmtQty, fmtDateSl, computeHoldings, cgtRatePct, taxReport, changePct, weekPos52, evaluateAlerts, sparklinePath, niceTicks, seriesToPath, enrichHoldings, groupBySegment, portfolioTimeline, parseSlNum } from '../views/stocks/logic.js';

// The space before € is U+00A0 so the amount never wraps away from its unit.
test('fmtEur renders Slovenian format with dot thousands and comma decimals', () => {
    assert.equal(fmtEur(1234.5), '1.234,50 €');
    assert.equal(fmtEur(0), '0,00 €');
    assert.equal(fmtEur(-987654.321), '-987.654,32 €');
});

test('fmtEur renders a dash for missing values', () => {
    assert.equal(fmtEur(null), '–');
    assert.equal(fmtEur(undefined), '–');
    assert.equal(fmtEur(NaN), '–');
});

test('fmtPct signs positive moves and keeps Slovenian decimals', () => {
    assert.equal(fmtPct(2.345), '+2,35 %');
    assert.equal(fmtPct(-1.2), '-1,20 %');
    assert.equal(fmtPct(0), '0,00 %');
    assert.equal(fmtPct(null), '–');
});

test('fmtQty drops trailing zeros but keeps real fractions', () => {
    assert.equal(fmtQty(10), '10');
    assert.equal(fmtQty(10.5), '10,5');
    assert.equal(fmtQty(1250.25), '1.250,25');
    assert.equal(fmtQty(0.1234), '0,1234');
});

test('fmtDateSl renders a Slovenian short date', () => {
    assert.equal(fmtDateSl('2026-07-18'), '18. 7. 2026');
    assert.equal(fmtDateSl(null), '–');
});

// FIFO ledger math. Transactions arrive in arbitrary order; holdings are per
// instrument. Buy fees increase the lot's cost basis, sell fees reduce the
// proceeds, dividend rows (side 'div') accumulate net cash separately.
const tx = (over) => Object.assign(
    { instrument_id: 1, side: 'buy', quantity: 10, price: 100, fees: 0, trade_date: '2024-01-10' },
    over,
);

test('computeHoldings tracks a single buy with fees in the cost basis', () => {
    const h = computeHoldings([tx({ fees: 5 })])[1];
    assert.equal(h.qty, 10);
    assert.equal(h.costBasis, 1005);
    assert.equal(h.avgCost, 100.5);
    assert.equal(h.realized, 0);
    assert.equal(h.dividends, 0);
    assert.equal(h.lots.length, 1);
});

test('computeHoldings sells FIFO: oldest lot is consumed first', () => {
    const h = computeHoldings([
        tx({ trade_date: '2024-01-10', quantity: 10, price: 100 }),
        tx({ trade_date: '2024-06-10', quantity: 10, price: 120 }),
        tx({ side: 'sell', trade_date: '2025-01-10', quantity: 15, price: 130, fees: 4 }),
    ])[1];
    // Sold 10 @ cost 100 and 5 @ cost 120; proceeds 15*130 - 4 = 1946.
    assert.equal(h.qty, 5);
    assert.equal(h.costBasis, 600);
    assert.equal(h.realized, 1946 - (10 * 100 + 5 * 120));
    assert.equal(h.lots.length, 1);
    assert.equal(h.lots[0].date, '2024-06-10');
    assert.equal(h.lots[0].qty, 5);
});

test('computeHoldings sorts by date before applying FIFO', () => {
    const h = computeHoldings([
        tx({ side: 'sell', trade_date: '2025-01-10', quantity: 5, price: 130 }),
        tx({ trade_date: '2024-01-10', quantity: 10, price: 100 }),
    ])[1];
    assert.equal(h.qty, 5);
    assert.equal(h.realized, 5 * 130 - 5 * 100);
});

test('computeHoldings accumulates dividends as net cash, not shares', () => {
    const h = computeHoldings([
        tx({}),
        tx({ side: 'div', trade_date: '2025-05-01', quantity: 10, price: 1.5, fees: 3 }),
    ])[1];
    assert.equal(h.qty, 10);
    assert.equal(h.dividends, 12);
});

test('computeHoldings clamps an oversell instead of going negative', () => {
    const h = computeHoldings([
        tx({ quantity: 5 }),
        tx({ side: 'sell', trade_date: '2025-01-10', quantity: 8, price: 110 }),
    ])[1];
    assert.equal(h.qty, 0);
    assert.equal(h.lots.length, 0);
});

test('computeHoldings keeps instruments separate', () => {
    const all = computeHoldings([tx({}), tx({ instrument_id: 2, quantity: 3 })]);
    assert.equal(all[1].qty, 10);
    assert.equal(all[2].qty, 3);
});

// Slovenian capital-gains ladder (ZDoh-2): 25 % under 5 years of holding,
// 20 % under 10, 15 % under 15, tax-free from the 15th anniversary on. The
// lower rate applies from the anniversary day itself.
test('cgtRatePct follows the 25/20/15/0 ladder', () => {
    assert.equal(cgtRatePct('2024-01-10', '2026-07-18'), 25);
    assert.equal(cgtRatePct('2020-01-10', '2025-01-10'), 20);
    assert.equal(cgtRatePct('2015-03-01', '2026-07-18'), 15);
    assert.equal(cgtRatePct('2010-01-01', '2026-07-18'), 0);
    assert.equal(cgtRatePct('2011-07-18', '2026-07-18'), 0);
});

test('taxReport prices each lot, taxes only gains, and knows the next drop', () => {
    const lots = [
        { date: '2024-01-10', qty: 10, unitCost: 100 },
        { date: '2010-01-10', qty: 5, unitCost: 300 },
    ];
    const r = taxReport(lots, 268.5, '2026-07-18');
    assert.equal(r.lots.length, 2);

    const young = r.lots[0];
    assert.equal(young.ratePct, 25);
    assert.equal(young.gain, 10 * (268.5 - 100));
    assert.equal(young.tax, young.gain * 0.25);
    assert.equal(young.nextDropDate, '2029-01-10');
    assert.equal(young.nextRatePct, 20);

    const old = r.lots[1];
    assert.equal(old.ratePct, 0);
    assert.equal(old.tax, 0);
    assert.equal(old.nextDropDate, null);

    // A losing lot owes nothing.
    const losing = taxReport([{ date: '2025-01-01', qty: 10, unitCost: 500 }], 268.5, '2026-07-18');
    assert.equal(losing.lots[0].tax, 0);
    assert.ok(losing.lots[0].gain < 0);

    assert.equal(r.totalTax, young.tax);
    assert.equal(r.totalGain, young.gain + old.gain);
});

test('changePct is the daily move against previous close', () => {
    assert.equal(changePct(102, 100), 2);
    assert.equal(changePct(97.5, 100), -2.5);
    assert.equal(changePct(100, null), null);
    assert.equal(changePct(100, 0), null);
});

test('weekPos52 places the last price inside the 52-week range', () => {
    assert.equal(weekPos52(150, 100, 200), 0.5);
    assert.equal(weekPos52(100, 100, 200), 0);
    assert.equal(weekPos52(250, 100, 200), 1);
    assert.equal(weekPos52(120, 120, 120), 0.5);
});

// Alert rules mirror the server: above/below compare last price to a EUR
// threshold, move compares the absolute daily percent change; instrument_id
// null on a move rule means it watches the whole board.
test('evaluateAlerts matches above, below and move rules', () => {
    const quotes = [
        { instrument_id: 1, symbol: 'KRKG', last: 268.5, prevClose: 260 },
        { instrument_id: 2, symbol: 'SLOTR', last: 10.43, prevClose: 10.9 },
    ];
    const fired = evaluateAlerts([
        { id: 11, instrument_id: 1, kind: 'above', threshold: 265, active: 1 },
        { id: 12, instrument_id: 1, kind: 'below', threshold: 250, active: 1 },
        { id: 13, instrument_id: 2, kind: 'below', threshold: 10.5, active: 1 },
        { id: 14, instrument_id: null, kind: 'move', threshold: 3, active: 1 },
        { id: 15, instrument_id: 1, kind: 'above', threshold: 265, active: 0 },
    ], quotes);

    const byId = Object.fromEntries(fired.map((f) => [f.alert.id, f]));
    assert.ok(byId[11], 'above fires when last >= threshold');
    assert.equal(byId[12], undefined, 'below stays quiet above the floor');
    assert.ok(byId[13], 'below fires when last <= threshold');
    assert.ok(byId[14], 'global move fires for the SLOTR drop');
    assert.equal(byId[14].quote.symbol, 'SLOTR');
    assert.equal(byId[15], undefined, 'inactive rules never fire');
});

test('sparklinePath maps a series into an SVG polyline path', () => {
    const path = sparklinePath([1, 2, 3], 100, 30, 2);
    assert.ok(path.startsWith('M'));
    // Three points: one M plus two L segments.
    assert.equal(path.split('L').length, 3);
    // First point sits at the left padding, last at width minus padding.
    assert.ok(path.startsWith('M2,'));
    assert.ok(path.includes('L98,'));
});

test('sparklinePath handles flat and tiny series without dividing by zero', () => {
    assert.equal(sparklinePath([], 100, 30), '');
    assert.equal(sparklinePath([5], 100, 30), '');
    const flat = sparklinePath([7, 7, 7], 100, 30, 0);
    assert.ok(flat.includes(',15'), 'flat series runs along the vertical middle');
});

test('niceTicks spans the data with round numbers', () => {
    const ticks = niceTicks(102.4, 268.5, 5);
    assert.ok(ticks.length >= 3 && ticks.length <= 8);
    assert.ok(ticks[0] <= 102.4);
    assert.ok(ticks[ticks.length - 1] >= 268.5);
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
        assert.ok(Math.abs(ticks[i] - ticks[i - 1] - step) < 1e-9, 'even spacing');
    }
});

test('seriesToPath scales dates and values into the plot box', () => {
    const series = [
        { date: '2026-07-01', value: 10 },
        { date: '2026-07-02', value: 20 },
        { date: '2026-07-04', value: 10 },
    ];
    const path = seriesToPath(series, { width: 300, height: 100, min: 0, max: 20 });
    const points = path.slice(1).split('L').map((pair) => pair.split(',').map(Number));
    assert.equal(points.length, 3);
    assert.equal(points[0][0], 0);
    assert.equal(points[2][0], 300);
    // 2026-07-02 is a third of the 3-day span across the x axis.
    assert.ok(Math.abs(points[1][0] - 100) < 1e-6);
    assert.equal(points[0][1], 50);
    assert.equal(points[1][1], 0);
});

test('enrichHoldings joins holdings to quotes with value, P/L and weights', () => {
    const holdings = {
        1: { qty: 10, costBasis: 1000, avgCost: 100, realized: 0, dividends: 15, lots: [] },
        2: { qty: 100, costBasis: 1000, avgCost: 10, realized: 50, dividends: 0, lots: [] },
        3: { qty: 0, costBasis: 0, avgCost: null, realized: 120, dividends: 0, lots: [] },
    };
    const quotes = [
        { instrument_id: 1, symbol: 'KRKG', last: 150, prevClose: 140 },
        { instrument_id: 2, symbol: 'SLOTR', last: 10, prevClose: 10 },
    ];
    const rows = enrichHoldings(holdings, quotes);
    // Sold-out positions are excluded from the open list.
    assert.equal(rows.length, 2);
    const krk = rows.find((r) => r.symbol === 'KRKG');
    assert.equal(krk.value, 1500);
    assert.equal(krk.unrealized, 500);
    assert.equal(krk.dayChange, 100);
    assert.equal(krk.weightPct, 60);
    const totals = enrichHoldings.totals(rows);
    assert.equal(totals.value, 2500);
    assert.equal(totals.unrealized, 500);
    assert.equal(totals.dayChange, 100);
});

test('groupBySegment orders the board Prva kotacija, Standardna, ETF', () => {
    const groups = groupBySegment([
        { symbol: 'SLOTR', segment: 'E' },
        { symbol: 'KRKG', segment: 'A' },
        { symbol: 'CETG', segment: 'B' },
        { symbol: 'PETG', segment: 'A' },
    ]);
    assert.deepEqual(groups.map((g) => g.segment), ['A', 'B', 'E']);
    assert.equal(groups[0].label, 'Prva kotacija');
    assert.deepEqual(groups[0].instruments.map((i) => i.symbol), ['KRKG', 'PETG']);
    assert.equal(groups[2].label, 'ETF');
});

test('portfolioTimeline values holdings at each date with carried-forward closes', () => {
    const transactions = [
        { instrument_id: 1, side: 'buy', quantity: 10, price: 100, fees: 0, trade_date: '2026-07-02' },
        { instrument_id: 2, side: 'buy', quantity: 100, price: 10, fees: 10, trade_date: '2026-07-03' },
    ];
    const closes = {
        1: [
            { date: '2026-07-01', close: 99 },
            { date: '2026-07-02', close: 101 },
            { date: '2026-07-03', close: 103 },
            { date: '2026-07-06', close: 104 },
        ],
        2: [
            { date: '2026-07-03', close: 10.2 },
            // No 07-06 quote: the last known close carries forward.
        ],
    };
    const timeline = portfolioTimeline(transactions, closes);
    // Starts at the first transaction date, uses union of trading dates.
    assert.deepEqual(timeline.map((p) => p.date), ['2026-07-02', '2026-07-03', '2026-07-06']);
    assert.equal(timeline[0].value, 10 * 101);
    assert.equal(timeline[0].invested, 1000);
    assert.equal(timeline[1].value, 10 * 103 + 100 * 10.2);
    assert.equal(timeline[1].invested, 1000 + 1010);
    assert.equal(timeline[2].value, 10 * 104 + 100 * 10.2);
});

test('portfolioTimeline subtracts sale proceeds from invested cash', () => {
    const transactions = [
        { instrument_id: 1, side: 'buy', quantity: 10, price: 100, fees: 0, trade_date: '2026-07-02' },
        { instrument_id: 1, side: 'sell', quantity: 5, price: 110, fees: 5, trade_date: '2026-07-03' },
    ];
    const closes = { 1: [{ date: '2026-07-02', close: 100 }, { date: '2026-07-03', close: 110 }] };
    const timeline = portfolioTimeline(transactions, closes);
    assert.equal(timeline[1].value, 5 * 110);
    assert.equal(timeline[1].invested, 1000 - (5 * 110 - 5));
});

test('parseSlNum reads Slovenian decimal commas and thousands dots', () => {
    assert.equal(parseSlNum('12,5'), 12.5);
    assert.equal(parseSlNum('1.250,25'), 1250.25);
    assert.equal(parseSlNum('268.5'), 268.5); // a bare dot still means decimals
    assert.equal(parseSlNum('10'), 10);
    assert.equal(parseSlNum(''), null);
    assert.equal(parseSlNum('abc'), null);
    assert.equal(parseSlNum('-3,2'), -3.2);
});
