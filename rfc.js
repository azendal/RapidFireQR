// rfc.js - RapidFire code v1: a dense black-and-white frame for screen-to-camera transfer.
//
// Layout: the density test card's (card.js): four finder squares, an orientation bar and a
// lattice of alignment marks; every other square carries one bit (dark = 1).
// The grid is cut into horizontal bands. Each band carries one fountain packet on its own:
//   [packet length u16][packet][CRC-32 of length+packet][zero padding]
// split over interleaved Reed-Solomon codewords. A picture that caught the screen mid-change
// still yields its clean bands; a damaged band fails its codewords or CRC and is dropped.
import { cardLayout } from './card.js';
import { rsEncode } from './qr.js';
import { crc32 } from './envelope.js';

// levels: 2 (one bit per square), 4 (two bits per square, Gray-coded grey levels) or 8 (three bits
// per square as colour: red, green and blue each on or off)
export function rfcPlan(N = 249, bands = 8, ecc = 16, levels = 2) {
    const bitsPer = Math.log2(levels);
    const layout = cardLayout(N);
    const { dataIndex } = layout;
    const bandOf = (i) => Math.min(bands - 1, Math.floor(((i / N) | 0) * bands / N));
    const bandSquares = Array.from({ length: bands }, () => []);
    for (let j = 0; j < dataIndex.length; j++) bandSquares[bandOf(dataIndex[j])].push(j);
    const plan = bandSquares.map(squares => {
        const bytes = Math.floor((squares.length * bitsPer) / 8);
        const cws = Math.ceil(bytes / 255);
        const cwLens = Array.from({ length: cws }, (_, c) => Math.floor(bytes / cws) + (c < bytes % cws ? 1 : 0));
        const dataBytes = cwLens.reduce((a, l) => a + l - ecc, 0);
        return { squares: Int32Array.from(squares), bytes, cwLens, dataBytes };
    });
    // every band carries the same packet size (the smallest band decides)
    const capacity = Math.min(...plan.map(b => b.dataBytes)) - 6; // minus length (2) and CRC (4)
    return { N, bands, ecc, levels, bitsPer, layout, plan, packetBytes: capacity };
}

