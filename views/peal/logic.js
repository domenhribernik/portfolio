// DOM-free ringing engine for the Peal tower (views/peal), unit-tested by
// tests/peal-logic.test.mjs (node --test tests/). The page's script.js imports
// this as an ES module.
//
// Everything a bell tower does is in here: parsing place notation into changes,
// grinding a method out into rows, reading one bell's path for the blue line,
// tuning a ring to a major scale, deriving a bell's partials, and laying rows
// out on a clock so a striking error can be measured in milliseconds.

//? ---------------------------------------------------------------------------
//? Bell symbols
//?
//? Place notation numbers positions 1..n. Past 9 the sport runs out of digits
//? and switches to letters, in this order, which is the Central Council's.
//? ---------------------------------------------------------------------------

const SYMBOLS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'E', 'T', 'A', 'B', 'C', 'D'];

// Position number (1-based) for a place notation character, or 0 if it is not one.
export function symbolToPlace(ch) {
    const i = SYMBOLS.indexOf(String(ch).toUpperCase());
    return i < 0 ? 0 : i + 1;
}

// The character a bell or place is printed as. Bell 10 prints as 0, 11 as E.
export function placeToSymbol(place) {
    return SYMBOLS[place - 1] || '?';
}

// A whole row printed the way a ringer writes it: 135264.
export function rowToString(row) {
    return row.map(placeToSymbol).join('');
}

// Rounds on n bells: the row every method leaves and must return to.
export function rounds(stage) {
    return Array.from({ length: stage }, (_, i) => i + 1);
}

//? ---------------------------------------------------------------------------
//? Place notation
//?
//? A change is the set of positions that stand still; everything else swaps
//? with its neighbour in pairs. "x" (or "-") is the change where nothing
//? stands, which only exists on an even stage.
//? ---------------------------------------------------------------------------

// Split a notation block into raw change tokens. Digits run together into one
// change ("16" is places 1 and 6), while x and . both end the current token.
export function tokenizeBlock(block) {
    const tokens = [];
    let current = '';
    const flush = () => { if (current) { tokens.push(current); current = ''; } };

    for (const ch of String(block)) {
        if (ch === 'x' || ch === 'X' || ch === '-') { flush(); tokens.push('x'); continue; }
        if (ch === '.' || ch === ' ') { flush(); continue; }
        if (symbolToPlace(ch) === 0) throw new Error(`"${ch}" is not a place`);
        current += ch;
    }
    flush();
    return tokens;
}

// Places a token asks for, before implicit places are worked out. "x" asks for
// none. Duplicates and out-of-order digits are tolerated and normalised.
function tokenPlaces(token, stage) {
    if (token === 'x') return [];
    const places = [...new Set(
        [...token].map((ch) => {
            const p = symbolToPlace(ch);
            if (p === 0 || p > stage) throw new Error(`place ${ch} does not exist on ${stage} bells`);
            return p;
        })
    )].sort((a, b) => a - b);
    return places;
}

// Add the places the notation left implicit and check the change is possible.
//
// Ringers write "3" on six and mean places 3 and 6: position 6 is stranded on
// its own at the back, so it must be making a place. The rule is that an odd
// run of positions before the first place or after the last one gets an
// implicit place at that end. A gap of odd length in the middle is not
// implicit, it is a typo, and this throws.
export function resolvePlaces(places, stage) {
    const stay = [...new Set(places)].sort((a, b) => a - b);

    if (stay.length === 0) {
        if (stage % 2 === 1) throw new Error(`a cross needs an even stage, not ${stage}`);
        return [];
    }
    if ((stay[0] - 1) % 2 === 1) stay.unshift(1);
    if ((stage - stay[stay.length - 1]) % 2 === 1) stay.push(stage);

    for (let i = 1; i < stay.length; i++) {
        const gap = stay[i] - stay[i - 1] - 1;
        if (gap % 2 === 1) {
            throw new Error(`${gap} bell${gap === 1 ? '' : 's'} cannot pair between places ${stay[i - 1]} and ${stay[i]}`);
        }
    }
    return stay;
}

