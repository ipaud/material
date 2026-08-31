import { writeFileSync } from 'node:fs';

const material = { materialId: 'square', colorMode: 'source', params: {}, assetPath: null };
const layer = (id, name, techniqueId, params, opacity = 1) => ({
  id, name, enabled: true, solo: false, opacity, blendMode: 'normal',
  sourceId: null,
  technique: { id: `tech_${id}`, techniqueId, enabled: true, params },
  material,
});
// A Look carries the modulation set it was pinned with, so recalling one
// REPLACES the project's mappings. Both Looks here keep `sig_mod`, which is
// what makes the Freeze events in this Take have something to freeze — a Look
// with an empty mapping list would wipe it, correctly and invisibly.
const modulation = () => ({
  id: 'sig_mod', enabled: true, source: 'beat', target: 'depth', amount: 0.6,
  min: 0, max: 1, invert: false, smoothing: 0.2, curve: 'linear', frozenValue: null,
});
const look = (id, label, slot, scale, depth) => ({
  id, createdAt: '2026-08-31T00:00:00.000Z', label, note: '', slot, seed: 7, thumbnail: null,
  techniques: [{ id: `lt_${id}`, techniqueId: 'mosaic', enabled: true, params: { scale, depth } }],
  layers: [], selectedLayerId: 'sig_l1', material,
  modulations: [modulation()], triggers: [],
});

// A hand's worth of samples: 60 Hz, then the simplifier's output shape.
const ramp = (t0, t1, v0, v1, step = 0.25) => {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    out.push({ t: Number(t.toFixed(4)), v: Number((v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)).toFixed(5)) });
  }
  return out;
};

const take = {
  id: 'sig_take',
  name: 'SIGNATURE',
  createdAt: '2026-08-31T00:00:00.000Z',
  startSec: 0,
  durationSec: 12,
  lanes: [
    { target: 'layer:sig_l2:opacity', samples: [{ t: 0, v: 1 }, ...ramp(2, 4, 1, 0.15)] },
    { target: 'macro:sig_macro', samples: [{ t: 0, v: 0 }, ...ramp(4, 6, 0, 1), ...ramp(6.25, 7, 0.9, 0.2)] },
    { target: 'layer:sig_l3:opacity', samples: [{ t: 0, v: 1 }, ...ramp(10, 12, 1, 0)] },
    { target: 'param:sig_l1:scale', samples: [{ t: 0, v: 1 }, ...ramp(1, 3, 1, 3.5)] },
  ],
  events: [
    { id: 'sig_e0', t: 0, order: 0, kind: 'look.recall', lookId: 'sig_look_a', morph: null, on: null, layerId: null, origin: 'user' },
    { id: 'sig_e1', t: 6, order: 1, kind: 'morph.start', lookId: 'sig_look_b',
      morph: { durationMode: 'seconds', durationValue: 2, curve: 'easeInOut' }, on: null, layerId: null, origin: 'user' },
    { id: 'sig_e2', t: 8, order: 2, kind: 'freeze.set', on: true, lookId: null, morph: null, layerId: null, origin: 'user' },
    { id: 'sig_e3', t: 8.5, order: 3, kind: 'freeze.set', on: false, lookId: null, morph: null, layerId: null, origin: 'midi' },
    { id: 'sig_e4', t: 11, order: 4, kind: 'layer.enable', layerId: 'sig_l3', on: false, lookId: null, morph: null, origin: 'user' },
  ],
  baseline: {
    lanes: { 'layer:sig_l2:opacity': 1, 'macro:sig_macro': 0, 'layer:sig_l3:opacity': 1, 'param:sig_l1:scale': 1 },
    layerEnabled: { sig_l1: true, sig_l2: true, sig_l3: true },
    frozen: { sig_mod: null },
  },
};

const project = {
  version: 5,
  name: 'v0.7 SIGNATURE',
  sources: [],
  composition: { sourceId: null, audioSourceId: null, width: 1920, height: 1080, background: '#000000' },
  layers: [
    layer('sig_l1', 'BASE', 'mosaic', { scale: 1, depth: 0.5 }),
    layer('sig_l2', 'MID', 'mosaic', { scale: 2 }),
    layer('sig_l3', 'TOP', 'mosaic', { scale: 3 }),
  ],
  selectedLayerId: 'sig_l1',
  techniques: [],
  material,
  modulations: [modulation()],
  triggers: [],
  timeline: { inSec: null, outSec: null, loop: true, bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, markers: [] },
  pinnedLooks: [look('sig_look_a', 'LOOK A', 1, 6, 0.2), look('sig_look_b', 'LOOK B', 2, 12, 0.9)],
  activeLookId: null,
  morphEvents: [],
  midiMappings: [],
  patternSources: [],
  macros: [{ id: 'sig_macro', name: 'SWEEP', value: 0, mappings: [
    { targetParam: 'scale', amount: 0.5, min: 0, max: 1, invert: false, curve: 'linear', enabled: true },
  ] }],
  performancePads: [],
  takes: [take],
  activeTakeId: 'sig_take',
  performanceQuantize: 'bar',
  explore: { lockedParams: [], lastSeed: 7 },
};

writeFileSync('tests/fixtures/v07-signature.material', JSON.stringify(project, null, 2) + '\n');
const samples = take.lanes.reduce((n, l) => n + l.samples.length, 0);
console.log('lanes', take.lanes.length, 'samples', samples, 'events', take.events.length);