// Scrambler: every band's bytes are XORed with a fixed pseudo-random sequence (and unused
// squares get pseudo-random levels), so dark/light and the grey levels are evenly used whatever
// the content. The receiver's thresholds rely on that.
function scrambleMask(length, seed) {
    const mask = new Uint8Array(length);
    let t = (seed * 0x9E3779B1) >>> 0;
    for (let i = 0; i < length; i++) {
        t = (t + 0x6D2B79F5) >>> 0;
        let z = Math.imul(t ^ (t >>> 15), t | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        mask[i] = ((z ^ (z >>> 14)) >>> 0) & 0xFF;
    }
    return mask;
}

// byte j of a band belongs to codeword j % cws, at position floor(j / cws)
function interleave(cwLens) {
    const cws = cwLens.length, total = cwLens.reduce((a, b) => a + b, 0);
    const map = [];
    const fill = cwLens.map(() => 0);
    for (let j = 0, c = 0; j < total; c = (c + 1) % cws) {
        if (fill[c] < cwLens[c]) { map.push([c, fill[c]++]); j++; }
    }
    return map;
}

// Level per data square (0 = dark .. levels-1 = light... see paintFrame) for one frame:
// one packet per band (null = band left empty). With 2 bits per square the bits are Gray-coded,
// so mistaking a square for a neighbouring grey level costs one bit, not two.
export function buildFrame(rfc, packets) {
    const bits = new Uint8Array(rfc.layout.dataIndex.length);
    rfc.plan.forEach((band, b) => {
        const packet = packets[b];
        const body = new Uint8Array(band.dataBytes);
        if (packet) {
            body[0] = packet.length >> 8;
            body[1] = packet.length & 0xFF;
            body.set(packet, 2);
            const crc = crc32(body.subarray(0, 2 + packet.length));
            body.set([crc >>> 24, (crc >>> 16) & 0xFF, (crc >>> 8) & 0xFF, crc & 0xFF], 2 + packet.length);
        }
        // split the body over codewords and add parity
        const cws = band.cwLens.map(l => new Uint8Array(l));
        let k = 0;
        band.cwLens.forEach((l, c) => {
            const d = l - rfc.ecc;
            cws[c].set(body.subarray(k, k + d), 0);
            cws[c].set(rsEncode(cws[c].subarray(0, d), rfc.ecc), d);
            k += d;
        });
        const order = band.order || (band.order = interleave(band.cwLens));
        const mask = band.mask || (band.mask = scrambleMask(band.bytes + band.squares.length, b + 1));
        const bytes = new Uint8Array(band.bytes);
        order.forEach(([c, p], j) => { bytes[j] = cws[c][p] ^ mask[j]; });
        const bp = rfc.bitsPer;
        // squares past the band's last whole byte: pseudo-random too
        for (let q = Math.floor((band.bytes * 8) / bp); q < band.squares.length; q++) {
            bits[band.squares[q]] = mask[band.bytes + q] % rfc.levels;
        }
        for (let q = 0; q < Math.floor((band.bytes * 8) / bp); q++) {
            let g = 0;
            for (let t = 0; t < bp; t++) {
                const j = q * bp + t;
                g = (g << 1) | ((bytes[j >> 3] >> (7 - (j & 7))) & 1);
            }
            bits[band.squares[q]] = bp === 2 ? g ^ (g >> 1) : g; // Gray code -> grey level (colour: bits are the channels)
        }
    });
    return bits;
}

// Decode the bands of one picture. bits: level per data square. Returns packets (null = failed).
// erasures: fractions of the check bytes to retry a failed codeword with, naming that many of its
// least certain bytes (from threshold()'s margins) as erasures; [] = plain decoding only.
// Needs an rsDecode that takes erasures (rs.js).
export function readFrame(rfc, bits, rsDecode, { erasures = [] } = {}) {
    return rfc.plan.map((band, b) => {
        const bytes = new Uint8Array(band.bytes);
        const bp = rfc.bitsPer;
        for (let q = 0; q < Math.floor((band.bytes * 8) / bp); q++) {
            const level = bits[band.squares[q]];
            const g = bp === 2 ? level ^ (level >> 1) : level; // grey level -> Gray code
            for (let t = 0; t < bp; t++) {
                const j = q * bp + t;
                if ((g >> (bp - 1 - t)) & 1) bytes[j >> 3] |= 1 << (7 - (j & 7));
            }
        }
        const order = band.order || (band.order = interleave(band.cwLens));
        const mask = band.mask || (band.mask = scrambleMask(band.bytes + band.squares.length, b + 1));
        const cws = band.cwLens.map(l => new Uint8Array(l));
        order.forEach(([c, p], j) => { cws[c][p] = bytes[j] ^ mask[j]; });
        const body = new Uint8Array(band.dataBytes);
        let k = 0;
        let doubt = null;
        for (let c = 0; c < cws.length; c++) {
            let fixed = rsDecode(cws[c], rfc.ecc);
            for (let a = 0; !fixed && a < erasures.length && rfc.margin; a++) {
                if (!doubt) doubt = byteDoubt(rfc, band, order);
                const e = Math.min(rfc.ecc, Math.round(rfc.ecc * erasures[a]));
                fixed = rsDecode(cws[c], rfc.ecc, doubt[c].slice(0, e));
                if (fixed) rfc.rescued = (rfc.rescued || 0) + 1;
            }
            if (!fixed) return null;
            const d = band.cwLens[c] - rfc.ecc;
            body.set(fixed.subarray(0, d), k);
            k += d;
        }
        const len = (body[0] << 8) | body[1];
        if (len < 9 || len + 6 > body.length) return null;
        const crc = ((body[2 + len] << 24) | (body[3 + len] << 16) | (body[4 + len] << 8) | body[5 + len]) >>> 0;
        if (crc32(body.subarray(0, 2 + len)) !== crc) return null;
        return body.slice(2, 2 + len);
    });
}

// Per codeword, its byte positions from least to most certain. A byte is as certain as its
// least certain square (the margin threshold() left for it).
function byteDoubt(rfc, band, order) {
    const bp = rfc.bitsPer;
    const lists = band.cwLens.map(() => []);
    for (let j = 0; j < order.length; j++) {
        let m = Infinity;
        // the squares holding bits 8j .. 8j+7 (with 3 bits a square, a byte can straddle squares)
        for (let q = Math.floor((j * 8) / bp); q <= Math.floor((j * 8 + 7) / bp); q++) {
            const v = rfc.margin[band.squares[q]];
            if (v < m) m = v;
        }
        lists[order[j][0]].push([m, order[j][1]]);
    }
    return lists.map(l => l.sort((a, b) => a[0] - b[0]).map(x => x[1]));
}

// Grey value per square for painting: fixed squares from the layout, data squares from bits
export function paintFrame(imageData, rfc, bits, greys = null) {
    // 2 levels: 1 = dark. 4 levels: level 0..3 from dark to light via the greys table.
    const table = rfc.levels === 2 ? [255, 0] : (greys || [0, 110, 168, 255]);
    const { N, fixed, dataIndex } = rfc.layout;
    const d = imageData.data;
    for (let i = 0; i < N * N; i++) {
        const g = fixed[i];
        if (g >= 0) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255; }
    }
    if (rfc.levels === 8) {
        // colour: level bits are red, green, blue (on = full intensity); blank = white
        for (let j = 0; j < dataIndex.length; j++) {
            const i = dataIndex[j], v = bits ? bits[j] : 7;
            d[i * 4] = v & 4 ? 255 : 0;
            d[i * 4 + 1] = v & 2 ? 255 : 0;
            d[i * 4 + 2] = v & 1 ? 255 : 0;
            d[i * 4 + 3] = 255;
        }
        return;
    }
    for (let j = 0; j < dataIndex.length; j++) {
        const i = dataIndex[j], g = bits ? table[bits[j]] : 255;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
        d[i * 4 + 3] = 255;
    }
}