// Expand a block, honouring a leading "&" which means the block is a palindrome:
// the written changes, then the same changes back again without repeating the
// last one. "&x16x16x16" is eleven changes, not six.
function expandBlock(block, stage) {
    const body = block.replace(/^[&+]/, '');
    const tokens = tokenizeBlock(body);
    if (tokens.length === 0) throw new Error('empty block');

    const changes = tokens.map((t) => resolvePlaces(tokenPlaces(t, stage), stage));
    if (!block.startsWith('&')) return changes;
    return changes.concat(changes.slice(0, -1).reverse());
}

// Every change in one lead of a method, in order. Blocks are separated by
// commas: "&x16x16x16,12" is the palindromic body plus the lead end change.
export function expandNotation(notation, stage) {
    const text = String(notation).trim();
    if (!text) throw new Error('no place notation');
    const blocks = text.split(',').map((b) => b.trim()).filter(Boolean);
    if (blocks.length === 0) throw new Error('no place notation');
    return blocks.flatMap((b) => expandBlock(b, stage));
}

// Apply one change to a row. Positions in `places` hold; the rest swap in pairs.
export function applyChange(row, places) {
    const n = row.length;
    const stay = new Set(places);
    const out = row.slice();
    let i = 0;
    while (i < n) {
        if (stay.has(i + 1)) { i += 1; continue; }
        if (i + 1 >= n || stay.has(i + 2)) throw new Error(`bell in position ${i + 1} has nothing to swap with`);
        out[i] = row[i + 1];
        out[i + 1] = row[i];
        i += 2;
    }
    return out;
}

//? ---------------------------------------------------------------------------
//? Grinding a method out
//? ---------------------------------------------------------------------------

const MAX_ROWS = 20000;

// Ring a method from rounds until it comes back to rounds. Returns every row
// including the opening rounds and the closing rounds, so a plain course of
// Plain Bob Minor is 61 rows: 60 changes plus the row you started on.
export function plainCourse(notation, stage) {
    const changes = expandNotation(notation, stage);
    const start = rounds(stage);
    const rows = [start];
    let row = start;

    for (let i = 0; i < MAX_ROWS; i++) {
        row = applyChange(row, changes[i % changes.length]);
        rows.push(row);
        const atRounds = row.every((b, j) => b === j + 1);
        // A course can only end at a lead end, never mid-lead.
        if (atRounds && (i + 1) % changes.length === 0) {
            return { rows, changes, leadLength: changes.length, leads: (i + 1) / changes.length, courseLength: i + 1 };
        }
    }
    throw new Error(`that notation does not come home inside ${MAX_ROWS} rows`);
}

// The positions one bell occupies, row by row. This is the blue line: index i
// is that bell's place (1-based) in row i.
export function bellPath(rows, bell) {
    return rows.map((row) => row.indexOf(bell) + 1);
}

// True when no row repeats before the course closes. An untrue method cannot be
// rung for a peal, and it is the first thing to check on notation somebody typed.
export function isTrue(rows) {
    const seen = new Set();
    for (let i = 0; i < rows.length - 1; i++) {
        const key = rowToString(rows[i]);
        if (seen.has(key)) return false;
        seen.add(key);
    }
    return true;
}

// How a bell behaves over one lead, named the way ringers name it. Plain hunt
// walks straight out to the back and straight home; a treble bob hunt goes out
// in dodges. Anything else is a working bell.
export function huntKind(path, stage, leadLength) {
    const lead = path.slice(0, leadLength + 1);
    if (lead[0] !== 1 || lead[lead.length - 1] !== 1) return 'working';

    if (leadLength === 2 * stage) {
        const plain = [];
        for (let p = 1; p <= stage; p++) plain.push(p);
        for (let p = stage; p >= 1; p--) plain.push(p);
        plain.push(1);
        if (lead.every((p, i) => p === plain[i])) return 'plain hunt';
    }
    if (leadLength === 4 * stage) {
        const bob = [];
        for (let p = 1; p <= stage; p += 2) bob.push(p, p + 1, p, p + 1);
        for (let p = stage; p >= 1; p -= 2) bob.push(p, p - 1, p, p - 1);
        bob.push(1);
        if (lead.length === bob.length && lead.every((p, i) => p === bob[i])) return 'treble bob hunt';
    }
    return 'working';
}

