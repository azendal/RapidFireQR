import { FountainEncoder, FountainDecoder } from './fountain.js';

// --- Global State ---
let isSending = false;
let sendInterval = null;
let targetFps = 8;
let encoder = null;
let currentTransferHash = '';
let qrcodeInstance = null;
let autoStopWithCamera = false;
let senderStream = null;
let senderWatcherScanning = false;

window.toggleAckWatcher = function(enabled) {
    autoStopWithCamera = enabled;
};

let decoder = new FountainDecoder();
let videoStream = null;
let currentFacingMode = 'environment';
let isScanning = false;
let receiverAnimId = null;
let barcodeDetector = null;
let lastScannedText = '';
let lastScannedTime = 0;
let frameCount = 0;
let lastFpsTime = performance.now();

// Offscreen canvas for jsQR fallback
const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

// --- High-Efficiency Z85 (Base85) Binary Codec ---
// RFC 1924 / Z85 Alphabet: 85 printable ASCII characters safe for QR codes
const Z85_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
const Z85_MAP = new Uint8Array(256);
for (let i = 0; i < 85; i++) {
    Z85_MAP[Z85_CHARS.charCodeAt(i)] = i;
}

function encodeZ85(bytes) {
    const len = bytes.length;
    const remainder = len % 4;
    const padLen = remainder === 0 ? len : len + (4 - remainder);
    let str = remainder.toString(); // leading digit 0..3 encodes unpadded remainder

    for (let i = 0; i < padLen; i += 4) {
        let val = 0;
        for (let j = 0; j < 4; j++) {
            const b = (i + j < len) ? bytes[i + j] : 0;
            val = (val * 256) + b;
        }
        let div = 52200625; // 85^4
        for (let j = 0; j < 5; j++) {
            const digit = Math.floor(val / div) % 85;
            str += Z85_CHARS[digit];
            div = Math.floor(div / 85);
        }
    }
    return str;
}

function decodeZ85(str) {
    const remainder = parseInt(str[0], 10);
    const dataStr = str.slice(1);
    const strLen = dataStr.length;
    const numBlocks = Math.floor(strLen / 5);
    const fullLen = numBlocks * 4;
    const finalLen = remainder === 0 ? fullLen : fullLen - (4 - remainder);
    const out = new Uint8Array(finalLen);

    let outIdx = 0;
    for (let i = 0; i < strLen; i += 5) {
        let val = 0;
        for (let j = 0; j < 5; j++) {
            val = (val * 85) + Z85_MAP[dataStr.charCodeAt(i + j)];
        }
        for (let j = 0; j < 4; j++) {
            const shift = (3 - j) * 8;
            const b = (val >>> shift) & 0xFF;
            if (outIdx < finalLen) {
                out[outIdx++] = b;
            }
        }
    }
    return out;
}

// Fallback Base64 for legacy format compatibility
function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToUint8(base64) {
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Compress data using browser-native GZIP/Deflate
async function compressData(uint8Array) {
    if ('CompressionStream' in window) {
        try {
            const cs = new CompressionStream('deflate-raw');
            const writer = cs.writable.getWriter();
            writer.write(uint8Array);
            writer.close();
            const response = new Response(cs.readable);
            const arrayBuffer = await response.arrayBuffer();
            return new Uint8Array(arrayBuffer);
        } catch (e) {
            console.warn('Compression failed, falling back to raw', e);
        }
    }
    return uint8Array;
}

// Decompress data
async function decompressData(uint8Array) {
    if ('DecompressionStream' in window) {
        try {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(uint8Array);
            writer.close();
            const response = new Response(ds.readable);
            const arrayBuffer = await response.arrayBuffer();
            return new Uint8Array(arrayBuffer);
        } catch (e) {
            console.warn('Decompression failed, using raw', e);
        }
    }
    return uint8Array;
}

// Simple fast string hash
function quickHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16);
}

