#!/usr/bin/env node
// Serial-layer gate, through the headless CLI (needs a GPU and `npm run build`).
//  1. serial != parallel       the same three layers differ once chained
//  2. identity                 inactive serial layers leave a flat grey at its level
//  3. subrange == full export  for stateful serial layers (feedback, frame history, optical flow)
// Usage: node scripts/serial-gate.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'material-serial-'));
const FPS = 25;
const electron = join(process.cwd(), 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const material = { materialId: 'square', colorMode: 'source', params: {}, assetPath: null };
const layer = (id, technique, extra = {}) => ({
  id, name: '', enabled: true, solo: false, opacity: 1, blendMode: 'normal', sourceId: 'g1',
  technique: { id: `t_${id}`, techniqueId: technique, enabled: true, params: {} },
  activity: null, input: 'source', material, ...extra,
});
const project = (layers, sources) => ({
  version: 5, name: 'serial-gate', selectedLayerId: layers[0].id, layers, sources,
  composition: { sourceId: sources[0].id, audioSourceId: null, width: 320, height: 180, background: '#000000' },
  techniques: [], material, modulations: [], triggers: [],
  timeline: { inSec: null, outSec: null, loop: true, bpm: null, beatOffsetSec: 0, beatsPerBar: 4, markers: [] },
  pinnedLooks: [], activeLookId: null, morphEvents: [], midiMappings: [], patternSources: [], macros: [],
  performancePads: [], takes: [], activeTakeId: null, performanceQuantize: 'bar',
  explore: { lockedParams: [], lastSeed: null },
});
const generator = [{ id: 'g1', kind: 'generator', generator: 'waves', params: {}, seed: 1 }];

let n = 0;
function render(proj, range) {
  const file = join(dir, `p${n}.material`);
  const out = join(dir, `o${n}.mov`);
  n++;
  writeFileSync(file, JSON.stringify(proj));
  spawnSync('sleep', ['3']); // back-to-back Electron launches can collide on macOS
  const r = spawnSync(electron, ['out/main/index.js', 'render', file, '--out', out, '--codec', 'prores422hq', '--fps', String(FPS), '--range', range], { env, encoding: 'utf8' });
  if (!r.stdout?.includes('"event":"done"')) throw new Error(`render failed: ${(r.stderr ?? '').slice(-300)}`);
  return out;
}
const frameHashes = (file) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-']).toString()
    .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')[5].trim());
const meanLuma = (file) => {
  const o = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24,signalstats,metadata=print:file=-', '-f', 'null', '-']).toString();
  const v = [...o.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return v.reduce((a, b) => a + b, 0) / v.length;
};

let failed = 0;
const report = (ok, name, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

// 1. serial != parallel (stateless layers)
{
  const mk = (input) => project([
    layer('a', 'mosaic'),
    layer('b', 'flow-displace', { input, activity: { start: 0.5, end: null, fadeIn: 0.2, fadeOut: 0 } }),
    layer('c', 'mosaic', { input, activity: { start: 1, end: null, fadeIn: 0.2, fadeOut: 0 } }),
  ], generator);
  const par = frameHashes(render(mk('source'), '0:2'));
  const ser = frameHashes(render(mk('below'), '0:2'));
  const same = par.filter((h, i) => h === ser[i]).length;
  report(par.length === ser.length && same < par.length && par[0] === ser[0], 'serial differs from parallel, identical before the layers open', `${par.length - same} of ${par.length} frames differ`);
}

// 2. identity: seven inactive serial layers over a flat grey
{
  const grey = join(dir, 'grey.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x180:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', grey]);
  const techs = ['mosaic', 'flow-displace', 'motion-rgb', 'echo', 'step-print', 'slit-scan', 'time-field'];
  const layers = [layer('base', 'echo', { sourceId: 'v1' }), ...techs.map((t, i) =>
    layer(`s${i}`, t, { sourceId: 'v1', input: 'below', blendMode: i % 2 ? 'add' : 'normal', activity: { start: 100, end: null, fadeIn: 0, fadeOut: 0 } }))];
  const out = render(project(layers, [{ id: 'v1', kind: 'video', path: grey, metadata: null }]), '0:1');
  const ref = meanLuma(grey);
  const got = meanLuma(out);
  report(Math.abs(got - ref) <= 1, 'seven inactive serial layers keep the grey', `mean ${got.toFixed(1)} vs source ${ref.toFixed(1)}`);
}

// 3. subrange == full export, for each kind of state a serial layer can carry
for (const technique of ['feedback-zoom', 'echo', 'motion-rgb']) {
  const proj = project([
    layer('a', 'mosaic'),
    layer('b', technique, { input: 'below' }),
  ], generator);
  const full = frameHashes(render(proj, '0:4'));
  const sub = frameHashes(render(proj, '2:3'));
  const from = 2 * FPS;
  const bad = sub.map((h, i) => (h === full[from + i] ? -1 : i)).filter((i) => i >= 0);
  report(bad.length === 0 && sub.length > 0, `subrange == full export: serial ${technique}`, bad.length ? `${bad.length}/${sub.length} frames differ (first: ${bad[0]})` : `${sub.length} frames`);
}
process.exit(failed ? 1 : 0);
