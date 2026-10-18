#!/usr/bin/env node
// Effects in SERIES: each layer processes the result of the layers beneath it,
// like three chained passes — but in one render. Layer `input: "below"` is what
// makes that so; `activity` makes each one enter at its own time.
//   node examples/serial-decay/build.mjs
//   <MATERIAL binary> render examples/serial-decay/serial-decay.material --out out.mp4 --codec h264
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const clip = join(dir, 'clip.mp4');
const DURATION = 12;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', clip]);

const material = { materialId: 'square', colorMode: 'source', params: {}, assetPath: null };
const layer = (id, name, techniqueId, extra = {}) => ({
  id, name, enabled: true, solo: false, opacity: 1, blendMode: 'normal', sourceId: 'clip',
  technique: { id: `tech_${id}`, techniqueId, enabled: true, params: {} },
  activity: null, input: 'source', material, ...extra,
});
const enters = (start) => ({ start, end: null, fadeIn: 2, fadeOut: 0 });

const project = {
  version: 5, name: 'Serial decay', selectedLayerId: 'base',
  layers: [
    layer('base', 'Base', 'echo'), // the picture, untouched (echo with defaults is a clean pass)
    layer('smear', 'Smear', 'motion-rgb', { input: 'below', activity: enters(3) }),
    layer('grid', 'Grid', 'mosaic', { input: 'below', activity: enters(6) }),
    layer('ghost', 'Ghost', 'step-print', { input: 'below', activity: enters(9) }),
  ],
  sources: [{ id: 'clip', kind: 'video', path: clip, metadata: null }],
  composition: { sourceId: 'clip', audioSourceId: null, width: 640, height: 360, background: '#000000' },
  techniques: [], material, modulations: [], triggers: [],
  timeline: { inSec: null, outSec: null, loop: true, bpm: null, beatOffsetSec: 0, beatsPerBar: 4, markers: [] },
  pinnedLooks: [], activeLookId: null, morphEvents: [], midiMappings: [], patternSources: [], macros: [],
  performancePads: [], takes: [], activeTakeId: null, performanceQuantize: 'bar',
  explore: { lockedParams: [], lastSeed: null },
};
writeFileSync(join(dir, 'serial-decay.material'), JSON.stringify(project, null, 2));
console.log('wrote', join(dir, 'serial-decay.material'));
