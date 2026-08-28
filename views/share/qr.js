// A byte-mode QR encoder written from scratch, so the share page can draw a
// code without loading anyone else's script. Versions 1 to 10 at any of the
// four error-correction levels, which covers every URL this site can produce
// with room left over (213 bytes at level M).
//
// DOM free on purpose: it returns a flat module grid and nothing else, so the
// same function is unit-tested by tests/share-qr.test.mjs (node --test tests/)
// and rendered to SVG by logic.js. Nothing here touches the page.
//
// The layout follows ISO/IEC 18004. Where a constant looks arbitrary it is
// from the standard: 0x11d is the field's primitive polynomial, 0x537 and
// 0x1f25 are the BCH generators for the format and version strings, and 0x5412
// is the format mask that stops an all-zero format from reading as blank.

//? ----------------------------------------------------------- GF(256) tables

export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);

{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    // The top half repeats the bottom so gfMul can add two logs without a
    // modulo; 254 + 254 is the largest sum it ever has to index.
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

export function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

//? --------------------------------------------------------- Reed-Solomon

// The generator polynomial for n error-correction codewords, as coefficients
// with the highest power first: the product of (x - a^i) for i in 0..n-1.
export function generatorPoly(degree) {
    let poly = Uint8Array.from([1]);
    for (let i = 0; i < degree; i++) {
        const next = new Uint8Array(poly.length + 1);
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j];
            next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
        }
        poly = next;
    }
    return poly;
}

