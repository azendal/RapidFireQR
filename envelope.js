// envelope.js - wraps the payload before it goes into the fountain code.
//
// Layout:
//   [0]     flags: bit 0 = body is deflate-raw compressed
//   [1..4]  CRC-32 of the ORIGINAL bytes (big-endian), checked after unpacking
//   [5.. ]  body
//
// The checksum is what lets the receiver say "verified": every byte that came out
// matches what went in. Compression is skipped when it doesn't make the data smaller
// (photos, zips, already-compressed files).

export const ENVELOPE_HEADER = 5;
const FLAG_DEFLATE = 1;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function runStream(bytes, stream) {
    const writer = stream.writable.getWriter();
    // Await the writes together with the read so a damaged stream rejects here, once
    const [out] = await Promise.all([
        new Response(stream.readable).arrayBuffer(),
        writer.write(bytes),
        writer.close(),
    ]);
    return new Uint8Array(out);
}

export async function packPayload(original) {
    let body = original;
    let flags = 0;
    if (typeof CompressionStream !== 'undefined') {
        try {
            const compressed = await runStream(original, new CompressionStream('deflate-raw'));
            if (compressed.length < original.length) {
                body = compressed;
                flags |= FLAG_DEFLATE;
            }
        } catch (e) {
            console.warn('Compression failed, sending raw', e);
        }
    }
    const packed = new Uint8Array(ENVELOPE_HEADER + body.length);
    const crc = crc32(original);
    packed[0] = flags;
    packed[1] = crc >>> 24;
    packed[2] = (crc >>> 16) & 0xFF;
    packed[3] = (crc >>> 8) & 0xFF;
    packed[4] = crc & 0xFF;
    packed.set(body, ENVELOPE_HEADER);
    return { packed, compressed: (flags & FLAG_DEFLATE) !== 0 };
}

// Returns { bytes, compressed, verified }. verified is false when the checksum doesn't
// match or the body couldn't be decompressed.
export async function unpackPayload(packed) {
    if (packed.length < ENVELOPE_HEADER) return { bytes: new Uint8Array(0), compressed: false, verified: false };
    const flags = packed[0];
    const expected = ((packed[1] << 24) | (packed[2] << 16) | (packed[3] << 8) | packed[4]) >>> 0;
    const body = packed.subarray(ENVELOPE_HEADER);
    const compressed = (flags & FLAG_DEFLATE) !== 0;
    let bytes = body;
    if (compressed) {
        try {
            bytes = await runStream(body, new DecompressionStream('deflate-raw'));
        } catch (e) {
            console.warn('Decompression failed', e);
            return { bytes: body, compressed, verified: false };
        }
    }
    return { bytes, compressed, verified: crc32(bytes) === expected };
}
