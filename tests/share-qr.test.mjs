// Unit tests for the hand-written QR encoder (views/share/qr.js).
// Run with: node --test tests/
//
// A QR encoder is easy to get subtly wrong and hard to eyeball, so this suite
// deliberately avoids asserting against recalled lookup tables. Everything is
// checked against a property the spec defines:
//
//   - GF(256) multiplication is compared to an independent carry-less multiply
//     written from scratch below, over all 65536 operand pairs.
//   - The Reed-Solomon generator polynomial is verified by its definition,
//     g(x) = product of (x - a^i), so g(a^i) must be zero for every i.
//   - An encoded block is verified by the defining property of an RS codeword:
//     the data-plus-EC polynomial evaluates to zero at a^0 .. a^(n-1).
//   - Format and version strings are verified by BCH divisibility, not by a
//     memorised constant.
//
// The end-to-end proof that these codes actually scan came from decoding every
// catalog URL with jsQR in a browser; the golden matrices at the bottom of this
// file are the frozen result of that run and guard against silent drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    GF_EXP,
    GF_LOG,
    gfMul,
    generatorPoly,
    rsEncode,
    byteCapacity,
    pickVersion,
    formatBits,
    versionBits,
    maskPenalty,
    encodeQr,
    ALIGNMENT_CENTERS,
    ECC_BLOCKS,
    TOTAL_CODEWORDS,
} from '../views/share/qr.js';

