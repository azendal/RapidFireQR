// qr.js - small QR Code encoder (model 2, versions 1-40) with alphanumeric and byte modes.
// Returns the module matrix so the app can draw it however it likes (and, later, recolor
// data modules while keeping finders, timing, alignment and format info intact).

const ECC = {
    L: { ord: 0, formatBits: 1 },
    M: { ord: 1, formatBits: 0 },
    Q: { ord: 2, formatBits: 3 },
    H: { ord: 3, formatBits: 2 },
};

// Error correction codewords per block, indexed [ecc.ord][version]
const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// Number of error correction blocks, indexed [ecc.ord][version]
const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const ALNUM_INDEX = new Map([...ALPHANUMERIC_CHARSET].map((c, i) => [c, i]));

// ---- capacity ----

function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}

export function numDataCodewords(ver, ecl = 'L') {
    const e = ECC[ecl].ord;
    return Math.floor(numRawDataModules(ver) / 8)
        - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

function charCountBits(mode, ver) {
    const i = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
    return mode === 'alphanumeric' ? [9, 11, 13][i] : [8, 16, 16][i];
}

function segmentBits(mode, length) {
    if (mode === 'alphanumeric') return Math.floor(length / 2) * 11 + (length % 2) * 6;
    return length * 8;
}

// Most alphanumeric characters one symbol of this version holds.
export function alphanumericCapacity(ver, ecl = 'L') {
    const bits = numDataCodewords(ver, ecl) * 8 - 4 - charCountBits('alphanumeric', ver);
    return Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
}

export function isAlphanumeric(text) {
    for (const c of text) if (!ALNUM_INDEX.has(c)) return false;
    return true;
}

// ---- data bits ----

class BitBuffer {
    constructor() { this.bits = []; }
    append(value, len) {
        for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    }
}

function encodeData(text, ver, ecl, mode) {
    const bb = new BitBuffer();
    let length;
    if (mode === 'alphanumeric') {
        length = text.length;
        bb.append(0x2, 4);
        bb.append(length, charCountBits(mode, ver));
        let i = 0;
        for (; i + 1 < length; i += 2) {
            bb.append(ALNUM_INDEX.get(text[i]) * 45 + ALNUM_INDEX.get(text[i + 1]), 11);
        }
        if (i < length) bb.append(ALNUM_INDEX.get(text[i]), 6);
    } else {
        const bytes = new TextEncoder().encode(text);
        length = bytes.length;
        bb.append(0x4, 4);
        bb.append(length, charCountBits(mode, ver));
        for (const b of bytes) bb.append(b, 8);
    }

    const capacityBits = numDataCodewords(ver, ecl) * 8;
    bb.append(0, Math.min(4, capacityBits - bb.bits.length));
    bb.append(0, (8 - bb.bits.length % 8) % 8);
    for (let pad = 0xEC; bb.bits.length < capacityBits; pad ^= 0xEC ^ 0x11) bb.append(pad, 8);

    const codewords = new Uint8Array(bb.bits.length / 8);
    bb.bits.forEach((bit, i) => { codewords[i >>> 3] |= bit << (7 - (i & 7)); });
    return codewords;
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}

const divisorCache = new Map();
function rsDivisor(degree) {
    if (divisorCache.has(degree)) return divisorCache.get(degree);
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    divisorCache.set(degree, result);
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
        const factor = b ^ result[0];
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
}

function addEccAndInterleave(data, ver, ecl) {
    const e = ECC[ecl].ord;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(blockEccLen);

    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
        const dat = Array.from(data.subarray(k, k + len));
        k += len;
        const ecc = rsRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);
        blocks.push(dat.concat(Array.from(ecc)));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
        for (let j = 0; j < blocks.length; j++) {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
        }
    }
    return result;
}

// Reed-Solomon parity bytes for `data` (same field and generator as QR, so jsQR's decoder corrects it)
export function rsEncode(data, eccLen) {
    return rsRemainder(data, rsDivisor(eccLen));
}

// ---- matrix ----