// Light/dark decision per square: compare with the local average brightness (the data is
// close to half dark everywhere, since packets are compressed and fountain-mixed).
export function threshold(rfc, lum, tiles = 12) {
    const { N, dataIndex } = rfc.layout;
    if (!rfc.tileOf) {
        rfc.tileOf = new Uint16Array(dataIndex.length);
        for (let j = 0; j < dataIndex.length; j++) {
            const i = dataIndex[j];
            rfc.tileOf[j] = Math.min(tiles - 1, (((i / N) | 0) * tiles / N) | 0) * tiles + Math.min(tiles - 1, ((i % N) * tiles / N) | 0);
        }
    }
    const T = tiles * tiles;
    if (rfc.levels === 8) return thresholdColour(rfc, lum, T);
    if (rfc.levels === 2) {
        const sum = new Float64Array(T), cnt = new Float64Array(T);
        for (let j = 0; j < lum.length; j++) { sum[rfc.tileOf[j]] += lum[j]; cnt[rfc.tileOf[j]]++; }
        const bits = new Uint8Array(lum.length);
        const margin = rfc.margin && rfc.margin.length === lum.length ? rfc.margin : (rfc.margin = new Float32Array(lum.length));
        for (let j = 0; j < lum.length; j++) {
            const d = lum[j] - sum[rfc.tileOf[j]] / cnt[rfc.tileOf[j]];
            bits[j] = d < 0 ? 1 : 0;
            margin[j] = d < 0 ? -d : d;
        }
        return bits;
    }
    // 4 levels: the data is uniformly spread over the levels (the scrambler sees to that), so
    // each tile's brightness splits into four clusters. Every tile gets a 256-bucket brightness
    // histogram; the clusters start at its 1/8, 3/8, 5/8, 7/8 points and a few rounds of k-means
    // on the histogram settle them. Decision points sit halfway between neighbouring clusters.
    const hist = rfc.hist || (rfc.hist = new Uint32Array(T * 256));
    hist.fill(0);
    const tileOf = rfc.tileOf;
    for (let j = 0; j < lum.length; j++) {
        const v = lum[j];
        hist[tileOf[j] * 256 + (v < 0 ? 0 : v > 255 ? 255 : v | 0)]++;
    }
    const cuts = rfc.cuts || (rfc.cuts = new Float32Array(T * 3));
    const c = [0, 0, 0, 0], sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
    for (let t = 0; t < T; t++) {
        const h = t * 256;
        let n = 0;
        for (let b = 0; b < 256; b++) n += hist[h + b];
        if (!n) continue;
        for (let k = 0, acc = 0, b = 0; k < 4; k++) {
            const target = n * (2 * k + 1) / 8;
            while (b < 255 && acc + hist[h + b] <= target) acc += hist[h + b++];
            c[k] = b + 0.5;
        }
        for (let it = 0; it < 4; it++) {
            sum.fill(0);
            cnt.fill(0);
            const t1 = (c[0] + c[1]) / 2, t2 = (c[1] + c[2]) / 2, t3 = (c[2] + c[3]) / 2;
            for (let b = 0; b < 256; b++) {
                const m = hist[h + b];
                if (!m) continue;
                const x = b + 0.5, k = x < t1 ? 0 : x < t2 ? 1 : x < t3 ? 2 : 3;
                sum[k] += x * m;
                cnt[k] += m;
            }
            for (let k = 0; k < 4; k++) if (cnt[k]) c[k] = sum[k] / cnt[k];
        }
        cuts[t * 3] = (c[0] + c[1]) / 2;
        cuts[t * 3 + 1] = (c[1] + c[2]) / 2;
        cuts[t * 3 + 2] = (c[2] + c[3]) / 2;
    }
    const levels = new Uint8Array(lum.length);
    const margin = rfc.margin && rfc.margin.length === lum.length ? rfc.margin : (rfc.margin = new Float32Array(lum.length));
    for (let j = 0; j < lum.length; j++) {
        const x = lum[j], o = tileOf[j] * 3;
        const k = x < cuts[o] ? 0 : x < cuts[o + 1] ? 1 : x < cuts[o + 2] ? 2 : 3;
        levels[j] = k;
        // how far from the nearest decision point: small = doubtful
        const lo = k > 0 ? x - cuts[o + k - 1] : 255, hi = k < 3 ? cuts[o + k] - x : 255;
        margin[j] = lo < hi ? lo : hi;
    }
    return levels;
}

