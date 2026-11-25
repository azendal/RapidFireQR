// card.js - density test card for measuring what a camera can resolve.
//
// The sender shows an N×N grid (N ≡ 1 mod 4) laid out like a QR code: three finder squares and
// one alignment square, so jsQR's locator can find it, and every other square ("data") holds a
// pseudo-random grey level 0..L-1 that depends only on (seed, frame number k). The receiver knows
// seed, N and L, so for each camera picture it can work out which frame it saw and count exactly
// which squares it misread: no decoding involved, just the raw channel.

export function cardLayout(N, spacing = 20) {
    const fixed = new Int16Array(N * N).fill(-1); // -1 = data, otherwise the grey value 0..255
    const setRegion = (cx, cy, radius, darkAt) => {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= N || y >= N) continue;
                fixed[y * N + x] = darkAt(Math.max(Math.abs(dx), Math.abs(dy))) ? 0 : 255;
            }
        }
    };
    // Finders (7×7 with a white separator ring) in all four corners, centres 3 squares in.
    // jsQR's locator finds three of them; the fourth makes an exact perspective fit possible.
    for (const [cx, cy] of [[3, 3], [N - 4, 3], [3, N - 4], [N - 4, N - 4]]) setRegion(cx, cy, 4, d => d !== 2 && d !== 4);
    // Orientation mark: a dark bar under the top-left finder (with a white row below it), so the
    // four identical corners can't be confused when the card is seen rotated or mirrored
    for (let x = 0; x < 8; x++) { fixed[8 * N + x] = 0; fixed[9 * N + x] = 255; }
    // Alignment marks on a lattice (like big QR versions): 5×5, dark ring / white ring / dark dot.
    // The lattice runs from finder centre to finder centre, so the four corners are finders.
    const m = Math.max(2, Math.ceil((N - 7) / spacing) + 1);
    const lattice = Array.from({ length: m }, (_, i) => Math.round(3 + (i * (N - 7)) / (m - 1)));
    const controls = [];
    for (const ay of lattice) {
        for (const ax of lattice) {
            const corner = (ax === 3 || ax === N - 4) && (ay === 3 || ay === N - 4);
            if (!corner) setRegion(ax, ay, 2, d => d !== 1);
            controls.push({ x: ax, y: ay, finder: corner });
        }
    }
    const dataIndex = [];
    for (let i = 0; i < N * N; i++) if (fixed[i] < 0) dataIndex.push(i);
    return { N, fixed, dataIndex: Int32Array.from(dataIndex), lattice, controls };
}

function mulberry32(a) {
    return function () {
        let t = (a += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    };
}

// The grey level (0..L-1) of every data square in frame k
export function frameValues(layout, L, seed, k) {
    const bits = Math.log2(L);
    const rand = mulberry32((Math.imul(seed, 2654435761) ^ Math.imul(k + 1, 0x9E3779B1)) >>> 0);
    const out = new Uint8Array(layout.dataIndex.length);
    for (let i = 0; i < out.length; i++) out[i] = rand() >>> (32 - bits);
    return out;
}

export function defaultGreys(L) {
    return Array.from({ length: L }, (_, v) => Math.round((v * 255) / (L - 1)));
}

// Paint frame k into an N×N ImageData (one pixel per square)
export function paintCard(imageData, layout, L, seed, k, greys = defaultGreys(L), blank = false) {
    const { N, fixed, dataIndex } = layout;
    const d = imageData.data;
    for (let i = 0; i < N * N; i++) {
        const g = fixed[i];
        if (g >= 0) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255; }
    }
    const values = frameValues(layout, L, seed, k);
    for (let j = 0; j < dataIndex.length; j++) {
        const i = dataIndex[j], g = blank ? 255 : greys[values[j]];
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
        d[i * 4 + 3] = 255;
    }
}

const gray = v => v ^ (v >> 1);
const popcount = v => { let c = 0; while (v) { c += v & 1; v >>= 1; } return c; };

// --- Receiver side ---

export class CardAnalyzer {
    constructor({ N, L, seed }) {
        this.N = N;
        this.L = L;
        this.seed = seed;
        this.layout = cardLayout(N);
        this.cache = new Map(); // k -> values
        this.positions = null;  // Float32Array of module centre pixel coords, data squares only
        this.modulePx = null;
        // An evenly spread subset of data squares for the quick "which frame is this" search
        const n = this.layout.dataIndex.length;
        const step = Math.max(1, Math.floor(n / 1500));
        this.probe = [];
        for (let j = 0; j < n; j += step) this.probe.push(j);
        // Tiles for local calibration and tear detection: 4×4 over the grid
        this.tiles = 4;
        this.tileOf = new Uint8Array(n);
        this.parity = new Uint8Array(n);
        for (let j = 0; j < n; j++) {
            const i = this.layout.dataIndex[j], x = i % N, y = (i / N) | 0;
            this.tileOf[j] = Math.min(this.tiles - 1, (y * this.tiles / N) | 0) * this.tiles + Math.min(this.tiles - 1, (x * this.tiles / N) | 0);
            this.parity[j] = (x + y) & 1;
        }
    }

    values(k) {
        if (!this.cache.has(k)) {
            if (this.cache.size > 400) this.cache.clear();
            this.cache.set(k, frameValues(this.layout, this.L, this.seed, k));
        }
        return this.cache.get(k);
    }

