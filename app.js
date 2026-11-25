import { FountainEncoder, FountainDecoder, HEADER_BYTES, readHeader } from './fountain.js';
import { encodeQR, alphanumericCapacity } from './qr.js';
import { base45Encode, base45Decode, bytesForChars } from './base45.js';
import { packPayload, unpackPayload } from './envelope.js';
import { cardLayout, paintCard, CardAnalyzer, defaultGreys } from './card.js';
import { rfcPlan, buildFrame, readFrame, paintFrame, threshold, colourSeparation } from './rfc.js';
import { GpuSampler } from './gpusample.js';
import { rsDecode as fastRsDecode } from './rs.js';

// --- Frame format ---
// Each frame is an alphanumeric-mode QR holding PACKET_PREFIX + base45(packet).
// The code size picks the largest QR version used; packets are sized to fill it at level L.
// The receiver needs no setting: every frame carries its own size.
// The fountain carries an envelope (see envelope.js): compression flag + checksum + body.
const PACKET_PREFIX = 'F3:';
const LEGACY_PREFIX = /^F\d*:/; // frames from older versions (F:, F2:)
const FRAME_SIZES = { S: 10, M: 15, L: 20, XL: 25 };
const SIZE_STORAGE_KEY = 'rapidfire.frameSize';
let frameSize = 'S';
try {
    const saved = localStorage.getItem(SIZE_STORAGE_KEY);
    if (saved in FRAME_SIZES) frameSize = saved;
} catch (e) {}

function maxChunkBytes() {
    const version = FRAME_SIZES[frameSize];
    return bytesForChars(alphanumericCapacity(version, 'L') - PACKET_PREFIX.length) - HEADER_BYTES;
}

// --- Global State ---
let isSending = false;
let sendRafId = null;
let lastSwapTime = -Infinity;
let targetFps = 8;
let encoder = null;
let currentTransferHash = '';
let frameCanvas = null;
let frameCtx = null;
let autoStopWithCamera = false;
let senderStream = null;
let senderWatcherScanning = false;

window.toggleAckWatcher = function(enabled) {
    autoStopWithCamera = enabled;
};

let decoder = new FountainDecoder();
let cameraOverrides = {};  // { width, height, frameRate, facing }, set by the lab remote
let cardBusy = false;      // receiver is measuring the test card (QR scanning paused)
let cardRun = null;        // sender is showing the test card
let rfcRun = null;         // sender is beaming RapidFire code v1
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

// --- Lab telemetry ---
// On a home-network or localhost address, both ends report measurements (never payload
// contents) to POST /api/telemetry on the server that served the page. On a public host
// (Vercel) this is off.
const LAB_MODE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(location.hostname);
const DEVICE_ID = (() => {
    try {
        let id = localStorage.getItem('rapidfire.deviceId');
        if (!id) {
            id = Math.random().toString(36).slice(2, 8);
            localStorage.setItem('rapidfire.deviceId', id);
        }
        return id;
    } catch (e) {
        return 'anon';
    }
})();
const DEVICE_INFO = {
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`,
};

// Bump with CACHE_NAME in sw.js, so reports show which build each device is running
const APP_VERSION = '2.29';

function report(event, data = {}) {
    if (!LAB_MODE) return;
    const body = JSON.stringify({ event, device: DEVICE_ID, v: APP_VERSION, t: Date.now(), ...data });
    try {
        if (navigator.sendBeacon) navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
        else fetch('/api/telemetry', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    } catch (e) {}
}

report('page-open', { ...DEVICE_INFO, url: location.origin + location.pathname + location.search });

// --- Helper Functions ---
function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
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
window.loadPreset = function(type, randomKB = 50) {
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
    }

    if (type === 'random') {
        // Random words (50 KB by default): compresses only partly, and any lost byte would fail the checksum
        const words = [];
        let size = 0;
        while (size < randomKB * 1024) {
            const word = Math.random().toString(36).slice(2, 3 + Math.floor(Math.random() * 8));
            words.push(word);
            size += word.length + 1;
        }
        sample = words.join(' ');
    }

    const input = document.getElementById('send-input');
    input.value = sample;
    const textBytes = new TextEncoder().encode(sample);
    return preparePayload(textBytes, `${sample.length} bytes (${type})`);
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
    updateStreamMeta();
    if (isSending) {
        startSendingLoop();
        report('beam-speed', { transferId: encoder.transferId, fps: targetFps, atFrame: encoder.lastId + 1 });
    }
};

function reportBeamStart(reason) {
    report('beam-start', {
        reason,
        transferId: encoder.transferId,
        size: frameSize,
        version: FRAME_SIZES[frameSize],
        fps: targetFps,
        K: encoder.K,
        chunk: encoder.chunkSize,
        ...payloadMeta,
        ...DEVICE_INFO,
    });
}

function updateStreamMeta() {
    const mobileMeta = document.getElementById('mobile-stream-meta');
    if (mobileMeta && encoder) {
        mobileMeta.innerText = `${encoder.K} blocks · ${targetFps === 15 ? 'Turbo' : 'Safe'} · Size ${frameSize}`;
    }
}

function syncSizeButtons() {
    document.querySelectorAll('[data-frame-size]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.frameSize === frameSize);
    });
}

// Changing size mid-beam restarts the transfer at the new size; the receiver
// sees a new transfer id and starts over.
window.setFrameSize = async function(size) {
    if (!(size in FRAME_SIZES) || size === frameSize) return;
    frameSize = size;
    try { localStorage.setItem(SIZE_STORAGE_KEY, size); } catch (e) {}
    syncSizeButtons();
    if (lastPayload) {
        const previous = isSending && encoder ? { transferId: encoder.transferId, framesShown: encoder.lastId + 1 } : null;
        await preparePayload(lastPayload.bytes, lastPayload.label);
        updateStreamMeta();
        if (isSending) {
            startSendingLoop();
            if (previous) report('beam-stop', { ...previous, reason: 'size-change' });
            reportBeamStart('size-change');
        }
    }
};

let lastPayload = null;
let payloadMeta = {};

let sendStartTime = null;

async function preparePayload(bytes, label) {
    lastPayload = { bytes, label };
    document.getElementById('beam-stats').innerText = 'Compressing...';
    const { packed, compressed } = await packPayload(bytes);
    encoder = new FountainEncoder(packed, maxChunkBytes());
    payloadMeta = { bytes: bytes.length, sentBytes: packed.length, compressed };
    sendStartTime = null;
    currentTransferHash = quickHash(bytes.length + '_' + packed.length);
    const how = compressed ? `compressed to ${formatBytes(packed.length)}` : `sent as is (${formatBytes(packed.length)})`;
    document.getElementById('beam-stats').innerText = `${formatBytes(bytes.length)} ${how} · ${encoder.K} blocks of ${encoder.chunkSize} B`;
}

window.toggleSending = async function() {
    if (isSending) {
        stopSending();
        return;
    }

    const text = document.getElementById('send-input').value.trim();
    if (!text) {
        alert('Please enter or select text to beam.');
        return;
    }

    const textBytes = new TextEncoder().encode(text);
    await preparePayload(textBytes, `${text.length} chars`);

    const startBtn = document.getElementById('start-beam-btn');
    startBtn.innerText = 'Stop Beaming';
    startBtn.classList.add('btn-danger');
    isSending = true;

    // Trigger mobile focus layout (collapsing controls)
    const screenSend = document.getElementById('screen-send');
    if (screenSend) screenSend.classList.add('is-beaming');
    updateStreamMeta();
    reportBeamStart('start');

    setupFrameCanvas();
    startSendingLoop();

    // Start background camera ACK watcher if opted in
    if (autoStopWithCamera) {
        startSenderAckWatcher();
    }
};

function setupFrameCanvas() {
    const container = document.getElementById('qr-canvas-container');
    container.innerHTML = '';
    frameCanvas = document.createElement('canvas');
    container.appendChild(frameCanvas);
    frameCtx = frameCanvas.getContext('2d', { alpha: false });
}

// Draw a QR straight onto the canvas: whole device pixels per module, no smoothing,
// one module of white margin (the container's padding adds the rest).
function drawFrame(text) {
    if (!frameCanvas) return;
    const qr = encodeQR(text, { ecl: 'L' });
    const container = frameCanvas.parentElement;
    const cs = getComputedStyle(container);
    const availW = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const dpr = window.devicePixelRatio || 1;
    const quiet = 1;
    const span = qr.size + quiet * 2;
    const scale = Math.max(1, Math.floor(Math.min(availW, availH) * dpr / span));
    const px = span * scale;

    if (frameCanvas.width !== px) {
        frameCanvas.width = px;
        frameCanvas.height = px;
        frameCanvas.style.width = `${px / dpr}px`;
        frameCanvas.style.height = `${px / dpr}px`;
    }

    const ctx = frameCtx;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    const { size, modules } = qr;
    for (let y = 0; y < size; y++) {
        let x = 0;
        while (x < size) {
            if (!modules[y * size + x]) { x++; continue; }
            const start = x;
            while (x < size && modules[y * size + x]) x++;
            ctx.fillRect((start + quiet) * scale, (y + quiet) * scale, (x - start) * scale, scale);
        }
    }
}

function showNextDroplet() {
    const packet = encoder.nextDroplet();
    drawFrame(PACKET_PREFIX + base45Encode(packet));
    const now = performance.now();
    if (sendStartTime === null) sendStartTime = now;
    const elapsed = ((now - sendStartTime) / 1000).toFixed(1);
    document.getElementById('beam-stats').innerText = `Frame #${encoder.lastId + 1} · ${encoder.K} blocks · ${encoder.chunkSize} B per frame · ${elapsed} s`;
}