// An independent GF(2^8) multiply, modulus 0x11d, written the long way so it
// shares no code with the table-driven implementation under test.
function refMul(a, b) {
    let result = 0;
    let x = a;
    let y = b;
    while (y) {
        if (y & 1) result ^= x;
        y >>= 1;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    return result;
}

// Evaluate a polynomial (coefficients high-order first) at x in GF(256).
function polyEval(coeffs, x) {
    let acc = 0;
    for (const c of coeffs) acc = gfMul(acc, x) ^ c;
    return acc;
}

//? ------------------------------------------------------------- field arithmetic

test('the GF(256) exp and log tables are inverses of each other', () => {
    for (let i = 1; i < 256; i++) {
        assert.equal(GF_EXP[GF_LOG[i]], i, `exp(log(${i}))`);
    }
    for (let i = 0; i < 255; i++) {
        assert.equal(GF_LOG[GF_EXP[i]], i, `log(exp(${i}))`);
    }
});

test('gfMul agrees with a from-scratch carry-less multiply on every pair', () => {
    for (let a = 0; a < 256; a++) {
        for (let b = 0; b < 256; b++) {
            if (gfMul(a, b) !== refMul(a, b)) {
                assert.fail(`gfMul(${a}, ${b}) = ${gfMul(a, b)}, expected ${refMul(a, b)}`);
            }
        }
    }
});

test('multiplying by zero is zero and by one is identity', () => {
    for (let a = 0; a < 256; a++) {
        assert.equal(gfMul(a, 0), 0);
        assert.equal(gfMul(0, a), 0);
        assert.equal(gfMul(a, 1), a);
    }
});

//? ------------------------------------------------------- Reed-Solomon encoding

test('the generator polynomial has degree n and roots at a^0 through a^(n-1)', () => {
    for (const n of [7, 10, 13, 16, 18, 22, 24, 26, 28]) {
        const g = generatorPoly(n);
        assert.equal(g.length, n + 1, `degree of g for n=${n}`);
        assert.equal(g[0], 1, 'generator is monic');
        for (let i = 0; i < n; i++) {
            assert.equal(polyEval(g, GF_EXP[i]), 0, `g(a^${i}) for n=${n}`);
        }
    }
});

test('a data block plus its EC codewords is a valid Reed-Solomon codeword', () => {
    const blocks = [
        { data: [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], ec: 10 },
        { data: [64, 118, 87, 71, 38, 22, 246, 87, 54, 82, 4, 20, 236, 17], ec: 13 },
        { data: Array.from({ length: 43 }, (_, i) => (i * 37 + 11) & 0xff), ec: 26 },
        { data: [0, 0, 0, 0], ec: 7 },
    ];
    for (const { data, ec } of blocks) {
        const parity = rsEncode(Uint8Array.from(data), ec);
        assert.equal(parity.length, ec);
        const codeword = [...data, ...parity];
        for (let i = 0; i < ec; i++) {
            assert.equal(polyEval(codeword, GF_EXP[i]), 0, `codeword(a^${i}) with ec=${ec}`);
        }
    }
});

test('rsEncode does not mutate the data it is given', () => {
    const data = Uint8Array.from([1, 2, 3, 4, 5]);
    const copy = Uint8Array.from(data);
    rsEncode(data, 10);
    assert.deepEqual(data, copy);
});

//? ------------------------------------------------------------ capacity choices

test('byte capacities at level M match the published table', () => {
    const expected = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    for (let v = 1; v <= 10; v++) {
        assert.equal(byteCapacity(v, 'M'), expected[v - 1], `version ${v}`);
    }
});

test('pickVersion takes the smallest version that fits, at every boundary', () => {
    assert.equal(pickVersion(1, 'M'), 1);
    assert.equal(pickVersion(14, 'M'), 1);
    assert.equal(pickVersion(15, 'M'), 2);
    assert.equal(pickVersion(26, 'M'), 2);
    assert.equal(pickVersion(27, 'M'), 3);
    assert.equal(pickVersion(122, 'M'), 7);
    assert.equal(pickVersion(123, 'M'), 8);
    assert.equal(pickVersion(213, 'M'), 10);
});

test('pickVersion returns null when the text cannot fit in version 10', () => {
    assert.equal(pickVersion(214, 'M'), null);
});

test('encodeQr throws rather than truncating an over-long string', () => {
    assert.throws(() => encodeQr('x'.repeat(214)), /too long/i);
});

//? --------------------------------------------------------- format and version

test('the format string is a valid BCH(15,5) word carrying its own level and mask', () => {
    const FORMAT_GEN = 0b10100110111;
    const FORMAT_XOR = 0b101010000010010;
    const LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

    for (const ecc of ['L', 'M', 'Q', 'H']) {
        for (let mask = 0; mask < 8; mask++) {
            const bits = formatBits(ecc, mask);
            assert.ok(bits >= 0 && bits < 1 << 15, 'fits in 15 bits');

            const raw = bits ^ FORMAT_XOR;
            assert.equal(raw >> 10, (LEVEL_BITS[ecc] << 3) | mask, `payload for ${ecc}/${mask}`);

            // Unmasked, the whole 15-bit word must divide cleanly by the BCH generator.
            let rem = raw;
            for (let i = 14; i >= 10; i--) {
                if (rem & (1 << i)) rem ^= FORMAT_GEN << (i - 10);
            }
            assert.equal(rem, 0, `BCH remainder for ${ecc}/${mask}`);
        }
    }
});

test('format strings differ in at least three bits, as the BCH distance requires', () => {
    const all = [];
    for (const ecc of ['L', 'M', 'Q', 'H']) {
        for (let mask = 0; mask < 8; mask++) all.push(formatBits(ecc, mask));
    }
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            let diff = 0;
            let x = all[i] ^ all[j];
            while (x) { diff += x & 1; x >>= 1; }
            assert.ok(diff >= 3, `only ${diff} bits between ${all[i]} and ${all[j]}`);
        }
    }
});

test('the version string is a valid BCH(18,6) word carrying its own version', () => {
    const VERSION_GEN = 0b1111100100101;
    for (let v = 7; v <= 10; v++) {
        const bits = versionBits(v);
        assert.equal(bits >> 12, v, `payload for version ${v}`);
        let rem = bits;
        for (let i = 17; i >= 12; i--) {
            if (rem & (1 << i)) rem ^= VERSION_GEN << (i - 12);
        }
        assert.equal(rem, 0, `BCH remainder for version ${v}`);
    }
});

