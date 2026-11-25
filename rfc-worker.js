// rfc-worker.js - decodes RapidFire pictures off the main thread. The receiver keeps grabbing
// camera frames while one or more of these workers turn each picture's square brightnesses into
// packets (thresholds, unpacking, Reed-Solomon).
//
//   {type: 'init', grid, bands, ecc, levels, erasures}
//   {type: 'picture', id, lum (Float32Array, transferred)}  ->  {id, packets, thresholdMs, readMs, rescued}
import { rfcPlan, readFrame, threshold } from './rfc.js';
import { rsDecode } from './rs.js';

let rfc = null, opts = null;

self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
        rfc = rfcPlan(m.grid, m.bands, m.ecc, m.levels);
        opts = { erasures: m.erasures || [] };
        return;
    }
    if (m.type === 'picture') {
        const t0 = performance.now();
        const before = rfc.rescued || 0;
        const bits = threshold(rfc, m.lum);
        const t1 = performance.now();
        const packets = readFrame(rfc, bits, rsDecode, opts);
        const t2 = performance.now();
        const transfer = packets.filter(Boolean).map(p => p.buffer);
        self.postMessage({ id: m.id, packets, thresholdMs: t1 - t0, readMs: t2 - t1, rescued: (rfc.rescued || 0) - before }, transfer);
    }
};
