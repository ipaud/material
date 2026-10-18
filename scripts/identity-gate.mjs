#!/usr/bin/env node
// Colour-consistency gate. A flat grey is rendered through each technique twice:
// as a VIDEO and as a PNG. The two must agree (±TOL of 255) — a video that
// renders differently from the identical still means the source is not being
// decoded like an image (the bug this gate was written for: video 124 -> 184).
// Techniques whose defaults are not neutral (mosaic, trails, mosh) legitimately
// move the grey; that shows as `drift`, not as a failure. Drives the real app
// through the CLI, so it needs a GPU and `npm run build` first. Usage:
//   node scripts/identity-gate.mjs [technique-id ...]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOL = 2;
const GREY = 128;
const DEFAULT_TECHNIQUES = [
  'mosaic', 'echo', 'step-print', 'slit-scan', 'time-field', 'flow-displace', 'motion-rgb',
  'directional-smear', 'flow-feedback', 'motion-mosh', 'motion-trails',
];
const techniques = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TECHNIQUES;

const dir = mkdtempSync(join(tmpdir(), 'material-gate-'));
const clip = join(dir, 'grey.mp4');
const lavfi = `color=c=0x${GREY.toString(16).repeat(3)}:s=320x180:r=25:d=1`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', clip]);
const still = join(dir, 'grey.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', still]);

const base = {
  version: 5, name: 'gate', selectedLayerId: 'layer_1',
  layers: [{ id: 'layer_1', name: '', enabled: true, solo: false, opacity: 1, blendMode: 'normal', sourceId: 'v1', technique: null, material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null } }],
  sources: [{ id: 'v1', kind: 'video', path: clip, metadata: null }],
  composition: { sourceId: 'v1', audioSourceId: null, width: 320, height: 180, background: '#000000' },
  techniques: [], material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
  modulations: [], triggers: [],
  timeline: { inSec: null, outSec: null, loop: true, bpm: null, beatOffsetSec: 0, beatsPerBar: 4, markers: [] },
  pinnedLooks: [], activeLookId: null, morphEvents: [], midiMappings: [], patternSources: [], macros: [],
  performancePads: [], takes: [], activeTakeId: null, performanceQuantize: 'bar',
  explore: { lockedParams: [], lastSeed: null },
};

const meanLuma = (file) => {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24,signalstats,metadata=print:file=-', '-f', 'null', '-']).toString();
  const v = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return v.reduce((a, b) => a + b, 0) / v.length;
};

const electron = join(process.cwd(), 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const reference = meanLuma(clip);
console.log(`source mean ${reference.toFixed(1)}  tolerance ±${TOL}`);
let failed = 0;
const render = (id, source, tag) => {
  const sources = [source];
  const project = { ...base, sources, composition: { ...base.composition, sourceId: source.id }, layers: [{ ...base.layers[0], sourceId: source.id, technique: { id: 't1', techniqueId: id, enabled: true, params: {} } }] };
  const file = join(dir, `${id}-${tag}.material`);
  const out = join(dir, `${id}-${tag}.mp4`);
  writeFileSync(file, JSON.stringify(project));
  const r = spawnSync(electron, ['out/main/index.js', 'render', file, '--out', out, '--codec', 'h264', '--range', '0:1'], { env, encoding: 'utf8' });
  return r.status === 0 ? meanLuma(out) : null;
};
for (const id of techniques) {
  const v = render(id, { id: 'v1', kind: 'video', path: clip, metadata: null }, 'video');
  const i = render(id, { id: 'i1', kind: 'image', path: still, metadata: null }, 'image');
  if (v === null || i === null) { console.log(`FAIL ${id.padEnd(18)} render failed`); failed++; continue; }
  const ok = Math.abs(v - i) <= TOL;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(18)} video ${v.toFixed(1)}  image ${i.toFixed(1)}  drift ${(i - reference >= 0 ? '+' : '') + (i - reference).toFixed(1)}`);
}
process.exit(failed ? 1 : 0);