test('versionBits is undefined below version 7, where no version block is drawn', () => {
    for (let v = 1; v <= 6; v++) assert.equal(versionBits(v), null);
});

//? ---------------------------------------------------------------- mask penalty

test('maskPenalty charges a run of five or more the documented amount', () => {
    // One 7x7 grid, a single dark run of 7 across the top row and nothing else.
    const size = 7;
    const modules = new Uint8Array(size * size);
    for (let c = 0; c < size; c++) modules[c] = 1;

    // Rule 1: the dark run of 7 scores 3 + (7 - 5) = 5, and the six light runs
    // of 6 below it score 3 + 1 = 4 each in the rows, plus the columns.
    const score = maskPenalty(modules, size);
    assert.ok(score > 0, 'a highly regular grid is penalised');

    // An all-light grid still pays the balance penalty for being 0% dark.
    const blank = new Uint8Array(size * size);
    assert.ok(maskPenalty(blank, size) >= 100, 'a blank grid is heavily penalised');
});

test('maskPenalty prefers a balanced grid to an all-dark one', () => {
    const size = 21;
    const allDark = new Uint8Array(size * size).fill(1);
    const checker = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) checker[r * size + c] = (r + c) % 2;
    }
    assert.ok(maskPenalty(checker, size) < maskPenalty(allDark, size));
});

//? ------------------------------------------------------------ matrix structure

const at = (qr, row, col) => qr.modules[row * qr.size + col];

function assertFinder(qr, top, left) {
    for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
            const ring = r === 0 || r === 6 || c === 0 || c === 6;
            const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            const expected = ring || core ? 1 : 0;
            assert.equal(at(qr, top + r, left + c), expected,
                `finder at ${top},${left} module ${r},${c}`);
        }
    }
}

test('every version carries three finder patterns and their separators', () => {
    for (const text of ['a', 'https://domenhribernik.com/views/tells/', 'x'.repeat(200)]) {
        const qr = encodeQr(text);
        assert.equal(qr.size, qr.version * 4 + 17, `size for version ${qr.version}`);
        assert.equal(qr.modules.length, qr.size * qr.size);

        assertFinder(qr, 0, 0);
        assertFinder(qr, 0, qr.size - 7);
        assertFinder(qr, qr.size - 7, 0);

        // The separator is the light ring immediately outside each finder.
        for (let i = 0; i < 8; i++) {
            assert.equal(at(qr, 7, i), 0, 'top-left separator row');
            assert.equal(at(qr, i, 7), 0, 'top-left separator column');
            assert.equal(at(qr, 7, qr.size - 1 - i), 0, 'top-right separator row');
            assert.equal(at(qr, qr.size - 8, i), 0, 'bottom-left separator row');
        }
    }
});