export function alignmentPatternPositions(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17;
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

class Matrix {
    constructor(ver) {
        this.size = ver * 4 + 17;
        this.modules = new Uint8Array(this.size * this.size);    // 1 = dark
        this.isFunction = new Uint8Array(this.size * this.size); // 1 = finder/timing/alignment/format/version
    }
    get(x, y) { return this.modules[y * this.size + x]; }
    setFunction(x, y, dark) {
        const i = y * this.size + x;
        this.modules[i] = dark ? 1 : 0;
        this.isFunction[i] = 1;
    }
}

function drawFunctionPatterns(m, ver, ecl) {
    const size = m.size;
    for (let i = 0; i < size; i++) {
        m.setFunction(6, i, i % 2 === 0);
        m.setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || x >= size || y < 0 || y >= size) continue;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                m.setFunction(x, y, dist !== 2 && dist !== 4);
            }
        }
    }
    const pos = alignmentPatternPositions(ver);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    m.setFunction(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }
    drawFormatBits(m, ecl, 0); // placeholder, overwritten once the mask is chosen
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const bits = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const bit = (bits >>> i) & 1;
            const a = size - 11 + i % 3, b = Math.floor(i / 3);
            m.setFunction(a, b, bit);
            m.setFunction(b, a, bit);
        }
    }
}

function drawFormatBits(m, ecl, mask) {
    const data = (ECC[ecl].formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = i => (bits >>> i) & 1;
    const size = m.size;
    for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
    m.setFunction(8, 7, bit(6));
    m.setFunction(8, 8, bit(7));
    m.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, bit(i));
    m.setFunction(8, size - 8, 1);
}

function drawCodewords(m, codewords) {
    const size = m.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        const upward = ((right + 1) & 2) === 0;
        for (let vert = 0; vert < size; vert++) {
            const y = upward ? size - 1 - vert : vert;
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const idx = y * size + x;
                if (!m.isFunction[idx] && i < total) {
                    m.modules[idx] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
                    i++;
                }
            }
        }
    }
}

function applyMask(m, mask) {
    const f = MASKS[mask];
    const size = m.size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = y * size + x;
            if (!m.isFunction[idx] && f(x, y)) m.modules[idx] ^= 1;
        }
    }
}

// Penalty score in the spirit of the standard (runs, 2x2 blocks, finder look-alikes, balance).
// Decoders accept any mask; this only steers away from patterns that confuse locators.
function penalty(m) {
    const size = m.size;
    const mod = m.modules;
    let score = 0;
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            let run = 0, prev = -1, window = 0;
            for (let b = 0; b < size; b++) {
                const v = pass === 0 ? mod[a * size + b] : mod[b * size + a];
                if (v === prev) {
                    run++;
                    if (run === 5) score += 3;
                    else if (run > 5) score++;
                } else {
                    run = 1;
                    prev = v;
                }
                window = ((window << 1) | v) & 0x7FF;
                if (b >= 10 && (window === 0x5D || window === 0x5D0)) score += 40;
            }
        }
    }
    for (let y = 0; y + 1 < size; y++) {
        for (let x = 0; x + 1 < size; x++) {
            const v = mod[y * size + x];
            if (v === mod[y * size + x + 1] && v === mod[(y + 1) * size + x] && v === mod[(y + 1) * size + x + 1]) score += 3;
        }
    }
    let dark = 0;
    for (const v of mod) dark += v;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
}

// Encode text into a QR symbol.
// options: ecl ('L'|'M'|'Q'|'H'), minVersion, maxVersion, mask (0-7 to force, default auto),
//          mode ('alphanumeric'|'byte', default: alphanumeric when the text allows it)
export function encodeQR(text, options = {}) {
    const ecl = options.ecl || 'L';
    const mode = options.mode || (isAlphanumeric(text) ? 'alphanumeric' : 'byte');
    const length = mode === 'alphanumeric' ? text.length : new TextEncoder().encode(text).length;
    const minVersion = options.minVersion || 1;
    const maxVersion = options.maxVersion || 40;

    let ver = minVersion;
    for (; ver <= maxVersion; ver++) {
        const needed = 4 + charCountBits(mode, ver) + segmentBits(mode, length);
        if (needed <= numDataCodewords(ver, ecl) * 8) break;
    }
    if (ver > maxVersion) throw new Error('Data too long for a QR symbol');

    const codewords = addEccAndInterleave(encodeData(text, ver, ecl, mode), ver, ecl);
    const m = new Matrix(ver);
    drawFunctionPatterns(m, ver, ecl);
    drawCodewords(m, codewords);

    let mask = options.mask;
    if (mask === undefined || mask === null) {
        let best = Infinity;
        for (let i = 0; i < 8; i++) {
            applyMask(m, i);
            drawFormatBits(m, ecl, i);
            const p = penalty(m);
            if (p < best) { best = p; mask = i; }
            applyMask(m, i); // undo (XOR)
        }
    }
    applyMask(m, mask);
    drawFormatBits(m, ecl, mask);

    return { version: ver, size: m.size, mask, modules: m.modules, isFunction: m.isFunction };
}
