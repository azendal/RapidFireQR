// rfc-send-worker.js - builds RapidFire frames off the main thread, ahead of time, so the sender's
// page only has to copy a finished picture to the screen on the right refresh.
//
//   {type: 'init', grid, bands, ecc, levels, greys, data (packed payload), chunk, transferId}
//   {type: 'build', buffer (optional, reused)}  ->  {buffer, ms}   (grid x grid RGBA)
import { rfcPlan, buildFrame, paintFrame } from './rfc.js';
import { FountainEncoder } from './fountain.js';

let rfc = null, greys = null, enc = null;

self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
        rfc = rfcPlan(m.grid, m.bands, m.ecc, m.levels);
        greys = m.greys || null;
        enc = new FountainEncoder(m.data, m.chunk, m.transferId);
        return;
    }
    if (m.type === 'build') {
        const t0 = performance.now();
        const buffer = m.buffer || new ArrayBuffer(rfc.N * rfc.N * 4);
        const img = { data: new Uint8ClampedArray(buffer), width: rfc.N, height: rfc.N };
        paintFrame(img, rfc, buildFrame(rfc, Array.from({ length: rfc.bands }, () => enc.nextDroplet())), greys);
        self.postMessage({ buffer, ms: performance.now() - t0 }, [buffer]);
    }
};