    // Find the card in the picture and work out where every square's centre is.
    // 1. Scan the whole (binarized) picture for finder patterns (strict 1:1:3:1:1, both ways)
    //    and keep the four strongest: real finders are hit on many lines, look-alikes on few.
    // 2. Refine each centre to sub-pixel accuracy (centroid of its dark core).
    // 3. Fit a perspective mapping for each way of assigning them to the card's corners and keep
    //    the one whose fixed squares (incl. the orientation bar) match best.
    // 4. Bend it locally with the alignment marks (meshMap).
    locate(img) {
        const jsQR = window.jsQR;
        const { N, dataIndex } = this.layout;
        if (!this.fixedIndex) {
            this.fixedIndex = [];
            for (let i = 0; i < N * N; i++) if (this.layout.fixed[i] >= 0) this.fixedIndex.push(i);
        }
        this.debug = {};
        // Candidates from the 1:1:3:1:1 scan, each checked against the whole finder pattern: in a
        // dense code random data imitates the scan's ratios often, the 9x9 pattern never. Up close
        // the screen's own pixel rows break the scan's runs, so a blurred copy is tried as well.
        let verified = [];
        for (const blur of [0, 1, 2]) {
            const src = blur ? blurLum(img, blur) : img;
            const { binarized } = jsQR.internals.binarize(src.data, img.width, img.height, false);
            for (const f of findFinders(binarized).slice(0, 400)) {
                if (verified.some(v => Math.hypot(v.x - f.x, v.y - f.y) < f.size)) continue;
                const m = matchFinder(src, f.x, f.y, f.size / 7);
                if (m.r > 0.75) verified.push({ ...m, size: m.px * 7, n: f.n });
            }
            if (verified.length >= 4) break;
        }
        verified.sort((p, q) => q.r - p.r);
        this.debug.finders = verified.slice(0, 6).map(f => [Math.round(f.x), Math.round(f.y), +f.r.toFixed(2), +f.size.toFixed(1)]);
        if (verified.length < 3) return false;
        const ref = verified.slice(0, 3).map(f => f.size).sort((a, b) => a - b)[1];
        let top = verified.filter(f => f.size > ref * 0.65 && f.size < ref * 1.5).slice(0, 4);
        if (top.length < 3) return false;
        if (top.length === 3) {
            // one corner is missing: it completes the parallelogram of the other three, give or
            // take perspective; look for the pattern around there
            const d = (p, q) => Math.hypot(top[p].x - top[q].x, top[p].y - top[q].y);
            const [c, p, q] = [[0, 1, 2], [1, 0, 2], [2, 0, 1]].sort((u, v) => d(v[1], v[2]) - d(u[1], u[2]))[0]; // c: opposite the longest side
            const gx = top[p].x + top[q].x - top[c].x, gy = top[p].y + top[q].y - top[c].y;
            const reach = d(p, q) * 0.12, step = ref / 14;
            let found = null;
            for (let y = gy - reach; y <= gy + reach; y += step) {
                for (let x = gx - reach; x <= gx + reach; x += step) {
                    const r = finderCorrelation(img, x, y, ref / 7);
                    if (!found || r > found.r) found = { x, y, r };
                }
            }
            const m = found && matchFinder(img, found.x, found.y, ref / 7);
            if (!m || m.r < 0.7) return false;
            this.debug.fourth = [Math.round(m.x), Math.round(m.y), +m.r.toFixed(2)];
            top.push({ ...m, size: m.px * 7 });
        }
        const px = top.reduce((a, f) => a + f.size, 0) / 4 / 7;
        // cyclic order around their centre
        const cx = top.reduce((a, f) => a + f.x, 0) / 4, cy = top.reduce((a, f) => a + f.y, 0) / 4;
        top.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
        const pts = top.map(f => refineFinderCentre(img, f.x, f.y, px));
        this.debug.refined = pts.map(p => p && p.map(Math.round));
        if (pts.some(p => !p)) return false;
        const target = [[3.5, 3.5], [N - 3.5, 3.5], [N - 3.5, N - 3.5], [3.5, N - 3.5]];
        // Every way of assigning the four finders to the card's corners, scored roughly first;
        // near the picture's edges lens distortion can make even the right one score low, so the
        // three best get the alignment-mark correction and the best corrected match wins.
        const fits = [];
        for (let rot = 0; rot < 4; rot++) {
            for (const mirror of [false, true]) {
                const order = [0, 1, 2, 3].map(i => (mirror ? (4 - i) % 4 : i));
                const H = homography(target, order.map(i => pts[(i + rot) % 4]));
                if (!H) continue;
                const map = (x, y) => applyH(H, x, y);
                fits.push({ r: this.fixedCorrelation(img, map), map });
            }
        }
        fits.sort((a, b) => b.r - a.r);
        this.locateScore = fits.length ? fits[0].r : null;
        // The card looks almost the same turned or mirrored (four identical finders, an even
        // lattice), so the fixed-square score can't tell orientations apart. The orientation bar
        // decides: in the right orientation its dark row (8) is much darker than the white row (9).
        const lumAt = (x, y) => {
            const xi = Math.floor(x), yi = Math.floor(y);
            return xi < 0 || yi < 0 || xi >= img.width || yi >= img.height ? 128 : img.data[(yi * img.width + xi) * 4 + 1];
        };
        let best = null;
        for (const f of fits.slice(0, 4)) {
            if (f.r < -0.5) continue;
            const meshed = this.meshMap(img, f.map);
            const r = this.fixedCorrelation(img, meshed);
            if (r < 0.7) continue;
            // all 16 squares have to fit: random data in the same place can easily average
            // darker in one row than the other, but not match square by square
            const cell = (x, y) => {
                let v = 0;
                for (const [ox, oy] of [[0, 0], [-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2]]) v += lumAt(...meshed(x + ox, y + oy));
                return v / 5;
            };
            let dark = 0, light = 0;
            const D = [], Lt = [];
            for (let x = 0; x < 8; x++) {
                const d = cell(x + 0.5, 8.5), l = cell(x + 0.5, 9.5);
                D.push(d); Lt.push(l);
                dark += d; light += l;
            }
            const md = dark / 8, ml = light / 8;
            let spread = 0;
            for (let x = 0; x < 8; x++) spread += (D[x] - md) ** 2 + (Lt[x] - ml) ** 2;
            // difference between the rows, less how uneven the rows themselves are
            const bar = (ml - md) - 1.5 * Math.sqrt(spread / 16);
            if (!best || bar > best.bar) best = { r, bar, map: meshed, offsets: this.meshOffsets };
        }
        this.meshScore = best ? best.r : null;
        this.barContrast = best ? best.bar : null;
        if (!best || best.bar < 15) return false;
        this.meshOffsets = best.offsets;
        const map = best.map;
        const pos = new Float32Array(dataIndex.length * 2);
        for (let j = 0; j < dataIndex.length; j++) {
            const i = dataIndex[j];
            const [x, y] = map((i % N) + 0.5, ((i / N) | 0) + 0.5);
            pos[j * 2] = x;
            pos[j * 2 + 1] = y;
        }
        const a = map(0, 0), b = map(N, 0), c = map(0, N);
        this.modulePx = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - a[0], c[1] - a[1])) / 2 / N;
        this.positions = pos;
        this.map = map;
        this.track = null; // refineY() starts over from this lock
        this.corners = [a, b, map(N, N), c].map(p => [Math.round(p[0]), Math.round(p[1])]);
        return true;
    }

    // Refine the global perspective fit with the alignment marks: find each mark's actual
    // position (template search around the prediction), then map squares with the global fit
    // plus a bilinear blend of the four surrounding marks' offsets.
    meshMap(img, global) {
        const { N, lattice, controls } = this.layout;
        const m = lattice.length;
        const px = Math.hypot(...[0, 1].map(i => global(N, 0)[i] - global(0, 0)[i])) / N;
        const lumAt = (x, y) => {
            const xi = Math.floor(x), yi = Math.floor(y);
            if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 128;
            return img.data[(yi * img.width + xi) * 4 + 1];
        };
        const off = new Float32Array(m * m * 2);
        const ok = new Uint8Array(m * m);
        controls.forEach((c, idx) => { if (c.finder) ok[idx] = 1; }); // corners are exact by construction
        // Best offset for one mark, searching ±R around (cx0, cy0)
        const search = (c, cx0, cy0, R) => {
            const cells = [];
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                cells.push([global(c.x + dx + 0.5, c.y + dy + 0.5), Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 1 : 0]);
            }
            let bestR = -2, bx = 0, by = 0;
            for (let oy = cy0 - R; oy <= cy0 + R; oy += 0.5) {
                for (let ox = cx0 - R; ox <= cx0 + R; ox += 0.5) {
                    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
                    for (const [[x, y], want] of cells) {
                        const l = lumAt(x + ox, y + oy);
                        n++; sx += l; sy += want; sxx += l * l; syy += want * want; sxy += l * want;
                    }
                    const vx = sxx - (sx * sx) / n;
                    const r = vx > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * (syy - (sy * sy) / n)) : -1;
                    if (r > bestR) { bestR = r; bx = ox; by = oy; }
                }
            }
            return { r: bestR, bx, by };
        };
        // Spread outward from the corner finders: each mark is looked for near where its matched
        // neighbours say it should be. Lens distortion can move marks in the middle of an edge by
        // several squares (more than a search around the global fit can tell apart from a
        // neighbouring square), but it changes little from one mark to the next.
        const results = [];
        const at = (i, j) => (i >= 0 && j >= 0 && i < m && j < m && ok[j * m + i] ? j * m + i : -1);
        const predict = (i, j) => {
            let sx = 0, sy = 0, w = 0, n = 0;
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
                if (!di && !dj) continue;
                const a = at(i + di, j + dj);
                if (a < 0) continue;
                n++;
                // with two matched marks in a line, follow the trend; otherwise repeat the neighbour
                const b = at(i + 2 * di, j + 2 * dj);
                const wt = b >= 0 ? 2 : 1;
                sx += wt * (b >= 0 ? 2 * off[a * 2] - off[b * 2] : off[a * 2]);
                sy += wt * (b >= 0 ? 2 * off[a * 2 + 1] - off[b * 2 + 1] : off[a * 2 + 1]);
                w += wt;
            }
            return n ? { x: sx / w, y: sy / w, n } : null;
        };
        const R = Math.max(2, Math.ceil(px * 1.1));
        for (const accept of [0.8, 0.6, 0.45]) {
            for (let progress = true; progress;) {
                progress = false;
                // marks with the most matched neighbours first
                const next = [];
                controls.forEach((c, idx) => {
                    if (ok[idx] || (results[idx] && results[idx].tried === accept && results[idx].again <= 0)) return;
                    const g = predict(idx % m, (idx / m) | 0);
                    if (g) next.push([g.n, idx]);
                });
                next.sort((p, q) => q[0] - p[0]);
                for (const [, idx] of next) {
                    const g = predict(idx % m, (idx / m) | 0);
                    const c = controls[idx], old = results[idx];
                    const res = search(c, Math.round(g.x * 2) / 2, Math.round(g.y * 2) / 2, R);
                    res.tried = accept;
                    res.again = old && old.tried === accept ? old.again - 1 : 2; // a few retries as neighbours fill in
                    results[idx] = res;
                    if (res.r > accept) {
                        off[idx * 2] = res.bx;
                        off[idx * 2 + 1] = res.by;
                        ok[idx] = 1;
                    }
                    progress = true;
                }
            }
        }
        controls.forEach((c, idx) => {
            if (ok[idx]) return;
            const g = predict(idx % m, (idx / m) | 0);
            if (g) { off[idx * 2] = g.x; off[idx * 2 + 1] = g.y; }
        });
        this.meshOffsets = controls.map((c, idx) => [c.x, c.y, off[idx * 2], off[idx * 2 + 1], results[idx] ? +results[idx].r.toFixed(2) : 1]);
        const cellOf = (v) => {
            let i = 0;
            while (i < m - 2 && v > lattice[i + 1]) i++;
            return i;
        };
        return (x, y) => {
            const [gx, gy] = global(x, y);
            const i = cellOf(x - 0.5), j = cellOf(y - 0.5);
            const x0 = lattice[i], x1 = lattice[i + 1], y0 = lattice[j], y1 = lattice[j + 1];
            const u = Math.min(1, Math.max(0, (x - 0.5 - x0) / (x1 - x0)));
            const v = Math.min(1, Math.max(0, (y - 0.5 - y0) / (y1 - y0)));
            const o = (a, b, k) => off[(b * m + a) * 2 + k];
            const ox = (1 - u) * (1 - v) * o(i, j, 0) + u * (1 - v) * o(i + 1, j, 0) + (1 - u) * v * o(i, j + 1, 0) + u * v * o(i + 1, j + 1, 0);
            const oy = (1 - u) * (1 - v) * o(i, j, 1) + u * (1 - v) * o(i + 1, j, 1) + (1 - u) * v * o(i, j + 1, 1) + u * v * o(i + 1, j + 1, 1);
            return [gx + ox, gy + oy];
        };
    }

    // Is the card still where we think it is? (fixed squares still match)
    stillLocated(img) {
        return !!this.map && this.fixedCorrelation(img, this.map) > 0.7;
    }

    fixedCorrelation(img, map) {
        const { N, fixed } = this.layout;
        let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (const i of this.fixedIndex) {
            const [px, py] = map((i % N) + 0.5, ((i / N) | 0) + 0.5);
            const x = Math.floor(px), y = Math.floor(py);
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            const lum = img.data[(y * img.width + x) * 4 + 1], want = fixed[i];
            n++; sx += lum; sy += want; sxx += lum * lum; syy += want * want; sxy += lum * want;
        }
        if (n < this.fixedIndex.length * 0.9) return -1;
        const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
        return vx > 0 ? cov / Math.sqrt(vx * vy) : -1;
    }

    // Brightness at every data square's centre (green channel, averaged over a small window)
    // ox, oy: where img's top-left sits in the full camera picture (when only a crop was grabbed)
    sample(img, ox = 0, oy = 0) {
        const { width: W, height: H, data } = img;
        const pos = this.positions;
        const n = pos.length / 2;
        const r = Math.max(0, Math.floor(this.modulePx * 0.2));
        const out = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            // a continuous coordinate c lies in pixel floor(c)
            const cx = Math.floor(pos[j * 2]) - ox, cy = Math.floor(pos[j * 2 + 1]) - oy;
            let s = 0, c = 0;
            for (let dy = -r; dy <= r; dy++) {
                const y = cy + dy;
                if (y < 0 || y >= H) continue;
                for (let dx = -r; dx <= r; dx++) {
                    const x = cx + dx;
                    if (x < 0 || x >= W) continue;
                    s += data[(y * W + x) * 4 + 1];
                    c++;
                }
            }
            out[j] = c ? s / c : 0;
        }
        return out;
    }

    // Follow small changes since the lock (the lens refocusing changes the picture's scale by a
    // pixel or two, a hand-held camera drifts): measure where a spread of the alignment marks are
    // now in a brightness plane, fit one affine correction, and move every square by it.
    // Returns the largest corner movement in pixels, or null if too few marks were found.
    refineY(Y, stride, rows, ox, oy) {
        const { lattice, controls, dataIndex } = this.layout;
        const m = lattice.length;
        if (!this.track) {
            const step = Math.max(1, Math.round(m / 12));
            const marks = [];
            controls.forEach((c, idx) => {
                const i = idx % m, j = (idx / m) | 0;
                if (c.finder || (i % step && i !== m - 1) || (j % step && j !== m - 1)) return;
                const cells = new Float64Array(50);
                let k = 0;
                for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                    const [x, y] = this.map(c.x + dx + 0.5, c.y + dy + 0.5);
                    cells[k++] = x;
                    cells[k++] = y;
                }
                marks.push(cells);
            });
            const want = new Float64Array(25);
            let k = 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) want[k++] = Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 1 : 0;
            this.track = { marks, want };
        }
        const { marks, want } = this.track;
        // least squares for dx = a + b x + c y (same for dy), x and y measured from the centre
        let cx = 0, cy = 0;
        for (const q of marks) { cx += q[24]; cy += q[25]; }
        cx /= marks.length;
        cy /= marks.length;
        const found = [];
        const scores = new Float64Array(81);
        const st = Math.max(0.4, this.modulePx * 0.13); // search step: about +-half a square in all
        for (const q of marks) {
            let best = -2, bi = 0;
            for (let t = 0; t < 81; t++) {
                const sx = ((t % 9) - 4) * st, sy = (((t / 9) | 0) - 4) * st;
                let sv = 0, svv = 0, svw = 0, sw = 0, n = 0;
                for (let k = 0; k < 25; k++) {
                    const x = Math.floor(q[k * 2] + sx) - ox, y = Math.floor(q[k * 2 + 1] + sy) - oy;
                    if (x < 0 || y < 0 || x >= stride || y >= rows) continue;
                    const v = Y[y * stride + x];
                    sv += v; svv += v * v; svw += v * want[k]; sw += want[k]; n++;
                }
                const vx = n === 25 ? svv - (sv * sv) / n : 0;
                const r = vx > 0 ? (svw - (sv * sw) / n) / Math.sqrt(vx * (sw - (sw * sw) / n)) : -1;
                scores[t] = r;
                if (r > best) { best = r; bi = t; }
            }
            if (best < 0.6) continue;
            // the middle of the well-matching offsets (the match is flat-topped: squares are wide)
            let w = 0, wx = 0, wy = 0;
            for (let t = 0; t < 81; t++) {
                const g = scores[t] - (best - 0.12);
                if (g <= 0) continue;
                w += g; wx += g * ((t % 9) - 4) * st; wy += g * (((t / 9) | 0) - 4) * st;
            }
            found.push([q[24] - cx, q[25] - cy, wx / w, wy / w]);
        }
        if (found.length < Math.max(12, marks.length * 0.4)) return null;
        const fit = (use, k) => {
            const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
            for (const f of use) {
                const row = [1, f[0], f[1]];
                for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; b[i] += row[i] * f[k]; }
            }
            for (let i = 0; i < 3; i++) {
                let piv = i;
                for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
                [A[i], A[piv]] = [A[piv], A[i]];
                [b[i], b[piv]] = [b[piv], b[i]];
                if (Math.abs(A[i][i]) < 1e-9) return null;
                for (let r = 0; r < 3; r++) {
                    if (r === i) continue;
                    const g = A[r][i] / A[i][i];
                    for (let c = i; c < 3; c++) A[r][c] -= g * A[i][c];
                    b[r] -= g * b[i];
                }
            }
            return b.map((v, i) => v / A[i][i]);
        };
        let use = found, fx = null, fy = null;
        for (let pass = 0; pass < 2; pass++) {
            fx = fit(use, 2);
            fy = fit(use, 3);
            if (!fx || !fy) return null;
            const kept = found.filter(f => Math.hypot(fx[0] + fx[1] * f[0] + fx[2] * f[1] - f[2], fy[0] + fy[1] * f[0] + fy[2] * f[1] - f[3]) < Math.max(0.8, this.modulePx * 0.25));
            if (kept.length < Math.max(12, marks.length * 0.35)) return null;
            use = kept;
        }
        let moved = 0;
        for (const [x, y] of this.corners) {
            const u = x - cx, v = y - cy;
            moved = Math.max(moved, Math.hypot(fx[0] + fx[1] * u + fx[2] * v, fy[0] + fy[1] * u + fy[2] * v));
        }
        if (moved < 0.2) return moved; // nothing worth moving
        const shift = (arr) => {
            for (let k = 0; k < arr.length; k += 2) {
                const u = arr[k] - cx, v = arr[k + 1] - cy;
                arr[k] += fx[0] + fx[1] * u + fx[2] * v;
                arr[k + 1] += fy[0] + fy[1] * u + fy[2] * v;
            }
        };
        shift(this.positions);
        for (const q of marks) shift(q);
        this.corners = this.corners.map(([x, y]) => {
            const u = x - cx, v = y - cy;
            return [x + fx[0] + fx[1] * u + fx[2] * v, y + fy[0] + fy[1] * u + fy[2] * v];
        });
        return moved;
    }

    // Same as sample(), but from a brightness (Y) plane: Y[(y - oy) * stride + (x - ox)]
    sampleY(Y, stride, rows, ox, oy) {
        const pos = this.positions;
        const n = pos.length / 2;
        const out = new Float32Array(n);
        // with enough camera pixels per square, average a small window (less noise, and it evens
        // out the dark gaps between the screen's own pixels)
        const r = this.modulePx >= 4 ? Math.floor(this.modulePx * 0.25) : 0;
        if (r > 0) {
            const inv = 1 / ((2 * r + 1) * (2 * r + 1));
            for (let j = 0; j < n; j++) {
                const x = Math.floor(pos[j * 2]) - ox, y = Math.floor(pos[j * 2 + 1]) - oy;
                if (x < r || y < r || x >= stride - r || y >= rows - r) { out[j] = 128; continue; }
                let v = 0;
                for (let yy = y - r; yy <= y + r; yy++) {
                    const o = yy * stride + x;
                    for (let k = o - r; k <= o + r; k++) v += Y[k];
                }
                out[j] = v * inv;
            }
            return out;
        }
        for (let j = 0; j < n; j++) {
            const x = Math.floor(pos[j * 2]) - ox, y = Math.floor(pos[j * 2 + 1]) - oy;
            out[j] = x >= 0 && y >= 0 && x < stride && y < rows ? Y[y * stride + x] : 128;
        }
        return out;
    }

    // Red, green, blue per point (interleaved), from an RGBA picture
    sampleRGB(img, ox = 0, oy = 0) {
        const { width: W, height: H, data } = img;
        const pos = this.positions, n = pos.length / 2;
        const out = new Float32Array(n * 3);
        for (let j = 0; j < n; j++) {
            const x = Math.floor(pos[j * 2]) - ox, y = Math.floor(pos[j * 2 + 1]) - oy;
            if (x < 0 || y < 0 || x >= W || y >= H) { out[j * 3] = out[j * 3 + 1] = out[j * 3 + 2] = 128; continue; }
            const k = (y * W + x) * 4;
            out[j * 3] = data[k]; out[j * 3 + 1] = data[k + 1]; out[j * 3 + 2] = data[k + 2];
        }
        return out;
    }

    // Red, green, blue per point from a camera frame's planes (I420: Y, U, V; NV12: Y, UV).
    // Colour is stored at half resolution, so each point takes the chroma of its 2x2 block.
    // The crop origin (ox, oy) must be even.
    sampleYUV(buf, layout, format, rows, ox, oy) {
        const pos = this.positions, n = pos.length / 2;
        const out = new Float32Array(n * 3);
        const Y = layout[0], nv12 = format === 'NV12';
        const U = layout[1], V = nv12 ? layout[1] : layout[2];
        // With enough camera pixels per square, average a window: up close the camera sees the
        // screen's red, green and blue stripes one by one, and only their mix is the square's colour
        const r = this.modulePx >= 4 ? Math.round(this.modulePx * 0.3) : 0;
        if (r > 0) {
            for (let j = 0; j < n; j++) {
                const x = Math.floor(pos[j * 2]) - ox, y = Math.floor(pos[j * 2 + 1]) - oy;
                if (x < r || y < r || x >= Y.stride - r || y >= rows - r) { out[j * 3] = out[j * 3 + 1] = out[j * 3 + 2] = 128; continue; }
                let yy = 0, u = 0, v = 0, ny = 0, nc = 0;
                for (let b = y - r; b <= y + r; b++) {
                    const o = Y.offset + b * Y.stride;
                    for (let a = x - r; a <= x + r; a++) { yy += buf[o + a]; ny++; }
                }
                for (let b = (y - r) >> 1; b <= (y + r) >> 1; b++) {
                    for (let a = (x - r) >> 1; a <= (x + r) >> 1; a++) {
                        if (nv12) { const k = U.offset + b * U.stride + a * 2; u += buf[k]; v += buf[k + 1]; }
                        else { u += buf[U.offset + b * U.stride + a]; v += buf[V.offset + b * V.stride + a]; }
                        nc++;
                    }
                }
                yy /= ny;
                u = u / nc - 128;
                v = v / nc - 128;
                out[j * 3] = yy + 1.402 * v;
                out[j * 3 + 1] = yy - 0.344 * u - 0.714 * v;
                out[j * 3 + 2] = yy + 1.772 * u;
            }
            return out;
        }
        const cols = Y.stride;
        for (let j = 0; j < n; j++) {
            const x = Math.floor(pos[j * 2]) - ox, y = Math.floor(pos[j * 2 + 1]) - oy;
            if (x < 0 || y < 0 || x >= cols || y >= rows) { out[j * 3] = out[j * 3 + 1] = out[j * 3 + 2] = 128; continue; }
            const yy = buf[Y.offset + y * Y.stride + x];
            const cx = x >> 1, cy = y >> 1;
            let u, v;
            if (nv12) { const k = U.offset + cy * U.stride + cx * 2; u = buf[k] - 128; v = buf[k + 1] - 128; }
            else { u = buf[U.offset + cy * U.stride + cx] - 128; v = buf[V.offset + cy * V.stride + cx] - 128; }
            out[j * 3] = yy + 1.402 * v;
            out[j * 3 + 1] = yy - 0.344 * u - 0.714 * v;
            out[j * 3 + 2] = yy + 1.772 * u;
        }
        return out;
    }

    corr(lum, values, subset) {
        let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        const each = j => { const x = lum[j], y = values[j]; n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; };
        if (subset) for (const j of subset) each(j); else for (let j = 0; j < lum.length; j++) each(j);
        const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
        return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
    }

    // Analyse one picture. candidates: frame numbers it could be showing.
    analyze(img, candidates) {
        const lum = this.sample(img);
        // Which frame is this? Quick correlation on the probe subset, then confirm on everything
        let best = null, bestR = -1;
        const scored = [];
        for (const k of candidates) {
            const r = this.corr(lum, this.values(k), this.probe);
            scored.push([k, r]);
            if (r > bestR) { bestR = r; best = k; }
        }
        if (best === null || bestR < 0.25) return { found: false, bestR };
        const values = this.values(best);
        const rAll = this.corr(lum, values);

        // Per tile: is it the same frame as the whole (a torn picture has different frames in
        // different tiles), and how many squares are misread using calibration from the
        // other half of the tile's squares (checkerboard split, so every square is tested once)
        const T = this.tiles * this.tiles, L = this.L;
        const neighbours = [best - 1, best + 1];
        let torn = false;
        let symbolErrors = 0, bitErrors = 0, tested = 0;
        const levelSum = new Float64Array(L), levelSq = new Float64Array(L), levelN = new Float64Array(L);
        for (let t = 0; t < T; t++) {
            // calibrate on parity 0, test parity 1, then the other way round
            for (let pass = 0; pass < 2; pass++) {
                const mean = new Float64Array(L), cnt = new Float64Array(L);
                for (let j = 0; j < lum.length; j++) {
                    if (this.tileOf[j] !== t || this.parity[j] !== pass) continue;
                    mean[values[j]] += lum[j];
                    cnt[values[j]]++;
                }
                for (let v = 0; v < L; v++) mean[v] = cnt[v] ? mean[v] / cnt[v] : NaN;
                for (let j = 0; j < lum.length; j++) {
                    if (this.tileOf[j] !== t || this.parity[j] === pass) continue;
                    let est = 0, bd = Infinity;
                    for (let v = 0; v < L; v++) {
                        const d = Math.abs(lum[j] - mean[v]);
                        if (d < bd) { bd = d; est = v; }
                    }
                    tested++;
                    if (est !== values[j]) {
                        symbolErrors++;
                        bitErrors += popcount(gray(est) ^ gray(values[j]));
                    }
                }
            }
            // tear check: does a neighbouring frame fit this tile better?
            const idx = [];
            for (let j = 0; j < lum.length; j += 3) if (this.tileOf[j] === t) idx.push(j);
            const own = this.corr(lum, values, idx);
            for (const k of neighbours) {
                if (k < 0) continue;
                if (this.corr(lum, this.values(k), idx) > own + 0.05) torn = true;
            }
        }
        for (let j = 0; j < lum.length; j++) {
            const v = values[j];
            levelSum[v] += lum[j];
            levelSq[v] += lum[j] * lum[j];
            levelN[v]++;
        }
        // A blended picture correlates with both neighbouring frames at once
        const second = Math.max(...scored.filter(([k]) => Math.abs(k - best) === 1).map(([, r]) => r), 0);
        return {
            found: true, k: best, r: rAll, second, torn,
            ser: symbolErrors / tested,
            ber: bitErrors / (tested * Math.log2(L)),
            levels: Array.from({ length: L }, (_, v) => {
                const m = levelSum[v] / levelN[v];
                return { mean: m, sd: Math.sqrt(Math.max(0, levelSq[v] / levelN[v] - m * m)) };
            }),
        };
    }
}

