// base45.js - RFC 9285 Base45. Every character is in the QR alphanumeric set,
// so a QR stores 2 bytes in 16.5 bits (base64 in byte mode needs 21.3).

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const INDEX = new Map([...CHARSET].map((c, i) => [c, i]));

export function base45Encode(bytes) {
    let out = '';
    let i = 0;
    for (; i + 1 < bytes.length; i += 2) {
        let n = bytes[i] * 256 + bytes[i + 1];
        const c = n % 45; n = (n - c) / 45;
        const d = n % 45;
        const e = (n - d) / 45;
        out += CHARSET[c] + CHARSET[d] + CHARSET[e];
    }
    if (i < bytes.length) {
        const n = bytes[i];
        out += CHARSET[n % 45] + CHARSET[Math.floor(n / 45)];
    }
    return out;
}

export function encodedLength(byteCount) {
    return Math.floor(byteCount / 2) * 3 + (byteCount % 2) * 2;
}

// Most bytes that fit in a given number of base45 characters.
export function bytesForChars(charCount) {
    return Math.floor(charCount / 3) * 2 + (charCount % 3 === 2 ? 1 : 0);
}

// Returns null when the text is not valid Base45.
export function base45Decode(text) {
    if (text.length % 3 === 1) return null;
    const out = new Uint8Array(bytesForChars(text.length));
    let o = 0;
    for (let i = 0; i < text.length; i += 3) {
        const c = INDEX.get(text[i]);
        const d = INDEX.get(text[i + 1]);
        if (c === undefined || d === undefined) return null;
        if (i + 2 < text.length) {
            const e = INDEX.get(text[i + 2]);
            if (e === undefined) return null;
            const n = c + d * 45 + e * 2025;
            if (n > 0xFFFF) return null;
            out[o++] = n >>> 8;
            out[o++] = n & 0xFF;
        } else {
            const n = c + d * 45;
            if (n > 0xFF) return null;
            out[o++] = n;
        }
    }
    return out;
}