// --- Presets for Testing ---
window.loadPreset = function(type) {
    let sample = '';
    if (type === 'small') {
        sample = JSON.stringify({
            protocol: "RapidFire-QR",
            status: "connected",
            device_sender: "PC-Workstation",
            timestamp: new Date().toISOString(),
            auth_token: "a8f9c0e4b2d18723",
            message: "Optical air-gap handshake successful!"
        }, null, 2);
    } else if (type === 'medium') {
        sample = `=== PROJECT MISSION LOG ===\nSystem: RapidFire Optical Data Bridge\nTarget: Air-Gapped Node Transfer\n\n[SUMMARY]\nThis transmission demonstrates rateless erasure fountain codes (Luby Transform).\nTraditional protocols fail when optical frames are dropped due to camera motion blur,\nexposure shifts, or screen refresh sync issues.\n\nWith rateless fountain codes:\n1. Sender splits data into K equal-size chunks.\n2. An infinite stream of pseudo-randomly XOR-combined droplets is emitted.\n3. The receiver only needs any K + epsilon droplets to solve the linear system.\n4. Dropped frames cause zero stalls.\n\nTransfer test completed successfully. All blocks verified with zero data corruption.`;
    } else if (type === 'large') {
        const line = "The quick brown fox jumps over the lazy dog 0123456789. Optical fountain codes allow robust transmission.\n";
        sample = "=== BULK PAYLOAD BENCHMARK ===\n" + line.repeat(40) + `\n[CHECKSUM: ${quickHash(line)}]`;
    } else if (type === 'heavy') {
        const keyRing = "-----BEGIN ED25519 PUBLIC KEY RING (AIR-GAP VERIFIED)-----\n" +
            "Block-001: MC4CAQAwBQYDK2VwBCIEIP8kL9s2WvM7uR4qT1yO8xP3nL6mK5jH0gF4eD3bA2c1\n" +
            "Block-002: MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7rV8X2mP9qK3yT5nL1oJ4hG6fD8s\n" +
            "Block-003: bA1cE3gH5jK7mN9pQ2rT4vW6xZ8aC0bE2dG4iK6mO8qS0uW2yA4cE6gI8kM0oQ2s\n" +
            "Block-004: T4vW6xZ8aC0bE2dG4iK6mO8qS0uW2yA4cE6gI8kM0oQ2sT4vW6xZ8aC0bE2dG4iK\n" +
            "Block-005: 9a7b5c3d1e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b\n" +
            "-----END ED25519 PUBLIC KEY RING-----\n";

        const telemetry = JSON.stringify({
            mission_manifest: {
                mission_id: "APOLLO-AIRGAP-2026",
                clearance_level: "RESTRICTED",
                checkpoints: Array.from({ length: 15 }, (_, i) => ({
                    seq: 100 + i,
                    node: `Relay-Station-Node-${i}`,
                    rssi: -30 - (i * 2),
                    status: i % 2 === 0 ? "NOMINAL" : "OPTIMAL",
                    signature: quickHash(`node_${i}_telemetry_verification`)
                }))
            }
        }, null, 2);

        const pangrams = [
            "Line 01: The quick brown fox jumps over the lazy dog. 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "Line 02: Pack my box with five dozen liquor jugs. 9876543210 abcdefghijklmnopqrstuvwxyz",
            "Line 03: Jackdaws love my big sphinx of quartz. 1357924680 !@#$%^&*()_+{}[]:;\"'<>?,./",
            "Line 04: The five boxing wizards jump quickly. ~`-=|\\ 01010101010101010101010101010101",
            "Line 05: How vexingly quick daft zebras jump! 0xFF 0x00 0xAA 0x55 0xDE 0xAD 0xBE 0xEF",
            "Line 06: Bright vixens jump; dozy fowl quack. UTF-8 check: α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π",
            "Line 07: Quick zephyrs blow, vexing daft Jim. Extended symbols: ∑ ∫ ∏ √ ∞ ≈ ≠ ≤ ≥ ⊕ ⊗ ⊥ ∇"
        ].join("\n");

        sample = `# ==============================================================================\n` +
            `# RAPIDFIRE OPTICAL AIR-GAP PROTOCOL: HEAVY TRANSMISSION BENCHMARK (V2.4)\n` +
            `# Timestamp: ${new Date().toISOString()}\n` +
            `# Target: High-Density Fountain Erasure Channel\n` +
            `# ==============================================================================\n\n` +
            `## 1. ABSTRACT & THREAT MODEL\nOptical air-gapped data diodes eliminate electromagnetic emanations (TEMPEST) and network-layer exploitation vectors by enforcing a strictly visual transmission channel.\n\n` +
            `## 2. SYNTHETIC CRYPTOGRAPHIC KEYRING\n${keyRing}\n\n` +
            `## 3. COMPLEX STRUCTURED TELEMETRY DATA\n${telemetry}\n\n` +
            `## 4. TRANSMISSION INTEGRITY & PARITY PATTERN\n${pangrams}\n\n` +
            `# ==============================================================================\n` +
            `# END OF BENCHMARK TRANSMISSION\n` +
            `# ==============================================================================`;
    } else if (type === '50kb') {
        const lines = ['# RAPIDFIRE 50KB BENCHMARK DATASET\n# Optical Air-Gap Diode Test\n'];
        for (let i = 1; i <= 360; i++) {
            const h1 = quickHash(`token_${i}_a`).repeat(2);
            const h2 = quickHash(`token_${i}_b`).repeat(2);
            lines.push(`function worker_${String(i).padStart(3, '0')}(ctx, res) { const token = "${h1}"; return { id: ${i}, valid: true, digest: "${h2}" }; }`);
        }
        sample = lines.join('\n').slice(0, 51200);
    } else if (type === '100kb') {
        const lines = ['# RAPIDFIRE 100KB BENCHMARK DATASET\n# Optical Air-Gap Diode Test\n'];
        for (let i = 1; i <= 720; i++) {
            const h1 = quickHash(`token_${i}_x`).repeat(2);
            const h2 = quickHash(`token_${i}_y`).repeat(2);
            lines.push(`function node_${String(i).padStart(4, '0')}(req, reply) { const session = "${h1}"; return { index: ${i}, ok: true, hash: "${h2}" }; }`);
        }
        sample = lines.join('\n').slice(0, 102400);
    } else if (type === '300kb') {
        const lines = ['# RAPIDFIRE 300KB HEAVY BENCHMARK DATASET\n# Optical Air-Gap Diode Test\n'];
        for (let i = 1; i <= 2160; i++) {
            const h1 = quickHash(`heavy_${i}_alpha`).repeat(2);
            const h2 = quickHash(`heavy_${i}_beta`).repeat(2);
            lines.push(`function cluster_${String(i).padStart(4, '0')}(event) { const cert = "${h1}"; return { clusterId: ${i}, ack: true, sig: "${h2}" }; }`);
        }
        sample = lines.join('\n').slice(0, 307200);
    }

    loadedFilePayload = null; // Clear any file selection if preset is loaded
    const senderPreview = document.getElementById('sender-file-preview');
    if (senderPreview) senderPreview.style.display = 'none';
    const input = document.getElementById('send-input');
    input.value = sample;
    const textBytes = new TextEncoder().encode(sample);
    preparePayload(textBytes, `${sample.length} bytes (${type})`);
};