// How well the 9x9 finder pattern (dark core, white ring, dark ring, white ring) fits at (x, y)
// with squares px wide: correlation, -1..1. Each square is the average of a few points.
function finderCorrelation(img, x, y, px) {
    const { width: W, height: H, data } = img;
    const q = px * 0.22;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
            const cx = x + dx * px, cy = y + dy * px;
            let v = 0, c = 0;
            for (let k = 0; k < 4; k++) {
                const xi = Math.floor(cx + (k & 1 ? q : -q)), yi = Math.floor(cy + (k & 2 ? q : -q));
                if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
                v += data[(yi * W + xi) * 4 + 1];
                c++;
            }
            if (!c) continue;
            v /= c;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            const want = d === 2 || d === 4 ? 1 : 0;
            n++; sx += v; sy += want; sxx += v * v; syy += want * want; sxy += v * want;
        }
    }
    if (n < 70) return -1;
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    return vx > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : -1;
}

// Best finder fit near (x, y): small shifts and sizes around the estimate
function matchFinder(img, x, y, px) {
    let best = { x, y, px, r: -2 };
    for (const scale of [0.85, 0.92, 1, 1.08]) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const r = finderCorrelation(img, x + dx * px * 0.4, y + dy * px * 0.4, px * scale);
                if (r > best.r) best = { x: x + dx * px * 0.4, y: y + dy * px * 0.4, px: px * scale, r };
            }
        }
    }
    return best;
}