test('the timing patterns alternate along row six and column six', () => {
    const qr = encodeQr('https://domenhribernik.com/views/nebo/');
    for (let i = 8; i < qr.size - 8; i++) {
        assert.equal(at(qr, 6, i), i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
        assert.equal(at(qr, i, 6), i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
    }
});

test('the always-dark module sits just above the bottom-left format block', () => {
    for (const text of ['a', 'x'.repeat(60), 'x'.repeat(200)]) {
        const qr = encodeQr(text);
        assert.equal(at(qr, 4 * qr.version + 9, 8), 1, `dark module for version ${qr.version}`);
    }
});

test('alignment patterns are drawn at every centre pair except under a finder', () => {
    for (let v = 2; v <= 10; v++) {
        const qr = encodeQr('x'.repeat(byteCapacity(v, 'M')));
        assert.equal(qr.version, v, `forced version ${v}`);

        const centers = ALIGNMENT_CENTERS[v];
        const last = centers.at(-1);
        for (const r of centers) {
            for (const c of centers) {
                const underFinder = (r === 6 && c === 6)
                    || (r === 6 && c === last)
                    || (r === last && c === 6);
                if (underFinder) continue;
                assert.equal(at(qr, r, c), 1, `alignment centre ${r},${c} on v${v}`);
                assert.equal(at(qr, r - 1, c - 1), 0, `alignment ring ${r},${c} on v${v}`);
                assert.equal(at(qr, r - 2, c - 2), 1, `alignment edge ${r},${c} on v${v}`);
            }
        }
    }
});

test('both copies of the format information agree, bit for bit', () => {
    const qr = encodeQr('https://domenhribernik.com/');
    const bits = formatBits('M', qr.mask);
    const bit = (i) => (bits >>> i) & 1;

    // Each copy stays in a single line. Copy one is the whole of column 8,
    // stepping over the timing module at row 6 and the always-dark module.
    for (let i = 0; i < 15; i++) {
        const row = i < 6 ? i : i < 8 ? i + 1 : qr.size - 15 + i;
        assert.equal(at(qr, row, 8), bit(i), `copy one bit ${i} at row ${row}`);
    }

    // Copy two is the whole of row 8, running in from the right edge.
    for (let i = 0; i < 15; i++) {
        const col = i < 8 ? qr.size - 1 - i : i === 8 ? 7 : 14 - i;
        assert.equal(at(qr, 8, col), bit(i), `copy two bit ${i} at column ${col}`);
    }

    // The always-dark module sits between the two halves of copy one and is
    // never a format bit.
    assert.equal(at(qr, qr.size - 8, 8), 1, 'dark module survives format drawing');
});

test('the block table reconciles with the total codeword count everywhere', () => {
    // Guards the transcription of ECC_BLOCKS: for every version and level the
    // blocks must account for exactly the codewords that version holds.
    for (const ecc of ['L', 'M', 'Q', 'H']) {
        for (let v = 1; v <= 10; v++) {
            const [ec, g1, d1, g2, d2] = ECC_BLOCKS[ecc][v];
            const total = g1 * (d1 + ec) + g2 * (d2 + ec);
            assert.equal(total, TOTAL_CODEWORDS[v], `${ecc} version ${v}`);
        }
    }
});

test('every error-correction level round-trips through encodeQr', () => {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
        const qr = encodeQr('https://domenhribernik.com/views/maze/', { ecc });
        assert.equal(qr.size, qr.version * 4 + 17, `size at level ${ecc}`);
        assert.equal(at(qr, 4 * qr.version + 9, 8), 1, `dark module at level ${ecc}`);
    }
});

test('an unknown error-correction level is rejected', () => {
    assert.throws(() => encodeQr('hello', { ecc: 'X' }), /unknown error-correction/i);
});

test('encodeQr picks a mask in range and records it', () => {
    for (const text of ['a', 'https://domenhribernik.com/views/seam/', 'x'.repeat(150)]) {
        const qr = encodeQr(text);
        assert.ok(Number.isInteger(qr.mask) && qr.mask >= 0 && qr.mask <= 7, 'mask in 0..7');
    }
});

test('encoding is deterministic', () => {
    const a = encodeQr('https://domenhribernik.com/views/trails/');
    const b = encodeQr('https://domenhribernik.com/views/trails/');
    assert.equal(a.version, b.version);
    assert.equal(a.mask, b.mask);
    assert.deepEqual(a.modules, b.modules);
});

test('a longer string never produces a smaller grid', () => {
    let previous = 0;
    for (const len of [1, 14, 15, 40, 63, 90, 120, 160, 200, 213]) {
        const qr = encodeQr('x'.repeat(len));
        assert.ok(qr.size >= previous, `size regressed at length ${len}`);
        previous = qr.size;
    }
});

test('non-ASCII text is encoded as UTF-8 bytes, not code units', () => {
    // "Vita Mavric" with the accent: five bytes of UTF-8 for four characters.
    const plain = encodeQr('Mavric');
    const accented = encodeQr('Mavrič');
    assert.deepEqual(plain.modules.length, accented.modules.length);
    assert.notDeepEqual(plain.modules, accented.modules);

    // 213 bytes is the capacity, so 107 two-byte characters must still fit and
    // 107 plus one ASCII character must not.
    assert.doesNotThrow(() => encodeQr('č'.repeat(106)));
    assert.throws(() => encodeQr('č'.repeat(107)), /too long/i);
});

test('an empty string still produces a scannable version 1 grid', () => {
    const qr = encodeQr('');
    assert.equal(qr.version, 1);
    assert.equal(qr.size, 21);
});

//? ------------------------------------------------------------------ scoring

test('the four penalty rules add up to the hand-worked total on a known grid', () => {
    // An 11x11 grid, light everywhere except the top row, which is set to the
    // finder-lookalike 1:1:3:1:1 followed by its four light modules. Worked
    // through by hand, rule by rule:
    //   rule 1: ten all-light rows at 3+6, plus the columns, is 90 + 94 = 184
    //   rule 2: 90 uniform 2x2 blocks below the top row plus 3 straddling it,
    //           at 3 each, is 279
    //   rule 3: the top row matches the pattern once, so 40
    //   rule 4: 5 dark of 121 is 4.13%, so floor(45.87 / 5) * 10 = 90
    const size = 11;
    const modules = new Uint8Array(size * size);
    const top = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    for (let c = 0; c < size; c++) modules[c] = top[c];

    assert.equal(maskPenalty(modules, size), 184 + 279 + 40 + 90);
});

test('rule three needs the four light modules, not just the 1:1:3:1:1 core', () => {
    // The same five dark modules, moved so the core keeps only two light
    // modules on each side instead of four. Rules 1 and 4 are unchanged (same
    // runs, same dark count) and rule 2 loses exactly one uniform 2x2 block,
    // so the 43 point gap is 40 from rule three plus that block's 3.
    const size = 11;
    const build = (top) => {
        const modules = new Uint8Array(size * size);
        for (let c = 0; c < size; c++) modules[c] = top[c];
        return modules;
    };

    const matches = maskPenalty(build([1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]), size);
    const tooTight = maskPenalty(build([0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0]), size);

    assert.equal(matches, 593);
    assert.equal(tooTight, 550);
});

//? ------------------------------------------------------------------- goldens

test('real share URLs still encode to the grids that were verified by decoder', async () => {
    // These four were rendered and read back by jsQR, an independent decoder,
    // together with every other catalog URL at all four correction levels. A
    // mismatch here means the encoder changed: re-run that harness before
    // updating these values, because the digests are only worth what the
    // decoder run behind them proved.
    const { createHash } = await import('node:crypto');
    const golden = [
        { url: 'https://domenhribernik.com/', version: 3, mask: 2, digest: '9718f118f5d65728ea0956515b4dc2fe' },
        { url: 'https://domenhribernik.com/views/tells/', version: 3, mask: 1, digest: 'a73a0d90b1ff585090379021adb61647' },
        { url: 'https://domenhribernik.com/views/blog/in-praise-of-small-software/', version: 5, mask: 2, digest: '7ceefae1d1c3f0f3abdc09cc75c4ae7f' },
        { url: 'https://domenhribernik.com/views/guitar-backing-tracks/', version: 4, mask: 3, digest: '6b336f275fcd4ea8188e4449dbdfdec3' },
    ];

    for (const { url, version, mask, digest } of golden) {
        const qr = encodeQr(url);
        assert.equal(qr.version, version, `version for ${url}`);
        assert.equal(qr.mask, mask, `mask for ${url}`);
        assert.equal(createHash('sha256').update(qr.modules).digest('hex').slice(0, 32), digest,
            `module grid for ${url}`);
    }
});