// --- Sender Implementation ---
window.setSpeed = function(fps) {
    targetFps = fps;
    const safeBtn = document.getElementById('speed-safe');
    const turboBtn = document.getElementById('speed-turbo');
    if (safeBtn && turboBtn) {
        if (fps === 8) {
            safeBtn.classList.add('active');
            turboBtn.classList.remove('active');
        } else {
            turboBtn.classList.add('active');
            safeBtn.classList.remove('active');
        }
    }
    const mobileMeta = document.getElementById('mobile-stream-meta');
    if (mobileMeta && encoder) {
        mobileMeta.innerText = `${encoder.K} blocks · ${targetFps === 15 ? 'Turbo' : 'Safe'}`;
    }
    if (isSending) {
        startSendingLoop();
    }
};

let loadedFilePayload = null; // { name: string, type: string, bytes: Uint8Array }

// Utility to render file preview into a container
function renderFilePreview(blob, filename, mimeType, containerId, titleId) {
    const container = document.getElementById(containerId);
    const body = document.getElementById(containerId.replace('file-preview', 'preview-body'));
    const title = document.getElementById(titleId);

    if (!container || !body) return;

    if (title) {
        title.innerText = `${filename} (${(blob.size / 1024).toFixed(1)} KB)`;
    }

    body.innerHTML = '';
    container.style.display = 'flex';

    const lowerName = filename.toLowerCase();
    const isImage = mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(lowerName);
    const isText = mimeType.startsWith('text/') || /\.(txt|json|md|csv|js|ts|html|css|py|sh|xml|yml|yaml|ini|log)$/i.test(lowerName);
    const isPdf = mimeType === 'application/pdf' || lowerName.endsWith('.pdf');

    if (isImage) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.onload = () => URL.revokeObjectURL(img.src);
        body.appendChild(img);
    } else if (isText) {
        const reader = new FileReader();
        reader.onload = () => {
            const pre = document.createElement('pre');
            const content = reader.result;
            pre.textContent = content.length > 5000 ? content.slice(0, 5000) + '\n... [Preview Truncated]' : content;
            body.appendChild(pre);
        };
        reader.readAsText(blob.slice(0, 51200));
    } else if (isPdf) {
        const badge = document.createElement('div');
        badge.className = 'file-preview-badge';
        badge.innerHTML = `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
            <div>
                <div style="font-weight:600; color:var(--text-primary);">PDF Document</div>
                <div>${(blob.size / 1024).toFixed(1)} KB · Ready to transmit</div>
            </div>
        `;
        body.appendChild(badge);
    } else {
        const badge = document.createElement('div');
        badge.className = 'file-preview-badge';
        const ext = lowerName.split('.').pop()?.toUpperCase() || 'FILE';
        badge.innerHTML = `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <div>
                <div style="font-weight:600; color:var(--text-primary);">${ext} Binary Archive / Data</div>
                <div>${(blob.size / 1024).toFixed(1)} KB · ${mimeType || 'application/octet-stream'}</div>
            </div>
        `;
        body.appendChild(badge);
    }
}

window.clearSelectedFile = function() {
    loadedFilePayload = null;
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.value = '';
    const preview = document.getElementById('sender-file-preview');
    if (preview) preview.style.display = 'none';
    const input = document.getElementById('send-input');
    if (input) input.value = '';
    document.getElementById('beam-stats').innerText = 'Stream idle';
};

// Compress image to lightweight WebP if it's a photo/image
async function compressImageToWebp(file, maxDimension = 1280, quality = 0.78) {
    return new Promise((resolve) => {
        const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
        if (!isImage || file.type === 'image/svg+xml') {
            resolve(null);
            return;
        }

        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;

            // Scale down if larger than maxDimension
            if (width > maxDimension || height > maxDimension) {
                if (width > height) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                } else {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((blob) => {
                if (!blob) {
                    resolve(null);
                    return;
                }
                blob.arrayBuffer().then(buf => {
                    resolve({
                        bytes: new Uint8Array(buf),
                        size: blob.size,
                        width,
                        height
                    });
                });
            }, 'image/webp', quality);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };
        img.src = url;
    });
}