// Everything the page needs to know about a method, worked out from its
// notation rather than stored beside it. Throws on notation that cannot ring.
export function analyseMethod(notation, stage) {
    const course = plainCourse(notation, stage);
    const { rows, leadLength, leads } = course;
    const treblePath = bellPath(rows, 1);
    return {
        ...course,
        stage,
        notation: String(notation).trim(),
        treble: huntKind(treblePath, stage, leadLength),
        true: isTrue(rows),
        leadHeads: Array.from({ length: leads }, (_, i) => rows[i * leadLength])
    };
}

//? ---------------------------------------------------------------------------
//? Tuning a ring
//?
//? A ring of bells is a descending major scale with the tenor at the bottom, so
//? the treble is the highest bell and the one that gets rung first in rounds.
//? A ring of six is the bottom six notes of that scale, not the top six.
//? ---------------------------------------------------------------------------

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19];

// Semitones above the tenor for a given bell. Bell n is the tenor at 0.
export function bellSemitones(bell, stage) {
    const degree = stage - bell;
    return MAJOR_STEPS[degree] ?? MAJOR_STEPS[MAJOR_STEPS.length - 1];
}

// A bell's strike note in hertz, given the tenor's.
export function bellHz(bell, stage, tenorHz) {
    return tenorHz * Math.pow(2, bellSemitones(bell, stage) / 12);
}

//? A bell is not a string. It rings a fixed set of partials that are not
//? whole-number multiples of anything, and the note you think you hear, the
//? strike note, is not even the loudest of them. These are the five partials a
//? tuner cuts on a lathe, plus the two above them that give the clang.
export const PARTIALS = [
    { name: 'hum', ratio: 0.5, gain: 0.42, seconds: 11.0 },
    { name: 'prime', ratio: 1.0, gain: 0.55, seconds: 6.0 },
    { name: 'tierce', ratio: 1.2, gain: 0.50, seconds: 4.2 },
    { name: 'quint', ratio: 1.5, gain: 0.28, seconds: 2.6 },
    { name: 'nominal', ratio: 2.0, gain: 1.00, seconds: 5.0 },
    { name: 'superquint', ratio: 3.0, gain: 0.22, seconds: 1.3 },
    { name: 'octave nominal', ratio: 4.0, gain: 0.16, seconds: 0.9 }
];

// The partials of one bell, in hertz, with how loud each starts and how long it
// takes to die away. Big bells ring longer than small ones, so the decay is
// stretched for a low strike note and squeezed for a high one.
export function bellPartials(strikeHz) {
    const size = Math.pow(320 / strikeHz, 0.45);
    return PARTIALS.map((p) => ({
        name: p.name,
        hz: strikeHz * p.ratio,
        gain: p.gain,
        seconds: p.seconds * size
    }));
}

//? ---------------------------------------------------------------------------
//? Putting rows on a clock
//?
//? Bells strike one after another with an even gap between them. Every other
//? row is a handstroke, and English ringing leaves an extra gap of one bell's
//? width before it: the open handstroke lead. It is what makes ringing sound
//? like ringing rather than like a scale.
//? ---------------------------------------------------------------------------

// Bell-widths of silence and sound before row `index` begins.
export function rowOffsetUnits(index, stage) {
    return index * stage + Math.floor(index / 2);
}

// When every bell in the course strikes, in milliseconds from the first blow.
// Each entry knows its row, its place in that row, which bell it is, and
// whether it is a handstroke, because a ringer counts by strokes.
export function schedule(rows, stage, gapMs) {
    const blows = [];
    for (let r = 0; r < rows.length; r++) {
        const base = rowOffsetUnits(r, stage);
        for (let p = 1; p <= stage; p++) {
            blows.push({
                row: r,
                place: p,
                bell: rows[r][p - 1],
                stroke: r % 2 === 0 ? 'hand' : 'back',
                at: (base + p - 1) * gapMs
            });
        }
    }
    return blows;
}

