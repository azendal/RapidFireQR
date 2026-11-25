// fountain.js - systematic fountain code over GF(2)
//
// The sender splits the data into K blocks and emits an endless stream of droplets:
//   droplet 0 .. K-1  carry block 0 .. K-1 as they are (systematic part),
//   droplet K ..      each carry the XOR of a random set of blocks (repair part): half of them
//                     for small files, 64 or 256 of them for big ones (see dropletCoefficients).
// The receiver solves the droplets it has caught with incremental Gaussian elimination,
// so it needs about K + 2 useful droplets no matter which ones it missed.
//
// Packet layout (big-endian):
//   [0..1]  transfer id (uint16)
//   [2..4]  total data length in bytes (uint24, up to 16 MB)
//   [5..7]  droplet id (uint24)
//   [8.. ]  payload, chunkSize bytes (chunkSize = packet length - 8)

export const HEADER_BYTES = 8;
const MAX_LENGTH = 0xFFFFFF;
const ID_MASK = 0xFFFFFF;

// Deterministic 32-bit PRNG (mulberry32)
function mulberry32(a) {
    return function () {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return (t ^ t >>> 14) >>> 0;
    };
}

// Which blocks a droplet combines, as a bitset of K bits (Uint32Array of ceil(K/32) words).
export function dropletCoefficients(dropletId, K) {
    const words = Math.ceil(K / 32);
    const bits = new Uint32Array(words);
    if (dropletId < K) {
        bits[dropletId >>> 5] = 1 << (dropletId & 31);
        return bits;
    }
    const rand = mulberry32(dropletId * 0x9E3779B1);
    if (K > 600) {
        // Half of a big file's blocks is thousands of XORs per droplet, on both ends. A mix of 64
        // and 256 blocks needs at most a handful more droplets (0-12 of 4300 in simulations with
        // 3-60% loss): the bigger ones make sure the last few missing blocks get covered.
        const degree = (rand() >>> 31) ? 64 : 256;
        for (let d = 0; d < degree; d++) {
            const i = rand() % K;
            bits[i >>> 5] |= 1 << (i & 31);
        }
        return bits;
    }
    for (let w = 0; w < words; w++) bits[w] = rand();
    const tail = K & 31;
    if (tail) bits[words - 1] &= (1 << tail) - 1;
    let empty = true;
    for (let w = 0; w < words; w++) if (bits[w]) { empty = false; break; }
    if (empty) {
        const i = dropletId % K;
        bits[i >>> 5] = 1 << (i & 31);
    }
    return bits;
}

function paddedLength(n) {
    return (n + 3) & ~3;
}

export class FountainEncoder {
    // maxChunkSize: the most payload bytes one droplet may carry.
    // Blocks are sized evenly so a short payload makes small frames.
    constructor(dataBytes, maxChunkSize, transferId = null) {
        if (dataBytes.length > MAX_LENGTH) throw new Error('Payload too large (16 MB max)');
        this.totalLength = dataBytes.length;
        this.K = Math.max(1, Math.ceil(this.totalLength / maxChunkSize));
        this.chunkSize = Math.max(1, Math.ceil(this.totalLength / this.K));
        this.transferId = transferId !== null ? transferId : Math.floor(Math.random() * 65536);

        const padded = paddedLength(this.chunkSize);
        this.chunks = [];
        for (let i = 0; i < this.K; i++) {
            const chunk = new Uint8Array(padded);
            const start = i * this.chunkSize;
            chunk.set(dataBytes.subarray(start, Math.min(start + this.chunkSize, this.totalLength)));
            this.chunks.push(new Uint32Array(chunk.buffer));
        }
        this.nextId = 0;
        this.lastId = -1;
    }

    get packetSize() {
        return HEADER_BYTES + this.chunkSize;
    }

    nextDroplet() {
        const id = this.nextId;
        this.nextId = (this.nextId + 1) & ID_MASK;
        this.lastId = id;

        const bits = dropletCoefficients(id, this.K);
        const acc = new Uint32Array(this.chunks[0].length);
        for (let i = 0; i < this.K; i++) {
            if (bits[i >>> 5] & (1 << (i & 31))) {
                const block = this.chunks[i];
                for (let j = 0; j < acc.length; j++) acc[j] ^= block[j];
            }
        }

        const packet = new Uint8Array(HEADER_BYTES + this.chunkSize);
        packet[0] = this.transferId >>> 8;
        packet[1] = this.transferId & 0xFF;
        packet[2] = this.totalLength >>> 16;
        packet[3] = (this.totalLength >>> 8) & 0xFF;
        packet[4] = this.totalLength & 0xFF;
        packet[5] = id >>> 16;
        packet[6] = (id >>> 8) & 0xFF;
        packet[7] = id & 0xFF;
        packet.set(new Uint8Array(acc.buffer, 0, this.chunkSize), HEADER_BYTES);
        return packet;
    }
}