// Convert a WebP blob back to original format (e.g. image/jpeg or image/png) on receiver
async function convertBlobToTargetMime(blob, targetMime, quality = 0.9) {
    return new Promise((resolve) => {
        if (!targetMime || targetMime === blob.type || targetMime === 'image/webp') {
            resolve(blob);
            return;
        }
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            // If target is JPEG, fill white background for transparent pixels
            if (targetMime === 'image/jpeg') {
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.drawImage(img, 0, 0);
            canvas.toBlob((resBlob) => {
                resolve(resBlob || blob);
            }, targetMime, quality);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(blob);
        };
        img.src = url;
    });
}

window.handleFileSelected = async function(file) {
    if (!file) return;

    const optToggle = document.getElementById('toggle-optimize-image');
    const shouldOptimize = optToggle ? optToggle.checked : true;

    let payloadBytes = null;
    let transferMime = file.type;
    let isWebpOptimized = false;
    let originalSize = file.size;

    // Check if image optimization applies
    if (shouldOptimize && (file.type.startsWith('image/') || /\.(png|jpe?g|bmp)$/i.test(file.name))) {
        document.getElementById('beam-stats').innerText = 'Optimizing image for air-gap...';
        const optimized = await compressImageToWebp(file, 1280, 0.78);
        if (optimized && optimized.size < file.size) {
            payloadBytes = optimized.bytes;
            transferMime = 'image/webp';
            isWebpOptimized = true;
        }
    }

    if (!payloadBytes) {
        const arrayBuffer = await file.arrayBuffer();
        payloadBytes = new Uint8Array(arrayBuffer);
    }

    // Pack file with JSON metadata header:
    // { name, type, originalType: file.type, size, isFile: true, isWebpOptimized } + "\n---\n" + binary payload
    const meta = JSON.stringify({
        name: file.name,
        type: transferMime,
        originalType: file.type || 'application/octet-stream',
        size: payloadBytes.length,
        originalSize: originalSize,
        isFile: true,
        isWebpOptimized
    });

    const metaBytes = new TextEncoder().encode(meta + '\n---\n');
    const combinedBytes = new Uint8Array(metaBytes.length + payloadBytes.length);
    combinedBytes.set(metaBytes, 0);
    combinedBytes.set(payloadBytes, metaBytes.length);

    loadedFilePayload = {
        name: file.name,
        type: file.type,
        bytes: combinedBytes
    };

    const optLabel = isWebpOptimized
        ? ` (${(originalSize / 1024).toFixed(1)} KB → ${(payloadBytes.length / 1024).toFixed(1)} KB WebP)`
        : ` (${(file.size / 1024).toFixed(1)} KB)`;

    const input = document.getElementById('send-input');
    input.value = `[File Selected: ${file.name}${optLabel}]\nClick "Start Beaming" to transmit.`;

    // Render Sender Preview
    renderFilePreview(file, file.name, file.type, 'sender-file-preview', 'sender-preview-title');

    await preparePayload(combinedBytes, `${file.name}${optLabel}`);
};

async function preparePayload(bytes, label) {
    document.getElementById('beam-stats').innerText = 'Compressing...';
    const compressed = await compressData(bytes);
    encoder = new FountainEncoder(compressed, 350); // 350 bytes chunk size (2.2x throughput)
    currentTransferHash = quickHash(bytes.length + '_' + compressed.length);
    document.getElementById('beam-stats').innerText = `${label || bytes.length + ' B'} → ${compressed.length} B in ${encoder.K} blocks`;
}

window.toggleSending = async function() {
    if (isSending) {
        stopSending();
        return;
    }

    // Check if we have an attached file payload, otherwise read text input
    if (loadedFilePayload) {
        await preparePayload(loadedFilePayload.bytes, `${loadedFilePayload.name}`);
    } else {
        const text = document.getElementById('send-input').value.trim();
        if (!text) {
            alert('Please enter text or select a file to beam.');
            return;
        }
        const textBytes = new TextEncoder().encode(text);
        await preparePayload(textBytes, `${text.length} chars`);
    }

    const startBtn = document.getElementById('start-beam-btn');
    startBtn.innerText = 'Stop Beaming';
    startBtn.classList.add('btn-danger');
    isSending = true;

    // Trigger mobile focus layout (collapsing controls)
    const screenSend = document.getElementById('screen-send');
    if (screenSend) screenSend.classList.add('is-beaming');
    const mobileMeta = document.getElementById('mobile-stream-meta');
    if (mobileMeta) mobileMeta.innerText = `${encoder.K} blocks · ${targetFps === 15 ? 'Turbo' : 'Safe'}`;

    // Initialize QR Code generator instance
    const container = document.getElementById('qr-canvas-container');
    container.innerHTML = '';
    qrcodeInstance = new QRCode(container, {
        text: 'RAPIDFIRE_INIT',
        width: 250,
        height: 250,
        correctLevel: QRCode.CorrectLevel.L // Level L for max capacity
    });

    startSendingLoop();

    // Start background camera ACK watcher if opted in
    if (autoStopWithCamera) {
        startSenderAckWatcher();
    }
};