// The picture's brightness (green) averaged over (2r+1) x (2r+1) pixels, as an RGBA picture
function blurLum(img, r) {
    const { width: W, height: H, data } = img;
    const tmp = new Float32Array(W * H), out = new Uint8ClampedArray(W * H * 4);
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let v = 0;
            for (let k = -r; k <= r; k++) v += data[(y * W + Math.min(W - 1, Math.max(0, x + k))) * 4 + 1];
            tmp[y * W + x] = v * inv;
        }
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let v = 0;
            for (let k = -r; k <= r; k++) v += tmp[Math.min(H - 1, Math.max(0, y + k)) * W + x];
            const o = (y * W + x) * 4;
            out[o] = out[o + 1] = out[o + 2] = v * inv;
            out[o + 3] = 255;
        }
    }
    return { data: out, width: W, height: H };
}

// Centre of a finder square near (x, y): mean-shift on the darkest pixels within the 3×3 core.
// px = approximate pixels per square.
function refineFinderCentre(img, x, y, px) {
    const { width: W, height: H, data } = img;
    const lumAt = (xx, yy) => data[(yy * W + xx) * 4 + 1];
    // local black and white levels from a window covering the whole finder
    const R = Math.ceil(px * 4.5);
    let lo = 255, hi = 0;
    for (let yy = Math.max(0, Math.floor(y - R)); yy < Math.min(H, y + R); yy += 2) {
        for (let xx = Math.max(0, Math.floor(x - R)); xx < Math.min(W, x + R); xx += 2) {
            const v = lumAt(xx, yy);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
    }
    if (hi - lo < 30) return null;
    const thr = (lo + hi) / 2;
    let cx = x, cy = y;
    const r = px * 1.6; // the core is 3 squares wide; the white ring starts 1.5 squares out
    for (let it = 0; it < 6; it++) {
        let sw = 0, sx = 0, sy = 0;
        for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(H - 1, Math.ceil(cy + r)); yy++) {
            for (let xx = Math.max(0, Math.floor(cx - r)); xx <= Math.min(W - 1, Math.ceil(cx + r)); xx++) {
                const w = thr - lumAt(xx, yy);
                if (w <= 0) continue;
                sw += w; sx += w * (xx + 0.5); sy += w * (yy + 0.5);
            }
        }
        if (!sw) return null;
        const nx = sx / sw, ny = sy / sw;
        const moved = Math.hypot(nx - cx, ny - cy);
        cx = nx;
        cy = ny;
        if (moved < 0.05) break;
    }
    return [cx, cy];
}