export function readHeader(packet) {
    if (packet.length < HEADER_BYTES + 1) return null;
    return {
        transferId: (packet[0] << 8) | packet[1],
        totalLength: (packet[2] << 16) | (packet[3] << 8) | packet[4],
        dropletId: (packet[5] << 16) | (packet[6] << 8) | packet[7],
        chunkSize: packet.length - HEADER_BYTES,
    };
}

function xorInto(a, b) {
    for (let k = 0; k < a.length; k++) a[k] ^= b[k];
}

export class FountainDecoder {
    constructor() {
        this.reset();
    }

    reset() {
        this.transferId = null;
        this.K = null;
        this.totalLength = null;
        this.chunkSize = null;
        this.pivots = [];          // pivots[col] = { bits: Uint32Array | null (null: exactly this block), data } | null
        this.solvedCount = 0;      // rank of the system: how many blocks are pinned down
        this.receivedCount = 0;    // distinct droplets read
        this.isDone = false;
        this.seenIds = new Set();
        this.blocks = null;
    }

    // Returns true when the droplet added new information.
    addDroplet(packet) {
        const h = readHeader(packet);
        if (!h) return false;

        const sameTransfer = this.transferId === h.transferId
            && this.totalLength === h.totalLength
            && this.chunkSize === h.chunkSize;
        if (this.transferId !== null && !sameTransfer) this.reset();

        if (this.isDone) return false;
        if (this.seenIds.has(h.dropletId)) return false;
        this.seenIds.add(h.dropletId);
        this.receivedCount++;

        if (this.K === null) {
            this.transferId = h.transferId;
            this.totalLength = h.totalLength;
            this.chunkSize = h.chunkSize;
            this.K = Math.max(1, Math.ceil(h.totalLength / h.chunkSize));
            this.pivots = new Array(this.K).fill(null);
        }

        const bits = dropletCoefficients(h.dropletId, this.K);
        const bytes = new Uint8Array(paddedLength(this.chunkSize));
        bytes.set(packet.subarray(HEADER_BYTES));
        const data = new Uint32Array(bytes.buffer);

        // Reduce the row. Blocks already known outright (unit pivots, data: the block itself) are
        // removed wherever they appear, so stored rows only ever mention blocks that were missing:
        // a big file's last step would otherwise mix thousands of known blocks into each row.
        // Other pivots are eliminated from the lowest column up until the first missing column,
        // which becomes this row's pivot.
        const words = bits.length;
        let lead = -1;
        for (let w = 0; w < words; w++) {
            let todo = bits[w];
            while (todo) {
                const low = todo & -todo;
                const col = (w << 5) + (31 - Math.clz32(low));
                const pivot = this.pivots[col];
                if (pivot && !pivot.bits) {
                    bits[w] ^= low;
                    xorInto(data, pivot.data);
                    todo ^= low;
                } else if (pivot && lead < 0) {
                    for (let k = w; k < words; k++) bits[k] ^= pivot.bits[k];
                    xorInto(data, pivot.data);
                    // the pivot's own column is clear now; others in this word may have appeared
                    todo = low === -2147483648 || low === 0x80000000 ? 0 : bits[w] & ~((low << 1) - 1);
                } else {
                    if (lead < 0) lead = col;
                    todo ^= low;
                }
            }
        }
        if (lead < 0) return false; // nothing new: a combination of droplets already held
        let single = true;
        for (let w = 0; w < words && single; w++) {
            const want = w === lead >>> 5 ? (1 << (lead & 31)) | 0 : 0;
            if ((bits[w] | 0) !== want) single = false;
        }
        this.pivots[lead] = { bits: single ? null : bits, data };
        this.solvedCount++;
        if (this.solvedCount === this.K) this.finish();
        return true;
    }

    // Back-substitution: clear every column above each pivot, highest pivot first.
    finish() {
        for (let col = this.K - 1; col >= 0; col--) {
            const row = this.pivots[col];
            if (!row.bits) continue;
            for (let w = col >>> 5; w < row.bits.length; w++) {
                let todo = row.bits[w];
                if (w === col >>> 5) todo &= (col & 31) === 31 ? 0 : -1 << ((col & 31) + 1); // above col only
                while (todo) {
                    const low = todo & -todo;
                    todo ^= low;
                    xorInto(row.data, this.pivots[(w << 5) + (31 - Math.clz32(low))].data);
                }
            }
            row.bits = null;
        }
        this.blocks = this.pivots.map(p => new Uint8Array(p.data.buffer, 0, this.chunkSize));
        this.isDone = true;
    }

    getProgress() {
        if (!this.K) return 0;
        return Math.min(100, Math.round((this.solvedCount / this.K) * 100));
    }

    getRecoveredData() {
        if (!this.isDone) return null;
        const full = new Uint8Array(this.totalLength);
        for (let i = 0; i < this.K; i++) {
            const start = i * this.chunkSize;
            const n = Math.min(this.chunkSize, this.totalLength - start);
            if (n > 0) full.set(this.blocks[i].subarray(0, n), start);
        }
        return full;
    }
}