function startSendingLoop() {
    if (sendInterval) clearInterval(sendInterval);
    const intervalMs = Math.round(1000 / targetFps);

    // Send first droplet immediately (using compact Z85 encoding: 'Z:' prefix)
    if (encoder) {
        const droplet = encoder.nextDroplet();
        const payload = `Z:${encodeZ85(droplet)}`;
        qrcodeInstance.clear();
        qrcodeInstance.makeCode(payload);
        document.getElementById('beam-stats').innerText = `Droplet #${encoder.seed} · ${encoder.K} total chunks`;
    }

    sendInterval = setInterval(() => {
        if (!isSending || !encoder) return;
        const droplet = encoder.nextDroplet();
        const payload = `Z:${encodeZ85(droplet)}`;
        qrcodeInstance.clear();
        qrcodeInstance.makeCode(payload);
        document.getElementById('beam-stats').innerText = `Droplet #${encoder.seed} · ${encoder.K} total chunks`;
    }, intervalMs);
}

const PLACEHOLDER_QR_SVG = `
<div class="qr-placeholder-wrap">
    <svg class="placeholder-qr-svg" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="14" y="14" width="44" height="44" rx="7" stroke="#222222" stroke-width="6"/>
        <rect x="26" y="26" width="20" height="20" rx="3" fill="#222222"/>
        <rect x="142" y="14" width="44" height="44" rx="7" stroke="#222222" stroke-width="6"/>
        <rect x="154" y="26" width="20" height="20" rx="3" fill="#222222"/>
        <rect x="14" y="142" width="44" height="44" rx="7" stroke="#222222" stroke-width="6"/>
        <rect x="26" y="154" width="20" height="20" rx="3" fill="#222222"/>
        <rect x="144" y="144" width="34" height="34" rx="5" stroke="#999999" stroke-width="4" stroke-dasharray="5 3"/>
        <rect x="156" y="156" width="10" height="10" rx="2" fill="#999999"/>
        <g fill="#aaaaaa" opacity="0.65">
            <rect x="70" y="18" width="8" height="8" rx="2"/>
            <rect x="88" y="18" width="8" height="8" rx="2"/>
            <rect x="106" y="18" width="8" height="8" rx="2"/>
            <rect x="124" y="18" width="8" height="8" rx="2"/>
            <rect x="70" y="36" width="8" height="8" rx="2"/>
            <rect x="106" y="36" width="8" height="8" rx="2"/>
            <rect x="70" y="54" width="8" height="8" rx="2"/>
            <rect x="88" y="54" width="8" height="8" rx="2"/>
            <rect x="124" y="54" width="8" height="8" rx="2"/>
            <rect x="18" y="72" width="8" height="8" rx="2"/>
            <rect x="36" y="72" width="8" height="8" rx="2"/>
            <rect x="54" y="72" width="8" height="8" rx="2"/>
            <rect x="140" y="72" width="8" height="8" rx="2"/>
            <rect x="158" y="72" width="8" height="8" rx="2"/>
            <rect x="176" y="72" width="8" height="8" rx="2"/>
            <rect x="18" y="90" width="8" height="8" rx="2"/>
            <rect x="54" y="90" width="8" height="8" rx="2"/>
            <rect x="140" y="90" width="8" height="8" rx="2"/>
            <rect x="176" y="90" width="8" height="8" rx="2"/>
            <rect x="18" y="108" width="8" height="8" rx="2"/>
            <rect x="36" y="108" width="8" height="8" rx="2"/>
            <rect x="158" y="108" width="8" height="8" rx="2"/>
            <rect x="18" y="126" width="8" height="8" rx="2"/>
            <rect x="54" y="126" width="8" height="8" rx="2"/>
            <rect x="140" y="126" width="8" height="8" rx="2"/>
            <rect x="70" y="142" width="8" height="8" rx="2"/>
            <rect x="88" y="142" width="8" height="8" rx="2"/>
            <rect x="106" y="142" width="8" height="8" rx="2"/>
            <rect x="88" y="160" width="8" height="8" rx="2"/>
            <rect x="124" y="160" width="8" height="8" rx="2"/>
            <rect x="70" y="178" width="8" height="8" rx="2"/>
            <rect x="106" y="178" width="8" height="8" rx="2"/>
            <rect x="124" y="178" width="8" height="8" rx="2"/>
        </g>
        <rect x="58" y="84" width="84" height="32" rx="16" fill="#222222"/>
        <text x="100" y="104" text-anchor="middle" font-size="10" font-weight="700" fill="#FBAB57" letter-spacing="1.5">STANDBY</text>
    </svg>
</div>`;

function renderPlaceholder() {
    const container = document.getElementById('qr-canvas-container');
    if (container) {
        container.innerHTML = PLACEHOLDER_QR_SVG;
    }
}

async function startSenderAckWatcher() {
    const video = document.getElementById('sender-camera-video');
    if (!video) return;

    try {
        senderStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        video.srcObject = senderStream;
        await video.play();
        senderWatcherScanning = true;
        requestAnimationFrame(scanSenderAckFrame);
    } catch (e) {
        console.warn('Sender ACK watcher camera not available', e);
    }
}

function stopSenderAckWatcher() {
    senderWatcherScanning = false;
    if (senderStream) {
        senderStream.getTracks().forEach(track => track.stop());
        senderStream = null;
    }
    const video = document.getElementById('sender-camera-video');
    if (video) video.srcObject = null;
}