// Colour: lum holds red, green, blue per square (interleaved). The scrambler keeps each channel on
// for about half the squares everywhere, so each channel is read like black and white: brighter
// than its tile's average = on. A square is as certain as its least certain channel, measured
// against that channel's typical distance from the average in the tile.
function thresholdColour(rfc, rgb, T) {
    const n = rgb.length / 3, tileOf = rfc.tileOf;
    const sum = new Float64Array(T * 3), dev = new Float64Array(T * 3), cnt = new Float64Array(T);
    for (let j = 0; j < n; j++) {
        const t = tileOf[j] * 3;
        sum[t] += rgb[j * 3]; sum[t + 1] += rgb[j * 3 + 1]; sum[t + 2] += rgb[j * 3 + 2];
        cnt[tileOf[j]]++;
    }
    for (let t = 0; t < T; t++) for (let c = 0; c < 3; c++) if (cnt[t]) sum[t * 3 + c] /= cnt[t];
    for (let j = 0; j < n; j++) {
        const t = tileOf[j] * 3;
        for (let c = 0; c < 3; c++) dev[t + c] += Math.abs(rgb[j * 3 + c] - sum[t + c]);
    }
    for (let t = 0; t < T; t++) for (let c = 0; c < 3; c++) dev[t * 3 + c] = cnt[t] ? dev[t * 3 + c] / cnt[t] || 1 : 1;
    const levels = new Uint8Array(n);
    const margin = rfc.margin && rfc.margin.length === n ? rfc.margin : (rfc.margin = new Float32Array(n));
    for (let j = 0; j < n; j++) {
        const t = tileOf[j] * 3;
        let v = 0, m = Infinity;
        for (let c = 0; c < 3; c++) {
            const d = rgb[j * 3 + c] - sum[t + c];
            v = (v << 1) | (d > 0 ? 1 : 0);
            const r = Math.abs(d) / dev[t + c];
            if (r < m) m = r;
        }
        levels[j] = v;
        margin[j] = m * 50;
    }
    return levels;
}

// Diagnostic: how cleanly each channel splits into on/off. Per channel, values are split at their
// tile's average; the score is the distance between the two groups' means in units of their
// spread (d'). Above ~4 reads reliably; below ~2 is mostly guesswork.
export function colourSeparation(rfc, rgb) {
    threshold(rfc, rgb); // makes sure tileOf exists
    const n = rgb.length / 3, tileOf = rfc.tileOf;
    const T = Math.max(...tileOf) + 1;
    const mean = new Float64Array(T * 3), cnt = new Float64Array(T);
    for (let j = 0; j < n; j++) { cnt[tileOf[j]]++; for (let c = 0; c < 3; c++) mean[tileOf[j] * 3 + c] += rgb[j * 3 + c]; }
    for (let t = 0; t < T; t++) for (let c = 0; c < 3; c++) mean[t * 3 + c] /= cnt[t] || 1;
    return [0, 1, 2].map(c => {
        let s1 = 0, s0 = 0, q1 = 0, q0 = 0, n1 = 0, n0 = 0;
        for (let j = 0; j < n; j++) {
            const d = rgb[j * 3 + c] - mean[tileOf[j] * 3 + c];
            if (d > 0) { s1 += d; q1 += d * d; n1++; } else { s0 += d; q0 += d * d; n0++; }
        }
        const m1 = s1 / n1, m0 = s0 / n0;
        const v = (q1 / n1 - m1 * m1 + q0 / n0 - m0 * m0) / 2;
        return +((m1 - m0) / Math.sqrt(Math.max(v, 1e-6))).toFixed(2);
    });
}