// Frames change only inside requestAnimationFrame, so each swap lands on a screen refresh
// and a camera never catches a half-drawn code.
function startSendingLoop() {
    if (sendRafId) cancelAnimationFrame(sendRafId);
    lastSwapTime = -Infinity;
    const tick = (now) => {
        if (!isSending || !encoder) return;
        const interval = 1000 / targetFps;
        // A few ms of slack so a frame due between two refreshes goes out on the earlier one
        if (now - lastSwapTime >= interval - 4) {
            lastSwapTime = now - lastSwapTime < interval * 2 ? lastSwapTime + interval : now;
            showNextDroplet();
        }
        sendRafId = requestAnimationFrame(tick);
    };
    sendRafId = requestAnimationFrame(tick);
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
            stopSending('ack');
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

function stopSending(reason = 'user') {
    if (isSending && encoder) {
        report('beam-stop', {
            transferId: encoder.transferId,
            framesShown: encoder.lastId + 1,
            seconds: sendStartTime === null ? 0 : +((performance.now() - sendStartTime) / 1000).toFixed(2),
            reason,
        });
    }
    isSending = false;
    if (sendRafId) {
        cancelAnimationFrame(sendRafId);
        sendRafId = null;
    }
    frameCanvas = null;
    frameCtx = null;
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
    cancelScan();
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
        const o = cameraOverrides; // set by the lab remote's "camera" command
        const constraints = {
            video: {
                width: { ideal: o.width || 1280 },
                height: { ideal: o.height || 720 },
                frameRate: { ideal: o.frameRate || 30 }
            }
        };
        if (o.deviceId) constraints.video.deviceId = { exact: o.deviceId };
        else constraints.video.facingMode = { ideal: o.facing || currentFacingMode };
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

        const track = videoStream.getVideoTracks()[0];
        const settings = track && track.getSettings ? track.getSettings() : {};
        report('camera', {
            width: video.videoWidth,
            height: video.videoHeight,
            frameRate: settings.frameRate,
            facing: settings.facingMode || currentFacingMode,
            focusMode: settings.focusMode,
            label: track ? track.label : null,
            detector: barcodeDetector ? 'BarcodeDetector' : 'jsQR',
            parallel: barcodeDetector ? MAX_SCANS_IN_FLIGHT : 1,
            scanPx: SCAN_PX,
            ...DEVICE_INFO,
        });

        // Start the per-second counters fresh with the camera
        frameCount = 0;
        lastFpsTime = performance.now();
        scanWindow = { codes: 0, newFrames: 0, detectorHits: 0, jsqrHits: 0, jsqrRuns: 0, ms: 0, done: 0, maxInFlight: 0, codePx: 0 };

        presentedFrames = null;
        cameraFramesInWindow = 0;
        isScanning = true;
        scheduleScan();
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
    rx = null;
    completedTransferId = null;
    report('rx-reset');
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

// Scanning runs once per new camera frame (requestVideoFrameCallback; animation frames as a
// fallback). With the built-in scanner, up to MAX_SCANS_IN_FLIGHT scans overlap: a phone's
// detector works off the main thread, so a second scan can start while the first is still
// searching. Results may finish out of order, which the fountain code doesn't mind.
// Add ?scans=N to the address to try other values (1 = one at a time).
const MAX_SCANS_IN_FLIGHT = (() => {
    const n = parseInt(new URLSearchParams(location.search).get('scans'), 10);
    return n >= 1 && n <= 6 ? n : 2;
})();
// Add ?scanpx=N to shrink the centre square to N×N pixels before scanning (fewer pixels,
// faster scans, but small codes may stop reading). Default: scan it at camera resolution.
const SCAN_PX = (() => {
    const n = parseInt(new URLSearchParams(location.search).get('scanpx'), 10);
    return n >= 160 && n <= 2160 ? n : null;
})();
let receiverAnimKind = 'raf';
let presentedFrames = null;   // camera frame counter from requestVideoFrameCallback
let cameraFramesInWindow = 0;
let scansInFlight = 0;

function scheduleScan() {
    const video = document.getElementById('camera-video');
    if (video && 'requestVideoFrameCallback' in video) {
        receiverAnimKind = 'video';
        receiverAnimId = video.requestVideoFrameCallback((now, meta) => {
            if (presentedFrames !== null && meta && meta.presentedFrames > presentedFrames) {
                cameraFramesInWindow += meta.presentedFrames - presentedFrames;
            }
            if (meta) presentedFrames = meta.presentedFrames;
            onScanTick();
        });
    } else {
        receiverAnimKind = 'raf';
        receiverAnimId = requestAnimationFrame(() => onScanTick());
    }
}

function cancelScan() {
    if (!receiverAnimId) return;
    const video = document.getElementById('camera-video');
    if (receiverAnimKind === 'video' && video && 'cancelVideoFrameCallback' in video) {
        video.cancelVideoFrameCallback(receiverAnimId);
    } else {
        cancelAnimationFrame(receiverAnimId);
    }
    receiverAnimId = null;
}

// The camera view shows the centre square of the video (object-fit: cover in a square card),
// so only that square is scanned: what you see is what gets read, with fewer pixels to search.
function centreSquare(video) {
    const w = video.videoWidth, h = video.videoHeight;
    const side = Math.min(w, h);
    return { sx: (w - side) >> 1, sy: (h - side) >> 1, side };
}

async function detectWithBuiltIn(video) {
    const { sx, sy, side } = centreSquare(video);
    let source = video;
    let bitmap = null;
    if (window.createImageBitmap) {
        try {
            bitmap = SCAN_PX && SCAN_PX < side
                ? await createImageBitmap(video, sx, sy, side, side, { resizeWidth: SCAN_PX, resizeHeight: SCAN_PX, resizeQuality: 'medium' })
                : await createImageBitmap(video, sx, sy, side, side);
            source = bitmap;
        } catch (e) {
            source = video;
        }
    }
    try {
        const barcodes = await barcodeDetector.detect(source);
        if (!barcodes.length) return null;
        // How wide the code appeared, in camera pixels: tells how far the image can shrink
        const box = barcodes[0].boundingBox;
        if (box && box.width) {
            const scale = source === video ? 1 : side / (SCAN_PX && SCAN_PX < side ? SCAN_PX : side);
            scanWindow.codePx = Math.round(Math.max(box.width, box.height) * scale);
        }
        return barcodes[0].rawValue;
    } catch (err) {
        return null;
    } finally {
        if (bitmap && bitmap.close) bitmap.close();
    }
}

function detectWithJsQR(video) {
    const { sx, sy, side } = centreSquare(video);
    const out = SCAN_PX && SCAN_PX < side ? SCAN_PX : side;
    offscreenCanvas.width = out;
    offscreenCanvas.height = out;
    offscreenCtx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
    const imageData = offscreenCtx.getImageData(0, 0, out, out);
    const code = jsQR(imageData.data, out, out, { inversionAttempts: 'dontInvert' });
    return code ? code.data : null;
}

function reportScanWindow(video, now) {
    const windowSec = (now - lastFpsTime) / 1000;
    document.getElementById('recv-fps').innerText = `Scanning at ${Math.round(frameCount / windowSec)} FPS`;
    report('rx-tick', {
        scansPerSec: +(frameCount / windowSec).toFixed(1),
        cameraFps: receiverAnimKind === 'video' ? +(cameraFramesInWindow / windowSec).toFixed(1) : null,
        codesPerSec: +(scanWindow.codes / windowSec).toFixed(1),
        newFramesPerSec: +(scanWindow.newFrames / windowSec).toFixed(1),
        detectorHits: scanWindow.detectorHits,
        jsqrHits: scanWindow.jsqrHits,
        jsqrRuns: scanWindow.jsqrRuns,
        avgScanMs: scanWindow.done ? +(scanWindow.ms / scanWindow.done).toFixed(1) : null,
        maxInFlight: scanWindow.maxInFlight,
        codePx: scanWindow.codePx || null,
        parallel: barcodeDetector ? MAX_SCANS_IN_FLIGHT : 1,
        transferId: decoder.transferId,
        solved: decoder.solvedCount,
        K: decoder.K,
        framesRead: decoder.receivedCount,
        video: `${video.videoWidth}x${video.videoHeight}`,
        scanned: Math.min(centreSquare(video).side, SCAN_PX || Infinity),
        loop: receiverAnimKind,
    });
    frameCount = 0;
    cameraFramesInWindow = 0;
    lastFpsTime = now;
    scanWindow = { codes: 0, newFrames: 0, detectorHits: 0, jsqrHits: 0, jsqrRuns: 0, ms: 0, done: 0, maxInFlight: 0, codePx: 0 };
}

// Called once per new camera frame: report each second, start a scan if a slot is free.
function onScanTick() {
    if (!isScanning) return;
    const video = document.getElementById('camera-video');
    if (video && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
        const now = performance.now();
        if (now - lastFpsTime >= 1000) reportScanWindow(video, now);
        // jsQR runs on the main thread, so overlapping it gains nothing; one at a time there
        const limit = barcodeDetector && receiverAnimKind === 'video' ? MAX_SCANS_IN_FLIGHT : 1;
        if (scansInFlight < limit && !cardBusy) runScan(video);
    }
    if (isScanning) scheduleScan();
}

async function runScan(video) {
    scansInFlight++;
    scanWindow.maxInFlight = Math.max(scanWindow.maxInFlight, scansInFlight);
    frameCount++;
    totalScans++;
    const start = performance.now();
    try {
        // The built-in scanner when the browser has one; jsQR only when it doesn't.
        // (Running jsQR after every built-in miss cost ~300 ms a scan on a real phone.)
        let rawQrText = null;
        if (barcodeDetector) {
            rawQrText = await detectWithBuiltIn(video);
            if (rawQrText) scanWindow.detectorHits++;
        } else if (window.jsQR) {
            scanWindow.jsqrRuns++;
            rawQrText = detectWithJsQR(video);
            if (rawQrText) scanWindow.jsqrHits++;
        }
        if (rawQrText && isScanning) {
            scanWindow.codes++;
            const before = decoder.receivedCount;
            await handleDecodedQR(rawQrText);
            if (decoder.receivedCount > before) scanWindow.newFrames++;
        }
    } finally {
        scanWindow.ms += performance.now() - start;
        scanWindow.done++;
        scansInFlight--;
    }
}

let lastDecodedBytes = null;

// --- Transfer measurement (receiver) ---
// A transfer is timed from the first frame read to the moment the last block is solved.
// Droplet ids are the sender's frame counter, so the id span tells how many frames the
// sender showed meanwhile: that gives the sender's frame rate and how many the camera caught.
let rx = null;              // { transferId, start, doneAt, minId, maxId, scansAtStart, scansAtEnd }
let totalScans = 0;         // camera frames examined since the page loaded
// Per-second scan counters, reported as rx-tick
let scanWindow = { codes: 0, newFrames: 0, detectorHits: 0, jsqrHits: 0, jsqrRuns: 0, ms: 0, done: 0, maxInFlight: 0, codePx: 0 };
let completedTransferId = null;
const LOG_STORAGE_KEY = 'rapidfire.testLog';
const LOG_LIMIT = 50;

function trackFrame(header, now) {
    if (!rx || rx.transferId !== header.transferId) {
        rx = {
            transferId: header.transferId, start: now, doneAt: null,
            minId: header.dropletId, maxId: header.dropletId,
            scansAtStart: totalScans, scansAtEnd: null,
            seen: new Set(), points: [],
        };
    }
    if (rx.doneAt !== null || rx.seen.has(header.dropletId)) return;
    rx.seen.add(header.dropletId);
    rx.points.push([now, header.dropletId]);
    rx.minId = Math.min(rx.minId, header.dropletId);
    rx.maxId = Math.max(rx.maxId, header.dropletId);
}

// Sender frame rate = slope of frame id over the time each id was first read (least squares).
// Fitting every read frame smooths out camera start-up delay and scan jitter.
function estimateSenderFps(points) {
    if (points.length < 3) return null;
    const n = points.length;
    let st = 0, si = 0;
    for (const [t, i] of points) { st += t; si += i; }
    const mt = st / n, mi = si / n;
    let num = 0, den = 0;
    for (const [t, i] of points) { num += (t - mt) * (i - mi); den += (t - mt) * (t - mt); }
    if (den <= 0 || num <= 0) return null;
    return (num / den) * 1000;
}

function measureTransfer({ bytes, sentBytes, compressed, verified }) {
    const active = (rx.doneAt - rx.start) / 1000;
    const senderFps = estimateSenderFps(rx.points);
    const framesShown = rx.maxId - rx.minId + 1;
    // Transfer time = how long the sender took to show the frames this transfer needed
    const seconds = senderFps ? framesShown / senderFps : null;
    return {
        at: new Date().toISOString(),
        bytes, sentBytes, compressed, verified,
        blocks: decoder.K,
        chunk: decoder.chunkSize,
        seconds,
        senderFps,
        framesRead: decoder.receivedCount,
        framesShown,
        caughtPct: Math.min(100, Math.round((100 * decoder.receivedCount) / framesShown)),
        scanFps: active > 0 ? (rx.scansAtEnd - rx.scansAtStart) / active : null,
        speed: seconds ? bytes / seconds : null,
        wireSpeed: seconds ? sentBytes / seconds : null,
    };
}

function rate(bytesPerSecond) {
    return bytesPerSecond === null ? '—' : `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

function renderTransferStats(m) {
    const box = document.getElementById('transfer-stats');
    if (!box) return;
    const ratio = m.compressed ? `compressed ${(m.bytes / m.sentBytes).toFixed(1)}×` : 'not compressed';
    const rows = [
        ['Integrity', m.verified ? 'Verified: every byte matches' : 'Checksum mismatch: data is damaged', m.verified ? 'ok' : 'bad'],
        ['Content', `${formatBytes(m.bytes)} · sent ${formatBytes(m.sentBytes)} (${ratio})`],
        ['Time', m.seconds === null ? 'too few frames to time' : `${m.seconds.toFixed(1)} s`],
        ['Speed', `${rate(m.speed)} content · ${rate(m.wireSpeed)} over the air`],
        ['Sender', `${m.senderFps === null ? '—' : m.senderFps.toFixed(1) + ' fps'} · ${m.chunk} B per frame`],
        ['Frames', `${m.framesRead} read for ${m.blocks} blocks · camera caught ${m.caughtPct}% of ${m.framesShown}`],
        ['Scanner', m.scanFps === null ? '—' : `${m.scanFps.toFixed(0)} scans/s`],
    ];
    box.replaceChildren(...rows.map(([label, value, tone]) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const l = document.createElement('span');
        l.className = 'stat-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'stat-value' + (tone ? ` stat-${tone}` : '');
        v.textContent = value;
        row.append(l, v);
        return row;
    }));
}

// --- Test log (receiver, kept on this device) ---
function loadLog() {
    try { return JSON.parse(localStorage.getItem(LOG_STORAGE_KEY)) || []; } catch (e) { return []; }
}

function saveLog(log) {
    try { localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(log.slice(-LOG_LIMIT))); } catch (e) {}
}

const LOG_COLUMNS = [
    ['time', m => new Date(m.at).toLocaleTimeString()],
    ['ok', m => (m.verified ? 'yes' : 'NO')],
    ['content', m => formatBytes(m.bytes)],
    ['sent', m => formatBytes(m.sentBytes)],
    ['seconds', m => (m.seconds === null ? '' : m.seconds.toFixed(1))],
    ['speed', m => rate(m.speed)],
    ['air', m => rate(m.wireSpeed)],
    ['fps', m => (m.senderFps === null ? '' : m.senderFps.toFixed(1))],
    ['B/frame', m => String(m.chunk)],
    ['caught', m => `${m.caughtPct}%`],
    ['read/blocks', m => `${m.framesRead}/${m.blocks}`],
    ['scans/s', m => (m.scanFps === null ? '' : m.scanFps.toFixed(0))],
];

function renderLog() {
    const card = document.getElementById('test-log-card');
    const body = document.getElementById('test-log-body');
    if (!card || !body) return;
    const log = loadLog();
    card.style.display = log.length ? 'flex' : 'none';
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const [name] of LOG_COLUMNS) {
        const th = document.createElement('th');
        th.textContent = name;
        head.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const m of log.slice().reverse()) {
        const tr = tbody.insertRow();
        if (!m.verified) tr.className = 'log-bad';
        for (const [, fmt] of LOG_COLUMNS) tr.insertCell().textContent = fmt(m);
    }
    body.replaceChildren(table);
}

window.copyTestLog = async function() {
    const log = loadLog();
    const lines = [LOG_COLUMNS.map(([name]) => name).join('\t')]
        .concat(log.map(m => LOG_COLUMNS.map(([, fmt]) => fmt(m)).join('\t')));
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        const btn = document.getElementById('btn-copy-log');
        if (btn) {
            btn.innerText = 'Copied';
            setTimeout(() => { btn.innerText = 'Copy'; }, 2000);
        }
    } catch (e) {
        console.warn('Copy failed', e);
    }
};

window.clearTestLog = function() {
    saveLog([]);
    renderLog();
};

async function handleDecodedQR(data) {
    // If it's an ACK QR and we are in sender mode
    if (data.startsWith('ACK:')) {
        if (isSending) {
            stopSending('ack');
            document.getElementById('beam-stats').innerText = 'Receiver confirmed. Beaming finished.';
            if ('vibrate' in navigator) {
                navigator.vibrate([30, 40, 30]);
            }
        }
        return;
    }

    // Droplet QR
    if (data.startsWith(PACKET_PREFIX)) {
        try {
            const now = performance.now();
            const packetBytes = base45Decode(data.substring(PACKET_PREFIX.length));
            const header = packetBytes && readHeader(packetBytes);
            if (!header) return;
            // A scan still in flight when the transfer finished: nothing left to do
            if (completedTransferId === header.transferId) return;
            trackFrame(header, now);
            // If a new transfer has arrived and we already had a completed state, reset receiver state
            if (decoder.transferId !== null && decoder.transferId !== header.transferId) {
                lastDecodedBytes = null;
                document.getElementById('result-box').style.display = 'none';
            }

            const accepted = decoder.addDroplet(packetBytes);

            if (accepted || decoder.K) {
                const pct = decoder.getProgress();
                document.getElementById('recv-bar').style.width = `${pct}%`;
                document.getElementById('recv-pct').innerText = `${pct}%`;
                document.getElementById('recv-chunks').innerText = `Blocks: ${decoder.solvedCount} / ${decoder.K || '?'}`;
                document.getElementById('recv-status').innerText = `Reconstructing payload (${decoder.receivedCount} frames read)`;

                // Subtle haptic tick on mobile when a packet contributes
                if (accepted && 'vibrate' in navigator) {
                    navigator.vibrate(8);
                }

                if (decoder.isDone && completedTransferId !== decoder.transferId) {
                    completedTransferId = decoder.transferId;
                    rx.doneAt = now;
                    rx.scansAtEnd = totalScans;
                    onTransferComplete();
                }
            }
        } catch (e) {
            console.error('Failed to parse packet', e);
        }
        return;
    }

    if (LEGACY_PREFIX.test(data)) {
        document.getElementById('recv-status').innerText = 'The sender runs an older RapidFireQR. Reload it to update.';
    }
}

async function onTransferComplete() {
    const packed = decoder.getRecoveredData();
    const { bytes: decompressed, compressed, verified } = await unpackPayload(packed);
    lastDecodedBytes = decompressed;
    const rawCompressed = packed;

    const measurement = measureTransfer({ bytes: decompressed.length, sentBytes: packed.length, compressed, verified });
    renderTransferStats(measurement);
    report('rx-done', { transferId: decoder.transferId, ...measurement });
    const log = loadLog();
    log.push(measurement);
    saveLog(log);
    renderLog();

    document.getElementById('recv-status').innerText = 'Payload reconstruction complete';
    document.getElementById('result-box').style.display = 'flex';

    // Trigger mobile re-ordering state (ACK QR on top)
    const screenRecv = document.getElementById('screen-recv');
    if (screenRecv) screenRecv.classList.add('is-complete');

    // Double vibration on completion
    if ('vibrate' in navigator) {
        navigator.vibrate([40, 50, 40]);
    }

    // Try text decode
    let decodedText = '';
    try {
        decodedText = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
        document.getElementById('result-text').value = decodedText;
    } catch {
        decodedText = `[Binary Payload: ${decompressed.length} bytes]`;
        document.getElementById('result-text').value = decodedText;
    }

    // Auto-copy to clipboard on mobile
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;
    if (isMobile && decodedText) {
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
    labState();
};

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    syncSizeButtons();
    renderLog();

    // Check PWA service worker (off under the lab remote, so every reload gets fresh files)
    if (LAB_REMOTE) {
        startLabRemote();
    } else if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(console.warn);
    }
});


// =====================================================================================
// Density test card (lab): the sender shows a grid of known pseudo-random squares; the receiver
// counts how many it misreads. See card.js.
// =====================================================================================
function cardStatus() {
    if (!cardRun) return { running: false };
    const c = cardRun;
    return { running: true, k: c.k, fps: c.fps, grid: c.N, levels: c.L, seed: c.seed, greys: c.greys,
        screenPxPerSquare: c.cssPerModule, devicePxPerSquare: c.devPerModule };
}

function drawCard() {
    const c = cardRun;
    paintCard(c.img, c.layout, c.L, c.seed, c.k, c.greys, performance.now() < c.blankUntil);
    c.offCtx.putImageData(c.img, 0, 0);
    const container = frameCanvas.parentElement;
    const cs = getComputedStyle(container);
    const availW = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const dpr = window.devicePixelRatio || 1;
    const quiet = 2;
    const span = c.N + quiet * 2;
    const scale = Math.max(1, Math.floor(Math.min(availW, availH) * dpr / span));
    const px = span * scale;
    if (frameCanvas.width !== px) {
        frameCanvas.width = px;
        frameCanvas.height = px;
        frameCanvas.style.width = `${px / dpr}px`;
        frameCanvas.style.height = `${px / dpr}px`;
    }
    const ctx = frameCtx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.drawImage(c.off, quiet * scale, quiet * scale, c.N * scale, c.N * scale);
    c.devPerModule = scale;
    c.cssPerModule = scale / dpr;
    document.getElementById('beam-stats').innerText = `Test card ${c.N}×${c.N} · ${c.L} levels · frame ${c.k} · ${c.fps} fps`;
}

function startCard({ N, L, fps, seed, greys, blank = 1.5 }) {
    if (currentTab() !== 'send') switchTab('send');
    document.getElementById('screen-send').classList.add('is-beaming');
    setupFrameCanvas();
    const off = document.createElement('canvas');
    off.width = N;
    off.height = N;
    const offCtx = off.getContext('2d');
    cardRun = { N, L, fps, seed, greys, k: 0, layout: cardLayout(N), off, offCtx, img: offCtx.createImageData(N, N), rafId: null,
        blankUntil: performance.now() + blank * 1000 };
    let last = -Infinity;
    const tick = (now) => {
        if (!cardRun) return;
        const interval = 1000 / cardRun.fps;
        if (now - last >= interval - 4) {
            last = now - last < interval * 2 ? last + interval : now;
            drawCard();
            cardRun.k++;
        }
        cardRun.rafId = requestAnimationFrame(tick);
    };
    drawCard();
    cardRun.k++;
    last = performance.now();
    cardRun.rafId = requestAnimationFrame(tick);
    report('card-start', { grid: N, levels: L, fps, seed, devPerModule: cardRun.devPerModule });
}

function stopCard() {
    const c = cardRun;
    if (!c) return null;
    cancelAnimationFrame(c.rafId);
    cardRun = null;
    frameCanvas = null;
    frameCtx = null;
    document.getElementById('screen-send').classList.remove('is-beaming');
    renderPlaceholder();
    document.getElementById('beam-stats').innerText = 'Stream standby';
    return { framesShown: c.k };
}

function nextVideoFrame(video) {
    return new Promise(resolve => {
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback((now, meta) => resolve(meta));
        else requestAnimationFrame(() => resolve(null));
    });
}

async function measureCard({ grid = 101, levels = 2, seed = 1, k0 = 0, fps = 4, seconds = 6, rate = 6 } = {}) {
    if (currentTab() !== 'recv') switchTab('recv');
    if (!isScanning) { await initCamera(); await waitFor(800); }
    const video = document.getElementById('camera-video');
    if (!video.videoWidth) throw new Error('camera is off');
    cardBusy = true;
    const an = new CardAnalyzer({ N: grid, L: levels, seed });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const s = { pictures: 0, located: 0, lostLocate: 0, notFound: 0, torn: 0, blended: 0, clean: 0,
        ser: [], serClean: [], berClean: [], r: [], kSeen: new Set(), ms: 0,
        lvSum: new Float64Array(levels), lvSq: new Float64Array(levels), lvN: 0 };
    const t0 = performance.now();
    let lastGrab = 0, lastLocate = -Infinity, lastK = k0;
    try {
        while (performance.now() - t0 < seconds * 1000) {
            await nextVideoFrame(video);
            const now = performance.now();
            if (now - lastGrab < 1000 / rate) continue;
            lastGrab = now;
            const W = video.videoWidth, H = video.videoHeight;
            if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
            ctx.drawImage(video, 0, 0, W, H);
            const img = ctx.getImageData(0, 0, W, H);
            const a0 = performance.now();
            s.pictures++;
            // Lock on once (during the sender's blank frames), then keep that lock: the phone and
            // screen don't move. If a picture doesn't match the fixed squares, try to re-lock, but
            // keep the old lock if that fails (data frames are much harder to lock on to).
            if (!an.positions) {
                if (!an.locate(img)) { s.lostLocate++; continue; }
                s.located++;
            } else if (!an.stillLocated(img)) {
                const saved = { positions: an.positions, map: an.map, modulePx: an.modulePx, corners: an.corners };
                if (an.locate(img)) s.located++;
                else Object.assign(an, saved);
            }
            const kExp = k0 + ((now - t0) / 1000) * fps;
            const from = Math.max(0, Math.floor(Math.min(lastK, kExp)) - 2);
            const to = Math.ceil(kExp + fps * 0.7 + 3);
            const candidates = [];
            for (let k = from; k <= to; k++) candidates.push(k);
            const res = an.analyze(img, candidates);
            s.ms += performance.now() - a0;
            if (!res.found) { s.notFound++; continue; }
            lastK = res.k;
            s.kSeen.add(res.k);
            s.r.push(res.r);
            s.ser.push(res.ser);
            const blended = res.second > 0.25;
            if (res.torn) s.torn++;
            if (blended) s.blended++;
            if (!res.torn && !blended) {
                s.clean++;
                s.serClean.push(res.ser);
                s.berClean.push(res.ber);
                res.levels.forEach((l, v) => { s.lvSum[v] += l.mean; s.lvSq[v] += l.sd; });
                s.lvN++;
            }
        }
    } finally {
        cardBusy = false;
    }
    const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const levelsOut = s.lvN ? Array.from({ length: levels }, (_, v) => ({ mean: +(s.lvSum[v] / s.lvN).toFixed(1), sd: +(s.lvSq[v] / s.lvN).toFixed(1) })) : null;
    let separation = null;
    if (levelsOut) {
        separation = Infinity;
        for (let v = 1; v < levels; v++) separation = Math.min(separation, (levelsOut[v].mean - levelsOut[v - 1].mean) / (levelsOut[v].sd + levelsOut[v - 1].sd));
        separation = +separation.toFixed(2);
    }
    const analysed = s.pictures - s.lostLocate - s.notFound;
    const summary = {
        grid, levels, fps, seconds,
        camera: `${video.videoWidth}x${video.videoHeight}`,
        cameraPxPerSquare: an.modulePx ? +an.modulePx.toFixed(2) : null,
        corners: an.corners || null,
        pictures: s.pictures, analysed, notLocated: s.lostLocate, notMatched: s.notFound, lockOns: s.located,
        distinctFrames: s.kSeen.size,
        cleanPct: analysed ? Math.round((100 * s.clean) / analysed) : 0,
        tornPct: analysed ? Math.round((100 * s.torn) / analysed) : 0,
        blendedPct: analysed ? Math.round((100 * s.blended) / analysed) : 0,
        serCleanMedian: median(s.serClean), serCleanMean: mean(s.serClean),
        berCleanMedian: median(s.berClean),
        serAllMedian: median(s.ser),
        corrMedian: median(s.r),
        levelStats: levelsOut, separation,
        analysisMs: analysed ? Math.round(s.ms / analysed) : null,
    };
    for (const k of ['serCleanMedian', 'serCleanMean', 'berCleanMedian', 'serAllMedian', 'corrMedian']) {
        if (summary[k] !== null) summary[k] = +summary[k].toFixed(4);
    }
    report('card-result', summary);
    return summary;
}

// =====================================================================================
// RapidFire code v1 (lab): dense black-and-white frames, one fountain packet per band (rfc.js)
// =====================================================================================
function blitGrid(off, N) {
    const container = frameCanvas.parentElement;
    const cs = getComputedStyle(container);
    const availW = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const dpr = window.devicePixelRatio || 1;
    const quiet = 2, span = N + quiet * 2;
    const scale = Math.max(1, Math.floor(Math.min(availW, availH) * dpr / span));
    const px = span * scale;
    if (frameCanvas.width !== px) {
        frameCanvas.width = px;
        frameCanvas.height = px;
        frameCanvas.style.width = `${px / dpr}px`;
        frameCanvas.style.height = `${px / dpr}px`;
    }
    frameCtx.imageSmoothingEnabled = false;
    frameCtx.fillStyle = '#ffffff';
    frameCtx.fillRect(0, 0, px, px);
    frameCtx.drawImage(off, quiet * scale, quiet * scale, N * scale, N * scale);
    return scale;
}

// stagger: 'down' or 'up' changes the bands one after another instead of all at once (each band
// still changes `fps` times a second), so a picture taken while the screen changes loses only the
// bands changing then. Any band can be decoded on its own, so the receiver needs no change.
async function startRfc({ kb = 50, fps = 10, grid = 249, bands = 8, ecc = 16, levels = 2, greys = null, blank = 1.5, blankEvery = 45, text, stagger = null, shiftEvery = 0, ahead = 4 } = {}) {
    if (isSending) stopSending('lab');
    if (cardRun) stopCard();
    if (rfcRun) stopRfc();
    const rfc = rfcPlan(grid, bands, ecc, levels);
    if (text === undefined) {
        const words = [];
        let size = 0;
        while (size < kb * 1024) {
            const w = Math.random().toString(36).slice(2, 3 + Math.floor(Math.random() * 8));
            words.push(w);
            size += w.length + 1;
        }
        text = words.join(' ');
    }
    const bytes = new TextEncoder().encode(text);
    const { packed, compressed } = await packPayload(bytes);
    const enc = new FountainEncoder(packed, rfc.packetBytes - HEADER_BYTES);
    if (currentTab() !== 'send') switchTab('send');
    document.getElementById('screen-send').classList.add('is-beaming');
    setupFrameCanvas();
    const off = document.createElement('canvas');
    off.width = grid;
    off.height = grid;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(grid, grid);
    rfcRun = { rfc, enc, fps, off, offCtx, img, frame: 0, blankUntil: performance.now() + blank * 1000, blankEvery, rafId: null, startedAt: performance.now(), timing: [] };
    const draw = () => {
        const r = rfcRun;
        const isBlank = performance.now() < r.blankUntil || (r.blankEvery && r.frame % r.blankEvery === 0);
        paintFrame(r.img, r.rfc, isBlank ? null : buildFrame(r.rfc, Array.from({ length: r.rfc.bands }, () => r.enc.nextDroplet())), greys);
        r.offCtx.putImageData(r.img, 0, 0);
        r.scale = blitGrid(r.off, r.rfc.N);
        r.frame++;
        document.getElementById('beam-stats').innerText = `RapidFire v1 ${grid}×${grid} · frame ${r.frame} · ${r.enc.K} blocks · ${fps} fps`;
    };
    if (stagger) {
        // Every screen refresh: give each band whose turn has come a new packet, then redraw
        const period = 1000 / fps, t0 = performance.now();
        const packets = new Array(bands).fill(null);
        const due = Array.from({ length: bands }, (_, b) => {
            const k = stagger === 'up' ? bands - 1 - b : b;
            return t0 + blank * 1000 + (k * period) / bands;
        });
        let wasBlank = true;
        const stick = (now) => {
            const r = rfcRun;
            if (!r) return;
            const since = now - t0 - blank * 1000;
            // blank for the lead-in, then for one period every blankEvery periods (lock-on aid)
            const isBlank = since < 0 || (r.blankEvery && since % (r.blankEvery * period) < period);
            let changed = isBlank !== wasBlank;
            if (!isBlank) {
                for (let b = 0; b < bands; b++) {
                    if (now >= due[b] || !packets[b]) {
                        packets[b] = r.enc.nextDroplet();
                        while (due[b] <= now) due[b] += period;
                        changed = true;
                    }
                }
            } else {
                packets.fill(null);
            }
            wasBlank = isBlank;
            if (changed) {
                paintFrame(r.img, r.rfc, isBlank ? null : buildFrame(r.rfc, packets), greys);
                r.offCtx.putImageData(r.img, 0, 0);
                r.scale = blitGrid(r.off, r.rfc.N);
                r.frame++;
            }
            r.rafId = requestAnimationFrame(stick);
        };
        rfcRun.rafId = requestAnimationFrame(stick);
        const info = { transferId: enc.transferId, K: enc.K, chunk: enc.chunkSize, packetBytes: rfc.packetBytes, perFrame: rfc.packetBytes * bands, bytes: bytes.length, sentBytes: packed.length, compressed, grid, bands, ecc, levels, fps, stagger };
        report('rfc-start', info);
        return info;
    }
    let last = -Infinity;
    // Frames are built a few ahead on a background thread: building one takes longer than a screen
    // refresh for dense codes, and a frame shown late lands across two camera pictures.
    const run = rfcRun;
    let blankImg = null;
    if (ahead) {
        try {
            const worker = new Worker(new URL('./rfc-send-worker.js', import.meta.url), { type: 'module' });
            run.worker = worker;
            run.ready = [];
            run.inFlight = 0;
            run.spare = [];
            run.request = () => {
                while (run.ready.length + run.inFlight < ahead) {
                    run.inFlight++;
                    const buffer = run.spare.pop();
                    worker.postMessage({ type: 'build', buffer }, buffer ? [buffer] : []);
                }
            };
            worker.onmessage = (e) => {
                run.inFlight--;
                run.buildMs = run.buildMs ? run.buildMs * 0.9 + e.data.ms * 0.1 : e.data.ms;
                run.ready.push(new ImageData(new Uint8ClampedArray(e.data.buffer), grid, grid));
            };
            worker.onerror = (e) => { run.workerError = String(e.message || e); run.worker = null; };
            worker.postMessage({ type: 'init', grid, bands, ecc, levels, greys, data: packed, chunk: rfc.packetBytes - HEADER_BYTES, transferId: enc.transferId });
            blankImg = offCtx.createImageData(grid, grid);
            paintFrame(blankImg, rfc, null, greys);
            run.request();
        } catch (e) {
            run.workerError = String(e.message || e);
            run.worker = null;
        }
    }
    const showReady = () => {
        const isBlank = performance.now() < run.blankUntil || (run.blankEvery && run.frame % run.blankEvery === 0);
        const pic = isBlank ? blankImg : run.ready.shift();
        if (!pic) { run.late = (run.late || 0) + 1; return false; } // not built yet: try on the next refresh
        offCtx.putImageData(pic, 0, 0);
        run.scale = blitGrid(off, grid);
        run.frame++;
        if (!isBlank) { run.spare.push(pic.data.buffer); run.request(); }
        return true;
    };
    const tick = (now) => {
        if (!rfcRun || rfcRun !== run) return;
        const interval = 1000 / run.fps;
        if (now - last >= interval - 4) {
            const d0 = performance.now();
            let shown = true;
            if (run.worker) shown = showReady(); else draw();
            if (shown) {
                last = now - last < interval * 2 ? last + interval : now;
                if (run.timing.length < 3000) run.timing.push([Math.round(now), +(performance.now() - d0).toFixed(1), Math.round(d0 - now)]);
                // Every so often hold a frame one screen refresh longer, so the sender's timing
                // can't stay lined up badly with the camera's for long
                if (shiftEvery && run.frame % shiftEvery === 0) last += 1000 / 60;
                if (run.frame % 15 === 0) document.getElementById('beam-stats').innerText = `RapidFire v1 ${grid}×${grid} · frame ${run.frame} · ${enc.K} blocks · ${fps} fps`;
            }
        }
        run.rafId = requestAnimationFrame(tick);
    };
    run.rafId = requestAnimationFrame(tick);
    const info = { transferId: enc.transferId, K: enc.K, chunk: enc.chunkSize, packetBytes: rfc.packetBytes, perFrame: rfc.packetBytes * bands, bytes: bytes.length, sentBytes: packed.length, compressed, grid, bands, ecc, levels, fps };
    report('rfc-start', info);
    return info;
}

function stopRfc() {
    const r = rfcRun;
    if (!r) return null;
    cancelAnimationFrame(r.rafId);
    if (r.worker) r.worker.terminate();
    rfcRun = null;
    frameCanvas = null;
    frameCtx = null;
    document.getElementById('screen-send').classList.remove('is-beaming');
    renderPlaceholder();
    document.getElementById('beam-stats').innerText = 'Stream standby';
    return { frames: r.frame, seconds: +((performance.now() - r.startedAt) / 1000).toFixed(2) };
}

// Options for comparing in the lab: fastRs (our Reed-Solomon vs jsQR's), erasures (retry failed
// codewords naming their least certain bytes), prefetch (copy the next camera frame while decoding),
// workers (decode in that many background threads; on the test phone they ran no faster).
async function receiveRfc({ grid = 249, bands = 8, ecc = 16, levels = 2, seconds = 30, gpu = false, frames = true,
    fastRs = true, erasures = [0.5, 0.875], prefetch = true, workers = 0, track = 5, steer = false } = {}) {
    if (currentTab() !== 'recv') switchTab('recv');
    if (!isScanning) { await initCamera(); await waitFor(800); }
    const video = document.getElementById('camera-video');
    if (!video.videoWidth) throw new Error('camera is off');
    cardBusy = true;
    const rfc = rfcPlan(grid, bands, ecc, levels);
    const colour = levels === 8; // 3 bits a square as red/green/blue on or off
    if (colour) gpu = false;
    const an = new CardAnalyzer({ N: grid, L: 2, seed: 0 });
    const dec = new FountainDecoder();
    const rsDecode = fastRs ? fastRsDecode : window.jsQR.internals.rsDecode;
    const readOpts = { erasures: fastRs ? erasures : [] };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const s = { pictures: 0, lockOns: 0, unlocked: 0, relocks: 0, bandsOk: 0, bandsBad: 0, grabMs: 0, decodeMs: 0, idleMs: 0, skipped: 0, badByBand: [], firstGood: null, done: null };
    let crop = null, badStreak = 0, sampler = null, gpuCheck = null, yBuf = null, useFrames = frames && typeof VideoFrame !== 'undefined';
    let reader = null, readerTrack = null, nextGrab = null, bufTurn = 0;
    const yBufs = [{}, {}, {}];
    s.grabWaitMs = 0;
    s.thresholdMs = 0;
    s.readMs = 0;
    s.dropped = 0;
    s.goodHist = [];
    s.seq = '';
    s.sep = [];
    s.lockLog = [];
    s.addSeq = []; // ms the fountain decoder took per picture
    s.workSeq = []; // threshold, read ms per picture
    s.grabSeq = [];
    s.refines = 0;
    s.refineMs = 0;
    s.moves = [];
    s.marginSeq = [];
    s.decoded = 0;
    s.rescued = 0;
    // What one decoded picture gives: its packets go to the fountain decoder. A bad lock shows up
    // as picture after picture with no good band: drop it and lock on again (the sender shows a
    // blank frame every so often for exactly this).
    const takePackets = (packets) => {
        let good = 0;
        packets.forEach((p, b) => { if (!p) s.badByBand[b] = (s.badByBand[b] || 0) + 1; });
        for (const p of packets) {
            if (!p) { s.bandsBad++; continue; }
            s.bandsOk++;
            good++;
            if (s.firstGood === null) s.firstGood = performance.now();
            dec.addDroplet(p);
        }
        s.goodHist[good] = (s.goodHist[good] || 0) + 1; // pictures by number of good bands
        s.seq += good < 36 ? good.toString(36) : '+'; // one character per picture: its good bands, base 36
        badStreak = good ? 0 : badStreak + 1;
        if (badStreak >= 40) {
            an.positions = null;
            an.map = null;
            nextGrab = null; // its copy is of the old region; grab() marks it stale
            badStreak = 0;
            s.relocks++;
        }
    };
    // Decoding threads: each takes one picture at a time; a picture that arrives while all are
    // busy is dropped (a newer one is coming anyway). workers = 0 decodes on this thread.
    const pool = [];
    if (workers > 0 && fastRs) {
        try {
            for (let w = 0; w < workers; w++) {
                const worker = new Worker(new URL('./rfc-worker.js', import.meta.url), { type: 'module' });
                const slot = { worker, busy: false };
                worker.onmessage = (e) => {
                    slot.busy = false;
                    const m = e.data;
                    s.thresholdMs += m.thresholdMs;
                    s.readMs += m.readMs;
                    s.rescued += m.rescued;
                    s.decoded++;
                    if (!dec.isDone) takePackets(m.packets);
                };
                worker.onerror = (e) => { slot.busy = false; slot.failed = String(e.message || e); };
                worker.postMessage({ type: 'init', grid, bands, ecc, levels, erasures: readOpts.erasures });
                pool.push(slot);
            }
        } catch (e) {
            gpuCheck = `workers: ${e.message || e}`;
        }
    }
    // Timing: when the camera's pictures fall on the moments the sender's screen changes, every
    // picture mixes two frames, and with both at 30 a second it stays that way for seconds. Slowing
    // the camera by a tenth for a few pictures slides its timing (a few ms a picture)
    // until the pictures are clean again.
    const timing = { recent: [], rest: 0, tries: 0, busy: false, log: [] };
    const steerCamera = async () => {
        const tr = video.srcObject.getVideoTracks()[0];
        const { width, height, frameRate } = tr.getSettings();
        timing.busy = true;
        timing.log.push([Math.round(performance.now() - t0), s.pictures]);
        try {
            const size = { width: { exact: width }, height: { exact: height } };
            // measured on an iPad: 80 ms at 27 fps moves the timing about 10 ms. Smaller steps only
            // reached deeper into the bad zone (it can only slide one way).
            await tr.applyConstraints({ ...size, frameRate: frameRate * 0.9 });
            await waitFor(80);
            await tr.applyConstraints({ ...size, frameRate });
        } catch (e) {
            timing.error = String(e.message || e);
            steer = false;
        }
        timing.busy = false;
        timing.recent = [];
        timing.rest = 8; // pictures until the change shows (the camera lags by about 0.2 s)
    };
    const steerOn = (good, margin) => {
        if (margin < 25) return; // a blank frame says nothing about the timing
        if (timing.busy) return;
        if (timing.rest > 0) { timing.rest--; return; }
        timing.recent.push(good / bands);
        if (timing.recent.length > 3) timing.recent.shift();
        if (timing.recent.length < 3) return;
        const q = timing.recent.reduce((a, b) => a + b, 0) / 3;
        if (q > 0.75) { timing.tries = 0; return; }
        // more than a full turn of slides didn't help: it's something else (focus, light); leave it a while
        if (timing.tries >= 5) { timing.tries = 0; timing.rest = 60; return; }
        timing.tries++;
        steerCamera();
    };
    // Keep the squares' positions on the code as the picture shifts (see refineY)
    let grabs = 0;
    const refine = (Y, stride, rows, x, y) => {
        const r0 = performance.now();
        const moved = an.refineY(Y, stride, rows, x, y);
        s.refineMs += performance.now() - r0;
        s.refines++;
        s.moves.push(moved === null ? -1 : +moved.toFixed(2));
    };
    // Read the next camera frame and copy the card region's brightness. Started before the
    // current picture is decoded, so the copy (done off the main thread) overlaps the decoding.
    const grab = async () => {
        const { value, done } = await reader.read();
        if (done) return { done: true };
        const c = crop, buf = yBufs[bufTurn++ % yBufs.length];
        try {
            if (!an.positions || !c) return { stale: true };
            const rect = { x: c.x, y: c.y, width: c.w, height: c.h };
            const need = value.allocationSize({ rect });
            if (!buf.b || buf.b.length < need) buf.b = new Uint8Array(need);
            const layout = await value.copyTo(buf.b, { rect });
            if (value.format !== 'I420' && value.format !== 'NV12' && value.format !== 'I420A') throw new Error(`frame format ${value.format}`);
            if (!an.positions || c !== crop) return { stale: true };
            if (track && ++grabs % track === 0) refine(buf.b.subarray(layout[0].offset), layout[0].stride, c.h, c.x, c.y);
            const lum = colour ? an.sampleYUV(buf.b, layout, value.format, c.h, c.x, c.y)
                : an.sampleY(buf.b.subarray(layout[0].offset), layout[0].stride, c.h, c.x, c.y);
            return { crop: c, ts: value.timestamp, lum };
        } catch (e) {
            return { error: String(e.message || e) };
        } finally {
            value.close();
        }
    };
    const t0 = performance.now();
    // Ask for the next camera frame before processing the current one, so a frame that
    // arrives while we're busy is waiting for us instead of being skipped
    let pending = nextVideoFrame(video);
    try {
        let lastPresented = null, lastWorkEnd = null, lastTs = null;
        while (performance.now() - t0 < seconds * 1000 && !dec.isDone) {
            // Once locked on, read frames straight from the camera track: they arrive as the
            // camera makes them, not on the screen's repaint schedule (which cost ~17 ms a frame)
            let trackFrame = null, ready = null;
            if (an.positions && useFrames && typeof MediaStreamTrackProcessor !== 'undefined') {
                if (!reader) {
                    readerTrack = video.srcObject.getVideoTracks()[0].clone();
                    reader = new MediaStreamTrackProcessor({ track: readerTrack, maxBufferSize: 1 }).readable.getReader();
                }
                if (prefetch) {
                    const w0 = performance.now();
                    const got = await (nextGrab || grab());
                    nextGrab = null;
                    if (got.done) break;
                    if (got.error) { useFrames = false; gpuCheck = `VideoFrame: ${got.error}`; continue; }
                    if (got.stale || got.crop !== crop) continue; // copied before a re-lock
                    nextGrab = grab(); // the next copy runs while this picture is decoded
                    s.grabWaitMs += performance.now() - w0;
                    ready = got;
                    if (lastTs !== null) s.skipped += Math.max(0, Math.round((got.ts - lastTs) / 33333) - 1);
                    lastTs = got.ts;
                } else {
                    const { value, done } = await reader.read();
                    if (done) break;
                    trackFrame = value;
                    if (lastTs !== null) s.skipped += Math.max(0, Math.round((value.timestamp - lastTs) / 33333) - 1);
                    lastTs = value.timestamp;
                }
            } else {
                const meta = await pending;
                pending = nextVideoFrame(video);
                if (meta && lastPresented !== null) s.skipped += Math.max(0, meta.presentedFrames - lastPresented - 1);
                if (meta) lastPresented = meta.presentedFrames;
            }
            const g0 = performance.now();
            if (lastWorkEnd !== null) s.idleMs += g0 - lastWorkEnd;
            s.pictures++;
            let img, ox = 0, oy = 0;
            if (!an.positions) {
                // not locked on yet: grab the whole picture and look for the card
                const W = video.videoWidth, H = video.videoHeight;
                if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
                ctx.drawImage(video, 0, 0, W, H);
                img = ctx.getImageData(0, 0, W, H);
                if (!an.locate(img)) { s.unlocked++; continue; }
                s.lockOns++;
                s.lockLog.push({ t: Math.round(performance.now() - t0), score: an.meshScore && +an.meshScore.toFixed(3), corners: an.corners, at: s.pictures });
                // Prefer the GPU: it reads just the square centres instead of copying the picture
                sampler = null;
                if (gpu) {
                    try {
                        sampler = new GpuSampler(an.positions);
                        const a = sampler.sample(video), b = an.sample(img);
                        let d = 0;
                        for (let j = 0; j < a.length; j++) d += Math.abs(a[j] - b[j]);
                        gpuCheck = +(d / a.length).toFixed(2); // average difference from the CPU path
                    } catch (e) {
                        sampler = null;
                        gpuCheck = String(e.message || e);
                    }
                }
                // otherwise grab only the card's bounding box (plus a margin)
                const xs = an.corners.map(c => c[0]), ys = an.corners.map(c => c[1]);
                const m = an.modulePx * 4;
                crop = {
                    x: Math.max(0, Math.floor(Math.min(...xs) - m)), y: Math.max(0, Math.floor(Math.min(...ys) - m)),
                };
                crop.x &= ~1;
                crop.y &= ~1;
                crop.w = (Math.min(video.videoWidth, Math.ceil(Math.max(...xs) + m)) - crop.x) & ~1;
                crop.h = (Math.min(video.videoHeight, Math.ceil(Math.max(...ys) + m)) - crop.y) & ~1;
            } else if (useFrames) {
                // VideoFrame: copy just the card region's brightness plane (no colour conversion)
                img = null;
            } else if (sampler) {
                img = null;
            } else {
                if (canvas.width !== crop.w || canvas.height !== crop.h) { canvas.width = crop.w; canvas.height = crop.h; }
                ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
                img = ctx.getImageData(0, 0, crop.w, crop.h);
                ox = crop.x;
                oy = crop.y;
            }
            let lum;
            if (ready) {
                lum = ready.lum;
            } else if (img) {
                lum = colour ? an.sampleRGB(img, ox, oy) : an.sample(img, ox, oy);
            } else if (useFrames) {
                const f = trackFrame || new VideoFrame(video);
                const rect = { x: crop.x, y: crop.y, width: crop.w, height: crop.h };
                try {
                    const need = f.allocationSize({ rect });
                    if (!yBuf || yBuf.length < need) yBuf = new Uint8Array(need); // the region can change after a re-lock
                    const layout = await f.copyTo(yBuf, { rect });
                    if (f.format !== 'I420' && f.format !== 'NV12' && f.format !== 'I420A') throw new Error(`frame format ${f.format}`);
                    if (track && s.pictures % track === 0) refine(yBuf.subarray(layout[0].offset), layout[0].stride, crop.h, crop.x, crop.y);
                    lum = colour ? an.sampleYUV(yBuf, layout, f.format, crop.h, crop.x, crop.y)
                        : an.sampleY(yBuf.subarray(layout[0].offset), layout[0].stride, crop.h, crop.x, crop.y);
                } catch (e) {
                    useFrames = false; // fall back to the canvas path from the next picture
                    trackFrame = null;
                    gpuCheck = `VideoFrame: ${e.message || e}`;
                    f.close();
                    continue;
                }
                f.close();
            } else {
                lum = sampler.sample(video);
            }
            const g1 = performance.now();
            if (colour && s.sep.length < 12) s.sep.push(colourSeparation(rfc, lum));
            const live = pool.filter(w => !w.failed);
            if (live.length) {
                const free = live.find(w => !w.busy);
                if (free) {
                    free.busy = true;
                    free.worker.postMessage({ type: 'picture', id: s.pictures, lum }, [lum.buffer]);
                } else {
                    s.dropped++;
                }
            } else {
                const bits = threshold(rfc, lum);
                const g2 = performance.now();
                const packets = readFrame(rfc, bits, rsDecode, readOpts);
                s.thresholdMs += g2 - g1;
                s.readMs += performance.now() - g2;
                s.rescued = rfc.rescued || 0;
                s.decoded++;
                // how clearly the squares separate (sampled): low = blurred or two frames mixed
                if (rfc.margin) { let v = 0, c = 0; for (let j = 0; j < rfc.margin.length; j += 97) { v += rfc.margin[j]; c++; } s.marginSeq.push(Math.round(v / c)); }
                const okBands = steer ? packets.reduce((a, q) => a + (q ? 1 : 0), 0) : 0;
                if (steer) steerOn(okBands, s.marginSeq[s.marginSeq.length - 1]);
                const a0 = performance.now();
                takePackets(packets);
                s.addSeq.push(+(performance.now() - a0).toFixed(1));
                s.workSeq.push(+(g2 - g1).toFixed(1), +(a0 - g2).toFixed(1));
            }
            s.grabMs += g1 - g0;
            s.grabSeq.push(+(g1 - g0).toFixed(1));
            s.decodeMs += performance.now() - g1;
            lastWorkEnd = performance.now();
        }
    } finally {
        cardBusy = false;
        for (const w of pool) w.worker.terminate();
        if (reader) { try { reader.cancel(); } catch (e) {} }
        if (readerTrack) readerTrack.stop();
    }
    s.done = dec.isDone ? performance.now() : null;
    let verified = false, bytes = 0, compressed = false;
    if (dec.isDone) {
        const out = await unpackPayload(dec.getRecoveredData());
        verified = out.verified;
        bytes = out.bytes.length;
        compressed = out.compressed;
    }
    const secs = s.done && s.firstGood ? (s.done - s.firstGood) / 1000 : null;
    const result = {
        done: dec.isDone, verified, bytes, sentBytes: dec.totalLength, compressed,
        blocks: dec.K, solved: dec.solvedCount, packetsRead: dec.receivedCount,
        seconds: secs !== null ? +secs.toFixed(2) : null,
        speed: secs ? Math.round(bytes / secs) : null,
        wireSpeed: secs ? Math.round(dec.totalLength / secs) : null,
        pictures: s.pictures, lockOns: s.lockOns, unlocked: s.unlocked, relocks: s.relocks,
        bandsOk: s.bandsOk, bandsBad: s.bandsBad,
        picturesPerSec: +(s.pictures / ((performance.now() - t0) / 1000)).toFixed(1),
        grabMs: s.pictures ? Math.round(s.grabMs / s.pictures) : null,
        decodeMs: s.pictures - s.unlocked ? Math.round(s.decodeMs / (s.pictures - s.unlocked)) : null,
        camera: `${video.videoWidth}x${video.videoHeight}`,
        squarePx: an.modulePx ? +an.modulePx.toFixed(2) : null,
        crop: crop ? `${crop.w}x${crop.h}` : null,
        sampler: useFrames ? 'videoframe' : sampler ? 'gpu' : 'canvas', gpuCheck,
        rs: fastRs ? 'rs.js' : 'jsQR', erasures: readOpts.erasures, prefetch,
        grabWaitMs: s.pictures ? +(s.grabWaitMs / s.pictures).toFixed(1) : null,
        thresholdMs: s.decoded ? +(s.thresholdMs / s.decoded).toFixed(1) : null,
        readMs: s.decoded ? +(s.readMs / s.decoded).toFixed(1) : null,
        rescued: s.rescued, decoded: s.decoded, dropped: s.dropped, colourSeparation: s.sep, seq: s.seq, marginSeq: s.marginSeq, lockLog: s.lockLog, steer, steerLog: timing.log, steerError: timing.error || null, addSeq: s.addSeq, workSeq: s.workSeq, grabSeq: s.grabSeq, refineMs: s.refines ? +(s.refineMs / s.refines).toFixed(1) : null, moves: s.moves, goodHist: Array.from({ length: bands + 1 }, (_, k) => s.goodHist[k] || 0),
        workers: pool.filter(w => !w.failed).length, workerError: (pool.find(w => w.failed) || {}).failed || null,
        badByBand: s.badByBand, cameraFramesSkipped: s.skipped, avgWaitMs: s.pictures ? Math.round(s.idleMs / s.pictures) : null,
    };
    report('rfc-done', result);
    return result;
}

// =====================================================================================
// Lab remote: open the page with ?lab=1 on a home-network address and it connects to the
// lab server, which relays commands sent from the Mac (.lab/ctl.cjs). Results go back to
// the server; measurements keep flowing as telemetry. Never active on a public host.
// =====================================================================================
const LAB_REMOTE = LAB_MODE && new URLSearchParams(location.search).get('lab') === '1';
const CLIENT_ID = (() => {
    let tab = null;
    try {
        tab = sessionStorage.getItem('rapidfire.tabId');
        if (!tab) {
            tab = Math.random().toString(36).slice(2, 6);
            sessionStorage.setItem('rapidfire.tabId', tab);
        }
    } catch (e) {
        tab = Math.random().toString(36).slice(2, 6);
    }
    return `${DEVICE_ID}-${tab}`;
})();
let wakeLock = null;

function currentTab() {
    return document.getElementById('screen-recv').classList.contains('active') ? 'recv' : 'send';
}

function labState() {
    if (!LAB_REMOTE) return;
    const state = {
        client: CLIENT_ID,
        role: currentTab() === 'recv' ? 'receiver' : 'sender',
        tab: currentTab(),
        sending: isSending,
        scanning: isScanning,
        v: APP_VERSION,
        url: location.href,
        wakeLock: !!wakeLock,
    };
    fetch('/api/state', { method: 'POST', body: JSON.stringify(state), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

async function holdWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; labState(); });
    } catch (e) {
        wakeLock = null;
    }
    labState();
}

function videoTrack() {
    return videoStream ? videoStream.getVideoTracks()[0] : null;
}

function jsonSafe(value) {
    return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'number' && !isFinite(v) ? String(v) : v)) ?? 'null');
}

async function uploadSnapshot(blob, extra) {
    const res = await fetch(`/api/snapshot?device=${encodeURIComponent(CLIENT_ID)}`, { method: 'POST', body: blob });
    return { ...(await res.json()), bytes: blob.size, ...extra };
}

const waitFor = ms => new Promise(r => setTimeout(r, ms));

const LAB_COMMANDS = {
    // Where the page is and what it's doing
    ping: async () => ({
        client: CLIENT_ID, v: APP_VERSION, url: location.href, tab: currentTab(),
        sending: isSending, scanning: isScanning, wakeLock: !!wakeLock,
        visible: document.visibilityState,
        screen: DEVICE_INFO.screen, ua: DEVICE_INFO.ua,
        frameSize, fps: targetFps,
        encoder: encoder ? { transferId: encoder.transferId, K: encoder.K, chunk: encoder.chunkSize, framesShown: encoder.lastId + 1 } : null,
        decoder: { transferId: decoder.transferId, solved: decoder.solvedCount, K: decoder.K, framesRead: decoder.receivedCount, done: decoder.isDone },
        camera: videoTrack() ? videoTrack().getSettings() : null,
    }),

    // Reload with fresh files, coming back to the same tab
    reload: async () => {
        const url = new URL(location.href);
        url.searchParams.set('tab', currentTab());
        setTimeout(() => location.replace(url), 100);
        return { reloading: url.href };
    },

    // Reload with changed address parameters, e.g. { "scans": "1" }; null removes one
    open: async (args) => {
        const url = new URL(location.href);
        for (const [k, v] of Object.entries(args)) v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
        url.searchParams.set('lab', '1');
        if (!url.searchParams.has('tab')) url.searchParams.set('tab', currentTab());
        setTimeout(() => location.replace(url), 100);
        return { opening: url.href };
    },

    tab: async ({ name }) => {
        switchTab(name === 'recv' || name === 'receiver' ? 'recv' : 'send');
        return { tab: currentTab() };
    },

    // Start beaming. args: preset ('random' default), kb (random size), text, size (S/M/L/XL), fps (8/15 or any)
    beam: async ({ preset = 'random', kb = 50, text, size, fps } = {}) => {
        if (isSending) stopSending('lab');
        if (currentTab() !== 'send') switchTab('send');
        if (size && size !== frameSize) await setFrameSize(size);
        if (fps) setSpeed(+fps);
        if (text !== undefined) {
            document.getElementById('send-input').value = text;
        } else {
            await loadPreset(preset, +kb);
        }
        await toggleSending();
        return { transferId: encoder.transferId, K: encoder.K, chunk: encoder.chunkSize, size: frameSize, fps: targetFps, ...payloadMeta };
    },

    stop: async () => {
        const was = isSending ? { transferId: encoder.transferId, framesShown: encoder.lastId + 1 } : null;
        if (isSending) stopSending('lab');
        const card = cardRun ? stopCard() : null;
        const rfc = rfcRun ? stopRfc() : null;
        return { stopped: was, card, rfc };
    },

    // Sender: show the density test card. { grid: N (≡ 1 mod 4), levels: 2/4/8, fps, seed, greys: [..] }
    // blank: seconds of data-free frames first, so the receiver can lock on to the corners
    card: async ({ grid = 101, levels = 2, fps = 4, seed = 1, greys, blank = 1.5 } = {}) => {
        if (isSending) stopSending('lab');
        if (cardRun) stopCard();
        if ((grid - 1) % 4) throw new Error('grid must be 1 more than a multiple of 4 (e.g. 101, 149, 201)');
        startCard({ N: grid, L: levels, fps, seed, greys: greys || defaultGreys(levels), blank });
        await waitFor(300);
        return cardStatus();
    },

    'card-status': async () => cardStatus(),

    // Sender: beam a payload with RapidFire code v1. { kb, fps, grid, bands, ecc, blank, blankEvery }
    'rfc-send': async (args = {}) => startRfc(args),

    // Sender: when each frame was drawn [refresh time ms, draw ms, callback delay ms]
    'rfc-timing': async () => (rfcRun ? { timing: rfcRun.timing, buildMs: rfcRun.buildMs, late: rfcRun.late || 0, worker: !!rfcRun.worker, workerError: rfcRun.workerError } : null),

    // Receiver: receive one RapidFire code v1 transfer. { grid, bands, ecc, seconds }
    'rfc-receive': async (args = {}) => receiveRfc(args),

    // Receiver: watch the card for a while and count misread squares.
    // { grid, levels, seed, k0 (sender's frame now), fps (sender's), seconds, rate (pictures/s to analyse) }
    'card-measure': async (args) => measureCard(args),

    // Receiver: clear and start listening (camera on)
    reset: async () => {
        if (currentTab() !== 'recv') switchTab('recv');
        resetReceiver();
        await waitFor(800);
        return { scanning: isScanning, camera: videoTrack() ? videoTrack().getSettings() : null };
    },

    // Camera request: { width, height, frameRate, facing, label }; {} goes back to defaults.
    // label picks a specific camera by name, e.g. "camera 2". Kept across reloads. Restarts the camera.
    camera: async (args = {}) => {
        if (args.label) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const match = devices.find(d => d.kind === 'videoinput' && d.label === args.label)
                || devices.find(d => d.kind === 'videoinput' && d.label.includes(args.label));
            if (!match) throw new Error(`no camera named "${args.label}"`);
            args = { ...args, deviceId: match.deviceId };
        }
        cameraOverrides = Object.keys(args).length ? { ...cameraOverrides, ...args } : {};
        try { localStorage.setItem('rapidfire.labCamera', JSON.stringify(cameraOverrides)); } catch (e) {}
        if (currentTab() === 'recv') {
            await initCamera();
            await waitFor(500);
        }
        return { requested: cameraOverrides, settings: videoTrack() ? videoTrack().getSettings() : null };
    },

    // What the camera can do: capabilities, current settings, photo capabilities
    'camera-info': async () => {
        const track = videoTrack();
        if (!track) return { error: 'camera is off (open the receive tab first)' };
        const info = {
            settings: track.getSettings(),
            capabilities: track.getCapabilities ? track.getCapabilities() : null,
            label: track.label,
        };
        if ('ImageCapture' in window) {
            try {
                const ic = new ImageCapture(track);
                info.photoCapabilities = await ic.getPhotoCapabilities();
                info.photoSettings = await ic.getPhotoSettings();
            } catch (e) {
                info.photoError = String(e);
            }
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        info.cameras = devices.filter(d => d.kind === 'videoinput').map(d => d.label || d.deviceId.slice(0, 8));
        return jsonSafe(info);
    },

    // Apply track constraints, e.g. { "advanced": [{ "focusMode": "manual", "focusDistance": 0.2 }] }
    constraints: async (args) => {
        const track = videoTrack();
        if (!track) return { error: 'camera is off' };
        await track.applyConstraints(args);
        return jsonSafe({ settings: track.getSettings() });
    },

    torch: async ({ on = true } = {}) => {
        const track = videoTrack();
        if (!track) return { error: 'camera is off' };
        await track.applyConstraints({ advanced: [{ torch: !!on }] });
        return { torch: track.getSettings().torch };
    },

    // One picture of what the camera sees right now, saved on the Mac in .lab/snapshots
    snapshot: async ({ quality = 0.85, crop = 'full' } = {}) => {
        const video = document.getElementById('camera-video');
        if (!video || !video.videoWidth) return { error: 'camera is off' };
        let { sx, sy, side } = centreSquare(video);
        let w = side, h = side;
        if (crop === 'full') { sx = 0; sy = 0; w = video.videoWidth; h = video.videoHeight; }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, sx, sy, w, h, 0, 0, w, h);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
        return uploadSnapshot(blob, { width: w, height: h, crop });
    },

    // A full-resolution still photo through ImageCapture (photo-mode test), timed
    photo: async ({ upload = true } = {}) => {
        const track = videoTrack();
        if (!track || !('ImageCapture' in window)) return { error: 'no camera or no ImageCapture' };
        const ic = new ImageCapture(track);
        const t0 = performance.now();
        const blob = await ic.takePhoto();
        const ms = Math.round(performance.now() - t0);
        const bitmap = await createImageBitmap(blob);
        const dims = { width: bitmap.width, height: bitmap.height, ms };
        bitmap.close();
        return upload ? uploadSnapshot(blob, dims) : { ...dims, bytes: blob.size };
    },

    // Where and how big the code is drawn while beaming (sender), kept across reloads.
    // { size: px, dx: px, dy: px } moves it within a dark full-window backdrop; {} goes back to normal.
    place: async (args = {}) => {
        try {
            if (Object.keys(args).length) localStorage.setItem('rapidfire.labPlace', JSON.stringify(args));
            else localStorage.removeItem('rapidfire.labPlace');
        } catch (e) {}
        applyPlacement();
        await waitFor(400);
        const c = document.querySelector('#qr-canvas-container canvas');
        const r = c ? c.getBoundingClientRect() : null;
        return { placement: args, canvasPx: c ? c.width : null, onScreen: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width)] : null, viewport: [innerWidth, innerHeight] };
    },

    // Run JavaScript in the page; the value of `return` comes back
    eval: async ({ code }) => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        return jsonSafe(await new AsyncFunction(code)());
    },
};

async function runLabCommand(msg) {
    const t0 = performance.now();
    let reply;
    try {
        const fn = LAB_COMMANDS[msg.cmd];
        if (!fn) throw new Error(`unknown command "${msg.cmd}". Known: ${Object.keys(LAB_COMMANDS).join(', ')}`);
        reply = { id: msg.id, ok: true, result: await fn(msg.args || {}) };
    } catch (e) {
        reply = { id: msg.id, ok: false, error: String(e && e.message || e) };
    }
    reply.ms = Math.round(performance.now() - t0);
    fetch('/api/result', { method: 'POST', body: JSON.stringify(reply), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    labState();
}

function applyPlacement() {
    let place = null;
    try { place = JSON.parse(localStorage.getItem('rapidfire.labPlace')); } catch (e) {}
    let style = document.getElementById('lab-place');
    if (!place) {
        if (style) style.remove();
        return;
    }
    if (!style) {
        style = document.createElement('style');
        style.id = 'lab-place';
        document.head.appendChild(style);
    }
    const size = place.size ? `${place.size}px` : 'calc(min(100vw, 100vh) - 60px)';
    style.textContent = `
        #screen-send.is-beaming .send-preview-col { position: fixed !important; inset: 0 !important; z-index: 9000; background: #222;
            display: flex !important; align-items: center; justify-content: center; max-height: none !important; opacity: 1 !important; transform: none !important; }
        #screen-send.is-beaming .send-preview-col .qr-wrapper { background: none; border: none; min-height: 0 !important; height: auto !important; padding: 0; }
        #screen-send.is-beaming .send-preview-col .qr-inner { width: ${size} !important; height: ${size} !important; aspect-ratio: auto !important;
            transform: translate(${place.dx || 0}px, ${place.dy || 0}px); }`;
}

async function startLabRemote() {
    applyPlacement();
    try { cameraOverrides = JSON.parse(localStorage.getItem('rapidfire.labCamera')) || {}; } catch (e) {}
    // No offline cache under the lab remote: drop any installed service worker and its files
    if ('serviceWorker' in navigator) {
        try {
            for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
            for (const k of await caches.keys()) await caches.delete(k);
        } catch (e) {}
    }

    const params = new URLSearchParams(location.search);
    if (params.get('tab') === 'recv') switchTab('recv');

    holdWakeLock();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !wakeLock) holdWakeLock();
        labState();
    });

    // Keep the command line open: the server sends a heartbeat every 15 s; if the browser gives
    // up on the connection (Firefox does after some errors) or the heartbeat stops, reconnect.
    let source = null;
    let lastBeat = Date.now();
    const connect = () => {
        if (source) source.close();
        const role = currentTab() === 'recv' ? 'receiver' : 'sender';
        source = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}&device=${DEVICE_ID}&role=${role}&v=${APP_VERSION}`);
        lastBeat = Date.now();
        source.onopen = () => { lastBeat = Date.now(); labState(); };
        source.addEventListener('ping', () => { lastBeat = Date.now(); });
        source.onmessage = (e) => {
            lastBeat = Date.now();
            try { runLabCommand(JSON.parse(e.data)); } catch (err) { console.warn('Bad lab command', err); }
        };
        source.onerror = () => {
            if (source.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
        };
    };
    connect();
    setInterval(() => {
        if (Date.now() - lastBeat > 40000) {
            report('lab-reconnect', { client: CLIENT_ID, silentFor: Math.round((Date.now() - lastBeat) / 1000) });
            connect();
        }
    }, 5000);

    // A small badge so it's obvious the page is remote-controlled
    const badge = document.createElement('div');
    badge.textContent = `LAB ${CLIENT_ID}`;
    badge.style.cssText = 'position:fixed;top:6px;right:8px;z-index:9999;font:600 11px system-ui;background:#FBAB57;color:#222;padding:2px 8px;border-radius:999px;opacity:.85;pointer-events:none';
    document.body.appendChild(badge);
}