async function scanSenderAckFrame() {
    if (!senderWatcherScanning || !isSending) return;

    const video = document.getElementById('sender-camera-video');
    if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        let detectedAck = null;

        if (barcodeDetector) {
            try {
                const barcodes = await barcodeDetector.detect(video);
                for (const b of barcodes) {
                    if (b.rawValue && b.rawValue.startsWith('ACK:')) {
                        detectedAck = b.rawValue;
                        break;
                    }
                }
            } catch (err) {}
        }

        if (!detectedAck && window.jsQR) {
            offscreenCanvas.width = video.videoWidth;
            offscreenCanvas.height = video.videoHeight;
            offscreenCtx.drawImage(video, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
            const imageData = offscreenCtx.getImageData(0, 0, offscreenCanvas.width, offscreenCanvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data && code.data.startsWith('ACK:')) {
                detectedAck = code.data;
            }
        }

        if (detectedAck) {
            stopSending();
            document.getElementById('beam-stats').innerText = 'Receiver confirmed (ACK detected). Done!';
            if ('vibrate' in navigator) {
                navigator.vibrate([30, 40, 30]);
            }
            return;
        }
    }

    if (senderWatcherScanning && isSending) {
        requestAnimationFrame(scanSenderAckFrame);
    }
}

function stopSending() {
    isSending = false;
    if (sendInterval) {
        clearInterval(sendInterval);
        sendInterval = null;
    }
    stopSenderAckWatcher();

    const startBtn = document.getElementById('start-beam-btn');
    startBtn.innerText = 'Start Beaming';
    startBtn.classList.remove('btn-danger');
    if (!document.getElementById('beam-stats').innerText.includes('Receiver confirmed')) {
        document.getElementById('beam-stats').innerText = 'Stream standby';
    }

    // Remove mobile focus layout (restore controls)
    const screenSend = document.getElementById('screen-send');
    if (screenSend) screenSend.classList.remove('is-beaming');

    // Restore placeholder QR
    renderPlaceholder();
}

// --- Receiver Implementation ---
function stopReceiverCamera() {
    isScanning = false;
    if (receiverAnimId) {
        cancelAnimationFrame(receiverAnimId);
        receiverAnimId = null;
    }
    if (videoStream) {
        videoStream.getTracks().forEach(track => {
            try { track.stop(); } catch(e) {}
        });
        videoStream = null;
    }
    const camVideo = document.getElementById('camera-video');
    if (camVideo) {
        try { camVideo.pause(); } catch(e) {}
        camVideo.srcObject = null;
    }
    const fpsElem = document.getElementById('recv-fps');
    if (fpsElem) fpsElem.innerText = '';
}

async function initCamera() {
    stopReceiverCamera();

    const video = document.getElementById('camera-video');
    try {
        const constraints = {
            video: {
                facingMode: { ideal: currentFacingMode },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            }
        };
        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = videoStream;
        await video.play();

        // Check if native BarcodeDetector is available
        if ('BarcodeDetector' in window) {
            try {
                const formats = await BarcodeDetector.getSupportedFormats();
                if (formats.includes('qr_code')) {
                    barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
                }
            } catch (e) {
                console.log('BarcodeDetector check failed', e);
            }
        }

        isScanning = true;
        receiverAnimId = requestAnimationFrame(scanVideoFrame);
    } catch (err) {
        if (err.name === 'AbortError' || (decoder && decoder.isDone)) return;
        console.error('Camera access error:', err);
        document.getElementById('recv-status').innerText = 'Camera access error: ' + err.message;
    }
}

window.switchCamera = function() {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    initCamera();
};

window.resetReceiver = function() {
    stopReceiverCamera();
    decoder.reset();
    lastDecodedBytes = null;
    document.getElementById('recv-bar').style.width = '0%';
    document.getElementById('recv-pct').innerText = '0%';
    document.getElementById('recv-chunks').innerText = 'Blocks: 0 / 0';
    document.getElementById('recv-status').innerText = 'Reset. Aim at sender screen.';
    document.getElementById('result-box').style.display = 'none';

    // Remove is-complete state
    const screenRecv = document.getElementById('screen-recv');
    if (screenRecv) screenRecv.classList.remove('is-complete');

    // Restore copy button label
    const copyBtn = document.getElementById('btn-copy-result');
    if (copyBtn) copyBtn.innerText = 'Copy to Clipboard';

    // Restore camera viewfinder from ACK view
    const camVideo = document.getElementById('camera-video');
    const camOverlay = document.getElementById('camera-overlay');
    const ackView = document.getElementById('ack-view-container');
    if (camVideo) camVideo.style.display = 'block';
    if (camOverlay) camOverlay.style.display = 'block';
    if (ackView) ackView.style.display = 'none';

    initCamera();
};