// Just the blows one bell owns, which is the line a ringer is actually pulling.
export function blowsForBell(blows, bell) {
    return blows.filter((b) => b.bell === bell);
}

//? Striking is judged on how close each blow lands to where it belonged. These
//? bands are in milliseconds and are deliberately generous at the bottom: a gap
//? between bells is around 300ms, so being 110ms out is a quarter of a place
//? and is audible to anyone standing underneath.
export const BANDS = [
    { name: 'true', limit: 25 },
    { name: 'close', limit: 60 },
    { name: 'loose', limit: 110 },
    { name: 'out', limit: Infinity }
];

// The band one error in milliseconds falls into.
export function bandFor(errorMs) {
    const e = Math.abs(errorMs);
    return (BANDS.find((b) => e < b.limit) || BANDS[BANDS.length - 1]).name;
}

// Score a course of striking. `strikes` is one entry per blow the ringer owed,
// each either a number of milliseconds early (negative) or late (positive), or
// null for a blow they never struck at all.
//
// Reported two ways on purpose. `rms` is how accurate the striking was against
// where the blows belonged. `drift` is the average signed error, which is a
// different fault: a ringer who is 60ms late on every single blow is ringing
// perfectly evenly, just behind the band, and telling them so is more use than
// a bad score.
export function scoreCourse(strikes) {
    const struck = strikes.filter((e) => typeof e === 'number');
    const missed = strikes.length - struck.length;
    if (struck.length === 0) {
        return { blows: strikes.length, struck: 0, missed, rms: null, drift: null, spread: null, bands: emptyBands(), accuracy: 0 };
    }

    const drift = struck.reduce((a, e) => a + e, 0) / struck.length;
    const rms = Math.sqrt(struck.reduce((a, e) => a + e * e, 0) / struck.length);
    const spread = Math.sqrt(struck.reduce((a, e) => a + (e - drift) ** 2, 0) / struck.length);

    const bands = emptyBands();
    for (const e of struck) bands[bandFor(e)] += 1;
    bands.missed = missed;

    // One number for the scorecard: the share of blows that landed inside the
    // "close" band, with a missed blow counting against you like a bad one.
    const good = bands.true + bands.close;
    return {
        blows: strikes.length,
        struck: struck.length,
        missed,
        rms,
        drift,
        spread,
        bands,
        accuracy: strikes.length === 0 ? 0 : good / strikes.length
    };
}

function emptyBands() {
    return { true: 0, close: 0, loose: 0, out: 0, missed: 0 };
}

// Match a keypress to the blow it was aiming at: the ringer's own blow whose
// ideal time is nearest, but only if it is within `windowMs`. Returns the index
// into `owed`, or -1 when the press was nowhere near anything.
export function matchStrike(owed, atMs, windowMs) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < owed.length; i++) {
        const gap = Math.abs(owed[i].at - atMs);
        if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return bestGap <= windowMs ? best : -1;
}

//? ---------------------------------------------------------------------------
//? Naming things
//? ---------------------------------------------------------------------------

const ORDINALS = ['', 'treble', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

// What ringers call a bell. The smallest is the treble and the largest the
// tenor; everything between is just its number.
export function bellName(bell, stage) {
    if (bell === 1) return 'treble';
    if (bell === stage) return 'tenor';
    return ORDINALS[bell] || `${bell}th`;
}

// The word for a number of bells: doubles is five, minor is six, and so on.
const STAGE_NAMES = { 4: 'minimus', 5: 'doubles', 6: 'minor', 7: 'triples', 8: 'major', 9: 'caters', 10: 'royal', 11: 'cinques', 12: 'maximus' };

export function stageName(stage) {
    return STAGE_NAMES[stage] || `${stage} bells`;
}

// Which bell follows which in this row, which is how a ringer actually rings:
// you do not count places, you watch the bell in front of you. Returns the bell
// that strikes immediately before `bell`, or null when it leads.
export function bellBefore(row, bell) {
    const i = row.indexOf(bell);
    return i <= 0 ? null : row[i - 1];
}