// Perspective transform taking 4 source points to 4 destination points (solves the 8×8 system)
function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
        const [x, y] = src[i], [u, v] = dst[i];
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    // Gaussian elimination with partial pivoting
    for (let c = 0; c < 8; c++) {
        let p = c;
        for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]];
        [b[c], b[p]] = [b[p], b[c]];
        for (let r = 0; r < 8; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    return b.map((v, i) => v / A[i][i]);
}

function applyH(h, x, y) {
    const w = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

// Look for a finder pattern (dark-light-dark×3-light-dark, ratio 1:1:3:1:1, about 7 squares wide)
// within `radius` pixels of (x0, y0) on the binarized image, checked horizontally and vertically.
// Returns the candidate closest to (x0, y0), skipping ones at known finders.
function findFinderNear(matrix, x0, y0, px, radius, known) {
    const W = matrix.width, H = matrix.height;
    const get = (x, y) => matrix.get(x, y);
    const ratioOk = (runs) => {
        const total = runs.reduce((a, b) => a + b, 0);
        if (total < px * 7 * 0.5 || total > px * 7 * 1.6) return false;
        const u = total / 7;
        const want = [1, 1, 3, 1, 1];
        return runs.every((r, i) => Math.abs(r - want[i] * u) < u * want[i] * 0.6 + 1);
    };
    // runs along a line through (x, y): returns [start, runs] centred on the run containing (x, y)
    const verticalCheck = (x, y) => {
        if (!get(x, y)) return null;
        let up = y; while (up > 0 && get(x, up - 1)) up--;
        let down = y; while (down < H - 1 && get(x, down + 1)) down++;
        const runs = [down - up + 1];
        // above: light, dark
        let p = up - 1, a1 = 0; while (p >= 0 && !get(x, p)) { a1++; p--; }
        let a2 = 0; while (p >= 0 && get(x, p)) { a2++; p--; }
        p = down + 1; let b1 = 0; while (p < H && !get(x, p)) { b1++; p++; }
        let b2 = 0; while (p < H && get(x, p)) { b2++; p++; }
        if (!ratioOk([a2, a1, runs[0], b1, b2])) return null;
        return (up + down) / 2 + 0.5;
    };
    const found = [];
    const yMin = Math.max(0, Math.floor(y0 - radius)), yMax = Math.min(H - 1, Math.ceil(y0 + radius));
    const xMin = Math.max(0, Math.floor(x0 - radius)), xMax = Math.min(W - 1, Math.ceil(x0 + radius));
    for (let y = yMin; y <= yMax; y++) {
        // run-length encode this row segment
        const runs = [], starts = [];
        let x = xMin, cur = get(x, y), len = 0, start = x;
        for (; x <= xMax; x++) {
            const v = get(x, y);
            if (v === cur) { len++; continue; }
            runs.push([cur, len]); starts.push(start);
            cur = v; len = 1; start = x;
        }
        runs.push([cur, len]); starts.push(start);
        for (let i = 0; i + 4 < runs.length; i++) {
            if (!runs[i][0]) continue; // must start dark
            const r = runs.slice(i, i + 5).map(q => q[1]);
            if (!ratioOk(r)) continue;
            const cx = starts[i + 2] + r[2] / 2;
            const cy = verticalCheck(Math.floor(cx), y);
            if (cy === null) continue;
            found.push([cx, cy]);
        }
    }
    if (!found.length) return null;
    // cluster: average candidates near each other, ignore clusters at known finders
    const clusters = [];
    for (const p of found) {
        const c = clusters.find(c => Math.hypot(c.x / c.n - p[0], c.y / c.n - p[1]) < px * 2);
        if (c) { c.x += p[0]; c.y += p[1]; c.n++; } else clusters.push({ x: p[0], y: p[1], n: 1 });
    }
    const cands = clusters
        .map(c => ({ x: c.x / c.n, y: c.y / c.n, n: c.n }))
        .filter(c => c.n >= 2 && !known.some(k => Math.hypot(k.x - c.x, k.y - c.y) < px * 4));
    if (!cands.length) return null;
    // A real finder is hit on many scan lines (its whole 3-square core); look-alikes in random
    // data on only a few. Take the strongest, closest breaking ties.
    cands.sort((a, b) => (b.n - a.n) || (Math.hypot(a.x - x0, a.y - y0) - Math.hypot(b.x - x0, b.y - y0)));
    return [cands[0].x, cands[0].y];
}

// All finder patterns in a binarized picture, strongest first: {x, y, n (lines hit), size (px)}
function findFinders(matrix) {
    const W = matrix.width, H = matrix.height;
    const get = (x, y) => matrix.get(x, y);
    const ratioOk = (runs) => {
        const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
        if (total < 10) return false;
        const u = total / 7;
        // thin runs blur and threshold unevenly, so they get a loose check; the centre must be
        // clearly wider than the rest (that's what rules out the 1:1:1:1:1 alignment marks)
        const thin = (r) => Math.abs(r - u) < u * 0.75 + 0.5;
        return thin(runs[0]) && thin(runs[1]) && thin(runs[3]) && thin(runs[4]) &&
            runs[2] > 2 * u && runs[2] < 4.2 * u + 1;
    };
    const vertical = (x, y) => {
        if (!get(x, y)) return null;
        let up = y; while (up > 0 && get(x, up - 1)) up--;
        let down = y; while (down < H - 1 && get(x, down + 1)) down++;
        let p = up - 1, a1 = 0; while (p >= 0 && !get(x, p)) { a1++; p--; }
        let a2 = 0; while (p >= 0 && get(x, p)) { a2++; p--; }
        p = down + 1; let b1 = 0; while (p < H && !get(x, p)) { b1++; p++; }
        let b2 = 0; while (p < H && get(x, p)) { b2++; p++; }
        const runs = [a2, a1, down - up + 1, b1, b2];
        return ratioOk(runs) ? { cy: (up + down + 1) / 2, size: runs.reduce((a, b) => a + b, 0) } : null;
    };
    const hits = [];
    const runs = new Int32Array(W + 1), starts = new Int32Array(W + 1), colors = new Uint8Array(W + 1);
    for (let y = 0; y < H; y++) {
        let n = 0, cur = get(0, y) ? 1 : 0, start = 0;
        for (let x = 1; x <= W; x++) {
            const v = x < W ? (get(x, y) ? 1 : 0) : 2;
            if (v === cur) continue;
            colors[n] = cur; starts[n] = start; runs[n] = x - start; n++;
            cur = v; start = x;
        }
        for (let i = 0; i + 4 < n; i++) {
            if (!colors[i]) continue;
            const r = [runs[i], runs[i + 1], runs[i + 2], runs[i + 3], runs[i + 4]];
            if (!ratioOk(r)) continue;
            const cx = starts[i + 2] + r[2] / 2;
            const v = vertical(Math.floor(cx), y);
            if (!v) continue;
            const total = r.reduce((a, b) => a + b, 0);
            if (Math.abs(v.size - total) > total * 0.5) continue;
            hits.push([cx, v.cy, (total + v.size) / 2]);
        }
    }
    const clusters = [];
    for (const [x, y, size] of hits) {
        const c = clusters.find(c => Math.hypot(c.x / c.n - x, c.y / c.n - y) < Math.max(3, size / 4));
        if (c) { c.x += x; c.y += y; c.size += size; c.n++; } else clusters.push({ x, y, size, n: 1 });
    }
    return clusters
        .map(c => ({ x: c.x / c.n, y: c.y / c.n, size: c.size / c.n, n: c.n }))
        .filter(c => c.n >= 3)
        .sort((a, b) => b.n - a.n);
}