async function scanVideoFrame() {
    if (!isScanning) return;

    const video = document.getElementById('camera-video');
    if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            const currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
            document.getElementById('recv-fps').innerText = `Scanning at ${currentFps} FPS`;
            frameCount = 0;
            lastFpsTime = now;
        }

        let rawQrText = null;

        if (barcodeDetector) {
            try {
                const barcodes = await barcodeDetector.detect(video);
                if (barcodes.length > 0) {
                    rawQrText = barcodes[0].rawValue;
                }
            } catch (err) {
                // fall through to jsQR
            }
        }

        if (!rawQrText && window.jsQR) {
            offscreenCanvas.width = video.videoWidth;
            offscreenCanvas.height = video.videoHeight;
            offscreenCtx.drawImage(video, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
            const imageData = offscreenCtx.getImageData(0, 0, offscreenCanvas.width, offscreenCanvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert'
            });
            if (code) {
                rawQrText = code.data;
            }
        }

        if (rawQrText) {
            await handleDecodedQR(rawQrText);
        }
    }

    // Only queue next frame if actively scanning
    if (isScanning) {
        receiverAnimId = requestAnimationFrame(scanVideoFrame);
    }
}

let lastDecodedBytes = null;

async function handleDecodedQR(data) {
    // If it's an ACK QR and we are in sender mode
    if (data.startsWith('ACK:')) {
        if (isSending) {
            stopSending();
            document.getElementById('beam-stats').innerText = 'Receiver confirmed. Beaming finished.';
            if ('vibrate' in navigator) {
                navigator.vibrate([30, 40, 30]);
            }
        }
        return;
    }

    // Droplet QR (supports Z85 compact 'Z:' and legacy Base64 'F:')
    if (data.startsWith('Z:') || data.startsWith('F:')) {
        try {
            const isZ85 = data.startsWith('Z:');
            const encodedData = data.substring(2);
            const packetBytes = isZ85 ? decodeZ85(encodedData) : base64ToUint8(encodedData);
            if (packetBytes.length >= 12) {
                const incomingTransferId = new DataView(packetBytes.buffer, packetBytes.byteOffset, packetBytes.byteLength).getUint16(0, false);
                // If a new transfer has arrived and we already had a completed state, reset receiver state
                if (decoder.transferId !== null && decoder.transferId !== incomingTransferId) {
                    lastDecodedBytes = null;
                    document.getElementById('result-box').style.display = 'none';
                }
            }

            const accepted = decoder.addDroplet(packetBytes);

            if (accepted || decoder.K) {
                const pct = decoder.getProgress();
                document.getElementById('recv-bar').style.width = `${pct}%`;
                document.getElementById('recv-pct').innerText = `${pct}%`;
                document.getElementById('recv-chunks').innerText = `Blocks: ${decoder.solvedCount} / ${decoder.K || '?'}`;
                document.getElementById('recv-status').innerText = `Reconstructing payload (${decoder.equations.length} buffered)`;

                // Subtle haptic tick on mobile when a packet contributes
                if (accepted && 'vibrate' in navigator) {
                    navigator.vibrate(8);
                }

                if (decoder.isDone && !lastDecodedBytes) {
                    onTransferComplete();
                }
            }
        } catch (e) {
            console.error('Failed to parse packet', e);
        }
    }
}

let receivedFileBlob = null; // { blob: Blob, name: string }

