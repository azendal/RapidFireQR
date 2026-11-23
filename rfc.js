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

// levels: 2 (one bit per square) or 4 (two bits per square, Gray-coded grey levels)
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
            bits[band.squares[q]] = bp === 1 ? g : g ^ (g >> 1); // Gray code -> level
        }
    });
    return bits;
}

// Decode the bands of one picture. bits: 0/1 per data square. Returns packets (null = failed).
export function readFrame(rfc, bits, rsDecode) {
    return rfc.plan.map((band, b) => {
        const bytes = new Uint8Array(band.bytes);
        const bp = rfc.bitsPer;
        for (let q = 0; q < Math.floor((band.bytes * 8) / bp); q++) {
            const level = bits[band.squares[q]];
            const g = bp === 1 ? level : level ^ (level >> 1); // level -> Gray code
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
        for (let c = 0; c < cws.length; c++) {
            const fixed = rsDecode(cws[c], rfc.ecc);
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
    if (rfc.levels === 2) {
        const sum = new Float64Array(T), cnt = new Float64Array(T);
        for (let j = 0; j < lum.length; j++) { sum[rfc.tileOf[j]] += lum[j]; cnt[rfc.tileOf[j]]++; }
        const bits = new Uint8Array(lum.length);
        for (let j = 0; j < lum.length; j++) bits[j] = lum[j] < sum[rfc.tileOf[j]] / cnt[rfc.tileOf[j]] ? 1 : 0;
        return bits;
    }
    // 4 levels: the data is uniformly spread over the levels, so each tile's 25/50/75%
    // brightness quantiles are the decision points between neighbouring levels
    if (!rfc.tileMembers) {
        rfc.tileMembers = Array.from({ length: T }, () => []);
        for (let j = 0; j < lum.length; j++) rfc.tileMembers[rfc.tileOf[j]].push(j);
    }
    const levels = new Uint8Array(lum.length);
    for (const members of rfc.tileMembers) {
        if (!members.length) continue;
        // start from the 1/8, 3/8, 5/8, 7/8 brightness points (one per level), then a few
        // rounds of k-means so each centre sits on its level's cluster
        const v = Float32Array.from(members, j => lum[j]).sort();
        const c = [0.125, 0.375, 0.625, 0.875].map(q => v[Math.min(v.length - 1, (v.length * q) | 0)]);
        for (let it = 0; it < 4; it++) {
            const sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
            const t1 = (c[0] + c[1]) / 2, t2 = (c[1] + c[2]) / 2, t3 = (c[2] + c[3]) / 2;
            for (const x of v) { const k = x < t1 ? 0 : x < t2 ? 1 : x < t3 ? 2 : 3; sum[k] += x; cnt[k]++; }
            for (let k = 0; k < 4; k++) if (cnt[k]) c[k] = sum[k] / cnt[k];
        }
        const t1 = (c[0] + c[1]) / 2, t2 = (c[1] + c[2]) / 2, t3 = (c[2] + c[3]) / 2;
        for (const j of members) {
            const x = lum[j];
            levels[j] = x < t1 ? 0 : x < t2 ? 1 : x < t3 ? 2 : 3;
        }
    }
    return levels;
}
