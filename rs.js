// rs.js - fast Reed-Solomon decoding for RapidFire codewords (GF(256), polynomial 0x11D,
// roots alpha^0 .. alpha^(n-1): the same code qr.js's rsEncode makes, and QR codes use).
//
// Built for the receiver's hot path: most codewords arrive clean, so the syndromes are computed
// with one table lookup per byte and per check symbol, and a clean codeword returns at once.
// A damaged one goes through Berlekamp-Massey, a Chien search and Forney's formula.
// Erasures (positions known to be doubtful) are optional: a code with n check symbols fixes
// e erasures plus t errors whenever e + 2t <= n, so naming the doubtful bytes doubles what it fixes.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const inv = (a) => EXP[255 - LOG[a]];

// MUL_BY_ALPHA[j] is the multiplication table by alpha^j (256 entries each)
const rows = [];
function mulRow(j) {
    if (!rows[j]) {
        const row = new Uint8Array(256);
        const lj = j % 255;
        for (let v = 1; v < 256; v++) row[v] = EXP[LOG[v] + lj];
        rows[j] = row;
    }
    return rows[j];
}

// Polynomials below are arrays of coefficients, lowest degree first.
function evalPoly(p, x) {
    let y = 0;
    for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
    return y;
}

const stats = { clean: 0, fixed: 0, failed: 0 };
export function rsStats() { return { ...stats }; }

// cw: the received codeword (data then check bytes), nsym: number of check bytes,
// erasures: optional byte indexes in cw that are doubtful. Corrects cw in place.
// Returns cw (corrected) or null if it can't be corrected.
export function rsDecode(cw, nsym, erasures = null) {
    const len = cw.length;
    // syndromes S_j = cw(alpha^j), Horner's rule with one table lookup per byte
    const S = new Uint8Array(nsym);
    let any = 0;
    for (let j = 0; j < nsym; j++) {
        const row = mulRow(j);
        let s = 0;
        for (let i = 0; i < len; i++) s = row[s] ^ cw[i];
        S[j] = s;
        any |= s;
    }
    if (!any) { stats.clean++; return cw; }

    // byte index i holds the coefficient of x^(len-1-i); its locator is alpha^(len-1-i)
    const e = erasures ? Math.min(erasures.length, nsym) : 0;
    let gamma = [1];
    for (let k = 0; k < e; k++) {
        const X = EXP[(len - 1 - erasures[k]) % 255];
        const next = new Array(gamma.length + 1).fill(0);
        for (let i = 0; i < gamma.length; i++) { next[i] ^= gamma[i]; next[i + 1] ^= mul(gamma[i], X); }
        gamma = next;
    }

    // Berlekamp-Massey, started from the erasure locator (errors-and-erasures form)
    let C = gamma.slice(), B = gamma.slice(), L = e, m = 1, b = 1;
    for (let r = e; r < nsym; r++) {
        let d = 0;
        for (let i = 0; i <= L && i < C.length; i++) if (r - i >= 0) d ^= mul(C[i], S[r - i]);
        if (d === 0) { m++; continue; }
        const coef = mul(d, inv(b));
        const T = C.slice();
        const need = B.length + m;
        if (C.length < need) C = C.concat(new Array(need - C.length).fill(0));
        for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
        if (2 * L <= r + e) { L = r + 1 + e - L; B = T; b = d; m = 1; } else m++;
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop();
    const deg = C.length - 1;
    if (deg !== L || 2 * L - e > nsym) { stats.failed++; return null; }

    // Chien search: position p is in error when C(alpha^-p) = 0
    const positions = [];
    for (let p = 0; p < len; p++) {
        if (evalPoly(C, EXP[(255 - (p % 255)) % 255]) === 0) positions.push(p);
    }
    if (positions.length !== deg) { stats.failed++; return null; }

    // Forney: magnitude = X * Omega(X^-1) / C'(X^-1), Omega = S * C mod x^nsym
    const omega = new Uint8Array(nsym);
    for (let i = 0; i < nsym; i++) {
        let v = 0;
        for (let k = 0; k <= i && k < C.length; k++) v ^= mul(C[k], S[i - k]);
        omega[i] = v;
    }
    const dC = []; // formal derivative: odd terms shift down
    for (let i = 1; i < C.length; i++) dC.push(i & 1 ? C[i] : 0);
    const mags = [];
    for (const p of positions) {
        const X = EXP[p % 255], Xi = inv(X);
        const den = evalPoly(dC, Xi);
        if (!den) { stats.failed++; return null; }
        mags.push(mul(X, mul(evalPoly(omega, Xi), inv(den))));
    }
    // only now touch cw, so a failed attempt leaves it as received (callers retry with erasures)
    positions.forEach((p, k) => { cw[len - 1 - p] ^= mags[k]; });
    stats.fixed++;
    return cw;
}
