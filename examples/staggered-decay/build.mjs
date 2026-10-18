#!/usr/bin/env node
// Builds the assets and the project for the staggered-decay example, then you
// render it headless:
//   node examples/staggered-decay/build.mjs
//   <MATERIAL binary> render examples/staggered-decay/staggered-decay.material --out out.mp4 --codec h264
// Three layers over one clip; each enters at its own time (activity windows);
// the kick (bass) drives ONLY layer 3's mosaic scale — layers 1 and 2 do not react.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const clip = join(dir, 'clip.mp4');
const kick = join(dir, 'kick.wav');
const DURATION = 12;

execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', clip]);
// 2 kicks per second: a 60 Hz sine with a fast decay.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=0.9*sin(2*PI*60*t)*exp(-9*mod(t\\,0.5)):d=${DURATION}:s=44100`, kick]);

const material = { materialId: 'square', colorMode: 'source', params: {}, assetPath: null };
const layer = (id, name, techniqueId, activity, blendMode = 'normal') => ({
  id, name, enabled: true, solo: false, opacity: 1, blendMode, sourceId: 'clip',
  technique: { id: `tech_${id}`, techniqueId, enabled: true, params: {} },
  activity, material,
});

const project = {
  version: 5, name: 'Staggered decay', selectedLayerId: 'l1',
  layers: [
    layer('l1', 'Base', 'echo', { start: 0, end: DURATION, fadeIn: 0, fadeOut: 0 }),
    layer('l2', 'Smear', 'motion-rgb', { start: 4, end: null, fadeIn: 2, fadeOut: 0 }),
    layer('l3', 'Grid (kick)', 'mosaic', { start: 8, end: null, fadeIn: 2, fadeOut: 0 }),
  ],
  sources: [
    { id: 'clip', kind: 'video', path: clip, metadata: null },
    { id: 'kick', kind: 'audio', path: kick, metadata: null },
  ],
  composition: { sourceId: 'clip', audioSourceId: 'kick', width: 640, height: 360, background: '#000000' },
  techniques: [], material,
  // Bass above 0.5 only (inMin) -> layer 3's mosaic scale, and nothing else.
  modulations: [{
    id: 'kick-to-l3', enabled: true, source: 'bass', target: 'scale', amount: 0.8, min: 0, max: 1,
    invert: false, smoothing: 0.1, curve: 'linear', frozenValue: null, mode: 'add',
    inMin: 0.5, inMax: 1, targetLayerId: 'l3',
  }],
  triggers: [],
  timeline: { inSec: null, outSec: null, loop: true, bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, markers: [] },
  pinnedLooks: [], activeLookId: null, morphEvents: [], midiMappings: [], patternSources: [], macros: [],
  performancePads: [], takes: [], activeTakeId: null, performanceQuantize: 'bar',
  explore: { lockedParams: [], lastSeed: null },
};
writeFileSync(join(dir, 'staggered-decay.material'), JSON.stringify(project, null, 2));
console.log('wrote', join(dir, 'staggered-decay.material'));