// The remainder of data * x^ecCount divided by the generator, which is what
// the standard calls the error-correction codewords. Never mutates `data`.
export function rsEncode(data, ecCount) {
    const gen = generatorPoly(ecCount);
    const rem = new Uint8Array(ecCount);
    for (const byte of data) {
        const factor = byte ^ rem[0];
        rem.copyWithin(0, 1);
        rem[ecCount - 1] = 0;
        for (let i = 0; i < ecCount; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return rem;
}

//? ------------------------------------------------------------ version tables

// Total codewords (data plus error correction) per version. Every entry in
// ECC_BLOCKS below must reconcile with this, which is what the test suite
// checks rather than trusting the transcription.
export const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Per level and version: [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data].
export const ECC_BLOCKS = {
    L: [
        null,
        [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
        [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
        [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
    ],
    M: [
        null,
        [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
        [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
        [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
    ],
    Q: [
        null,
        [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
        [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
        [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
    ],
    H: [
        null,
        [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
        [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
        [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
    ],
};

export const MAX_VERSION = 10;

// Row and column centres of the alignment patterns. A pattern is drawn at
// every pairing of these except the three that would sit under a finder.
export const ALIGNMENT_CENTERS = [
    [], [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// Bits left over after the interleaved codewords, padded with zeros.
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function dataCodewords(version, ecc) {
    const [, g1, d1, g2, d2] = ECC_BLOCKS[ecc][version];
    return g1 * d1 + g2 * d2;
}

// Byte mode uses an 8-bit character count up to version 9 and 16 bits from
// version 10, which is why the capacity curve has a small step there.
function countBits(version) {
    return version < 10 ? 8 : 16;
}

export function byteCapacity(version, ecc = 'M') {
    const bits = dataCodewords(version, ecc) * 8 - 4 - countBits(version);
    return Math.floor(bits / 8);
}

export function pickVersion(byteLength, ecc = 'M') {
    for (let v = 1; v <= MAX_VERSION; v++) {
        if (byteLength <= byteCapacity(v, ecc)) return v;
    }
    return null;
}

//? ------------------------------------------------------- format and version

export function formatBits(ecc, mask) {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version) {
    if (version < 7) return null;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
}

//? ------------------------------------------------------------- bit assembly

function toBitStream(bytes, version, ecc) {
    const capacity = dataCodewords(version, ecc) * 8;
    const bits = [];
    const push = (value, length) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    push(0b0100, 4);                    // byte mode
    push(bytes.length, countBits(version));
    for (const b of bytes) push(b, 8);

    // Terminator, then zero-fill to a byte boundary, then the two alternating
    // pad codewords the standard specifies.
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const out = new Uint8Array(capacity / 8);
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        out[i / 8] = byte;
    }
    for (let i = bits.length / 8, pad = 0; i < out.length; i++, pad++) {
        out[i] = pad % 2 === 0 ? 0xec : 0x11;
    }
    return out;
}

// Split the data into the version's blocks, error-correct each one, then
// interleave: one codeword from every block in turn, data first then EC. A
// burst of damage is then spread across blocks instead of destroying one.
function interleave(data, version, ecc) {
    const [ecCount, g1, d1, g2, d2] = ECC_BLOCKS[ecc][version];
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < g1 + g2; i++) {
        const length = i < g1 ? d1 : d2;
        const chunk = data.subarray(offset, offset + length);
        offset += length;
        blocks.push({ data: chunk, ec: rsEncode(chunk, ecCount) });
    }

    const result = [];
    const longest = Math.max(d1, d2);
    for (let i = 0; i < longest; i++) {
        for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
    }
    for (let i = 0; i < ecCount; i++) {
        for (const block of blocks) result.push(block.ec[i]);
    }
    return Uint8Array.from(result);
}

//? ------------------------------------------------------------ matrix drawing

function drawFunctionPatterns(modules, reserved, size, version) {
    const set = (r, c, dark) => {
        if (r < 0 || c < 0 || r >= size || c >= size) return;
        modules[r * size + c] = dark ? 1 : 0;
        reserved[r * size + c] = 1;
    };

    // Finder patterns plus the light separator ring around each.
    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
                const ring = r === 0 || r === 6 || c === 0 || c === 6;
                const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                set(top + r, left + c, inside && (ring || core));
            }
        }
    }

    // Timing patterns, dark on even coordinates.
    for (let i = 8; i < size - 8; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }

    // Alignment patterns, skipping the three centres covered by a finder.
    const centers = ALIGNMENT_CENTERS[version];
    const last = centers.at(-1);
    for (const r of centers) {
        for (const c of centers) {
            if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    const edge = Math.max(Math.abs(dr), Math.abs(dc));
                    set(r + dr, c + dc, edge !== 1);
                }
            }
        }
    }

    // Reserve the format area now so data placement skips it; the bits
    // themselves are drawn per mask, after the data is laid down.
    for (let i = 0; i <= 8; i++) {
        if (i !== 6) { reserved[8 * size + i] = 1; reserved[i * size + 8] = 1; }
    }
    for (let i = 0; i < 8; i++) {
        reserved[8 * size + (size - 1 - i)] = 1;
        reserved[(size - 1 - i) * size + 8] = 1;
    }
    set(size - 8, 8, true); // the module that is always dark

    const vbits = versionBits(version);
    if (vbits !== null) {
        for (let i = 0; i < 18; i++) {
            const bit = (vbits >>> i) & 1;
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            set(a, b, bit);
            set(b, a, bit);
        }
    }
}

// Zig-zag up and down two-module-wide columns from the right edge, skipping
// the vertical timing column and every reserved module.
function placeData(modules, reserved, size, codewords) {
    let bit = 0;
    const total = codewords.length * 8;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5; // column 6 is the vertical timing pattern
        for (let step = 0; step < size; step++) {
            const row = upward ? size - 1 - step : step;
            for (let i = 0; i < 2; i++) {
                const col = right - i;
                if (reserved[row * size + col]) continue;
                let dark = 0;
                if (bit < total) {
                    dark = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
                    bit++;
                }
                modules[row * size + col] = dark;
            }
        }
        upward = !upward;
    }
}

const MASK_RULES = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// The 15 format bits are written twice, and each copy stays in one line: one
// runs the full height of column 8, the other the full width of row 8. Mixing
// the halves between the two produces a grid that still looks like a QR code
// and that no scanner can read, so the placement is spelled out bit by bit.
function drawFormat(modules, size, ecc, mask) {
    const bits = formatBits(ecc, mask);
    const bit = (i) => (bits >>> i) & 1;

    // Copy one, down column 8: rows 0 to 5, then 7 and 8 stepping over the
    // timing module at row 6, then the seven rows above the bottom-left finder.
    for (let i = 0; i < 15; i++) {
        const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
        modules[row * size + 8] = bit(i);
    }

    // Copy two, along row 8: the eight columns beside the top-right finder,
    // then column 7, then columns 5 back down to 0.
    for (let i = 0; i < 15; i++) {
        const col = i < 8 ? size - 1 - i : i === 8 ? 7 : 14 - i;
        modules[8 * size + col] = bit(i);
    }
}

//? --------------------------------------------------------------- mask scoring

// The four penalty rules from the standard. A lower score is a code that is
// easier for a scanner to lock onto: fewer long runs, fewer solid blocks, no
// shapes that could be mistaken for a finder, and a dark ratio near half.
export function maskPenalty(modules, size) {
    let score = 0;
    const at = (r, c) => modules[r * size + c];

    // Rule 1: runs of five or more in a row or column.
    for (let i = 0; i < size; i++) {
        for (const read of [(k) => at(i, k), (k) => at(k, i)]) {
            let run = 1;
            for (let k = 1; k < size; k++) {
                if (read(k) === read(k - 1)) {
                    run++;
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                }
            }
            if (run >= 5) score += 3 + (run - 5);
        }
    }

    // Rule 2: every 2x2 block of one colour.
    for (let r = 0; r < size - 1; r++) {
        for (let c = 0; c < size - 1; c++) {
            const v = at(r, c);
            if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
        }
    }

    // Rule 3: the finder-lookalike 1:1:3:1:1 with four light modules beside it.
    const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let i = 0; i < size; i++) {
        for (let k = 0; k + 11 <= size; k++) {
            let rowA = true, rowB = true, colA = true, colB = true;
            for (let j = 0; j < 11; j++) {
                const rv = at(i, k + j);
                const cv = at(k + j, i);
                if (rv !== A[j]) rowA = false;
                if (rv !== B[j]) rowB = false;
                if (cv !== A[j]) colA = false;
                if (cv !== B[j]) colB = false;
            }
            if (rowA) score += 40;
            if (rowB) score += 40;
            if (colA) score += 40;
            if (colB) score += 40;
        }
    }

    // Rule 4: how far the dark proportion strays from half.
    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i];
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
}

//? ------------------------------------------------------------------ the API

/**
 * Encode `text` as a QR symbol.
 * Returns { version, size, mask, modules } where `modules` is a flat
 * Uint8Array of size * size, 1 for a dark module. No quiet zone is included;
 * the renderer adds it.
 */
export function encodeQr(text, { ecc = 'M' } = {}) {
    if (!ECC_BLOCKS[ecc]) throw new Error(`unknown error-correction level "${ecc}"`);

    const bytes = new TextEncoder().encode(String(text ?? ''));
    const version = pickVersion(bytes.length, ecc);
    if (version === null) {
        throw new Error(
            `text too long for a version ${MAX_VERSION} code: ` +
            `${bytes.length} bytes, limit ${byteCapacity(MAX_VERSION, ecc)}`,
        );
    }

    const size = version * 4 + 17;
    const codewords = interleave(toBitStream(bytes, version, ecc), version, ecc);

    const base = new Uint8Array(size * size);
    const reserved = new Uint8Array(size * size);
    drawFunctionPatterns(base, reserved, size, version);
    placeData(base, reserved, size, codewords);

    // REMAINDER_BITS are already zero in `base`; placeData simply runs out of
    // codewords and leaves them light, which is what the standard asks for.
    void REMAINDER_BITS;

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const candidate = Uint8Array.from(base);
        const rule = MASK_RULES[mask];
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (!reserved[r * size + c] && rule(r, c)) {
                    candidate[r * size + c] ^= 1;
                }
            }
        }
        drawFormat(candidate, size, ecc, mask);
        const score = maskPenalty(candidate, size);
        if (best === null || score < best.score) best = { score, mask, modules: candidate };
    }

    return { version, size, mask: best.mask, modules: best.modules };
}