async function onTransferComplete() {
    const rawCompressed = decoder.getRecoveredData();
    const decompressed = await decompressData(rawCompressed);
    lastDecodedBytes = decompressed;

    document.getElementById('recv-status').innerText = 'Payload reconstruction complete';
    document.getElementById('result-box').style.display = 'flex';

    // Trigger mobile re-ordering state (ACK QR on top)
    const screenRecv = document.getElementById('screen-recv');
    if (screenRecv) screenRecv.classList.add('is-complete');

    // Double vibration on completion
    if ('vibrate' in navigator) {
        navigator.vibrate([40, 50, 40]);
    }

    // Check if payload contains file packaging header: {"name":..."isFile":true}\n---\n<binary>
    let isFilePayload = false;
    let decodedText = '';
    receivedFileBlob = null;
    const downloadBtn = document.getElementById('btn-download-result');

    try {
        // Inspect up to first 1024 bytes for file metadata header
        const inspectSlice = decompressed.subarray(0, Math.min(decompressed.length, 1024));
        const headStr = new TextDecoder('utf-8', { fatal: false }).decode(inspectSlice);
        const separator = '\n---\n';
        const sepIdx = headStr.indexOf(separator);

        if (sepIdx !== -1) {
            const metaJsonStr = headStr.substring(0, sepIdx).trim();
            if (metaJsonStr.startsWith('{') && metaJsonStr.includes('"isFile":true')) {
                const meta = JSON.parse(metaJsonStr);
                const headerByteLength = new TextEncoder().encode(metaJsonStr + separator).length;
                const fileBytes = decompressed.subarray(headerByteLength);

                const blob = new Blob([fileBytes], { type: meta.type || 'application/octet-stream' });
                receivedFileBlob = {
                    blob,
                    name: meta.name || 'received_file',
                    originalType: meta.originalType || meta.type,
                    isWebpOptimized: Boolean(meta.isWebpOptimized)
                };
                isFilePayload = true;

                const origSizeStr = meta.originalSize ? ` (originally ${(meta.originalSize / 1024).toFixed(1)} KB)` : '';
                decodedText = `[Received File: ${meta.name}]\nFormat: ${meta.originalType || meta.type}${meta.isWebpOptimized ? ' (Air-gap compressed via WebP)' : ''}\nSize: ${(meta.size / 1024).toFixed(1)} KB${origSizeStr}\n\nClick "Download File" to save as ${meta.name}.`;
                document.getElementById('result-text').value = decodedText;

                if (downloadBtn) {
                    downloadBtn.style.display = 'inline-flex';
                    downloadBtn.innerText = `Download File`;
                }

                // Render Receiver File Preview
                renderFilePreview(blob, meta.name, meta.type || '', 'receiver-file-preview', 'receiver-preview-title');
            }
        }
    } catch (e) {
        console.warn('File header detection error, falling back to standard decode', e);
    }

    if (!isFilePayload) {
        if (downloadBtn) downloadBtn.style.display = 'none';
        const recvPreview = document.getElementById('receiver-file-preview');
        if (recvPreview) recvPreview.style.display = 'none';
        try {
            decodedText = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
            document.getElementById('result-text').value = decodedText;
        } catch {
            decodedText = `[Binary Payload: ${decompressed.length} bytes]`;
            document.getElementById('result-text').value = decodedText;
        }
    }

    // Auto-copy text to clipboard on mobile if plain text
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;
    if (isMobile && decodedText && !isFilePayload) {
        try {
            await navigator.clipboard.writeText(decodedText);
            const copyBtn = document.getElementById('btn-copy-result');
            if (copyBtn) copyBtn.innerText = 'Copied to Clipboard';
        } catch (e) {
            console.warn('Auto-clipboard write failed', e);
        }
    }

    // Transform camera viewfinder into the Verification ACK QR display
    const camVideo = document.getElementById('camera-video');
    const camOverlay = document.getElementById('camera-overlay');
    const ackView = document.getElementById('ack-view-container');
    if (camVideo) camVideo.style.display = 'none';
    if (camOverlay) camOverlay.style.display = 'none';
    if (ackView) ackView.style.display = 'flex';

    // Render ACK QR code (larger on PC to fill the container)
    const ackContainer = document.getElementById('ack-qr-code');
    ackContainer.innerHTML = '';
    const hash = quickHash(rawCompressed.length.toString());
    const qrSize = window.innerWidth >= 768 ? 215 : 165;
    new QRCode(ackContainer, {
        text: `ACK:${hash}`,
        width: qrSize,
        height: qrSize,
        correctLevel: QRCode.CorrectLevel.M
    });

    // Completely stop camera hardware and scanning loop upon completion
    stopReceiverCamera();
    document.getElementById('recv-status').innerText = 'Payload reconstruction complete';
}

window.copyResult = function() {
    const txt = document.getElementById('result-text').value;
    navigator.clipboard.writeText(txt);
    const copyBtn = document.getElementById('btn-copy-result');
    if (copyBtn) {
        copyBtn.innerText = 'Copied to Clipboard';
        setTimeout(() => {
            copyBtn.innerText = 'Copy to Clipboard';
        }, 2500);
    }
    const origStatus = document.getElementById('recv-status').innerText;
    document.getElementById('recv-status').innerText = 'Copied to clipboard';
    setTimeout(() => {
        document.getElementById('recv-status').innerText = origStatus;
    }, 2000);
};

window.downloadResultFile = async function() {
    if (!receivedFileBlob || !receivedFileBlob.blob) {
        alert('No file available to download.');
        return;
    }

    const downloadBtn = document.getElementById('btn-download-result');
    if (downloadBtn) downloadBtn.innerText = 'Preparing download...';

    let finalBlob = receivedFileBlob.blob;

    // If the file was optical-compressed as WebP but the original file was JPEG/PNG,
    // convert it back to the user's original format seamlessly!
    if (receivedFileBlob.isWebpOptimized && receivedFileBlob.originalType && receivedFileBlob.originalType !== 'image/webp') {
        try {
            finalBlob = await convertBlobToTargetMime(receivedFileBlob.blob, receivedFileBlob.originalType);
        } catch (e) {
            console.warn('Could not re-encode to original MIME, downloading as received', e);
        }
    }

    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = receivedFileBlob.name || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    if (downloadBtn) downloadBtn.innerText = 'Download File';

    const origStatus = document.getElementById('recv-status').innerText;
    document.getElementById('recv-status').innerText = `Downloaded ${receivedFileBlob.name}`;
    setTimeout(() => {
        document.getElementById('recv-status').innerText = origStatus;
    }, 2500);
};

// --- Tab / Screen Navigation ---
window.switchTab = function(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

    if (screen === 'send') {
        document.getElementById('nav-btn-send').classList.add('active');
        document.getElementById('screen-send').classList.add('active');
        stopReceiverCamera();
    } else {
        document.getElementById('nav-btn-recv').classList.add('active');
        document.getElementById('screen-recv').classList.add('active');
        // Only start the camera if we are NOT already in a completed state
        if (!decoder.isDone && !lastDecodedBytes) {
            initCamera();
        }
    }
};

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    // Check PWA service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(console.warn);
    }
});
