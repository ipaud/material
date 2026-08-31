import { describe, expect, test } from 'vitest';
import { createEmptyProject, parseProject } from '@shared/schemas/project';
import type { Macro, Project } from '@shared/schemas/project';
import { applyMacros, shapeMacroValue } from '@/performance/macros';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import { getTechnique } from '@/techniques/registry';
import { useProjectStore } from '@/state/projectStore';
import { liveScheduler } from '@/signals/triggerRuntime';
import {
  applyLookQuantized,
  cancelPendingActions,
  cycleQuantize,
  setMacroValue,
} from '@/performance/performanceActions';
import { midiEngine, useMidiStore } from '@/midi/midiEngine';
import { FakeMidiTransport } from '@/midi/transport';

const mosaic = getTechnique('mosaic')!;

function macro(patch: Partial<Macro>): Macro {
  return {
    id: 'mac-1',
    name: 'TEST',
    value: 1,
    mappings: [
      { targetParam: 'scale', amount: 0.5, min: 0, max: 1, invert: false, curve: 'linear', enabled: true },
    ],
    ...patch,
  };
}

function perfProject(patch: Partial<Project> = {}): Project {
  const p = createEmptyProject('PerfTest');
  return {
    ...p,
    layers: [
      {
        ...p.layers[0]!,
        technique: { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } },
      },
    ],
    timeline: { ...p.timeline, bpm: 120 },
    ...patch,
  };
}

describe('macro evaluation', () => {
  test('adds amount × shaped × span onto the base (scale span = 3)', () => {
    const out = applyMacros({ scale: 1 }, [macro({ value: 1 })], mosaic);
    expect(out.scale).toBeCloseTo(1 + 0.5 * 1 * 3); // 2.5
  });

  test('value 0 leaves params untouched (same reference fast-path)', () => {
    const base = { scale: 1 };
    expect(applyMacros(base, [macro({ value: 0 })], mosaic)).toBe(base);
  });

  test('shaping: invert, curve, min/max window', () => {
    expect(shapeMacroValue({ targetParam: 'x', amount: 1, min: 0, max: 1, invert: true, curve: 'linear', enabled: true }, 0.25)).toBeCloseTo(0.75);
    expect(shapeMacroValue({ targetParam: 'x', amount: 1, min: 0, max: 1, invert: false, curve: 'exponential', enabled: true }, 0.5)).toBeCloseTo(0.25);
    expect(shapeMacroValue({ targetParam: 'x', amount: 1, min: 0.2, max: 0.6, invert: false, curve: 'linear', enabled: true }, 1)).toBeCloseTo(0.6);
  });

  test('clamps to the parameter definition range', () => {
    const up = applyMacros({ scale: 2.9 }, [macro({ value: 1 })], mosaic);
    expect(up.scale).toBe(3); // mosaic scale max
    const down = applyMacros(
      { scale: 0.1 },
      [macro({ value: 1, mappings: [{ targetParam: 'scale', amount: -1, min: 0, max: 1, invert: false, curve: 'linear', enabled: true }] })],
      mosaic,
    );
    expect(down.scale).toBe(0); // mosaic scale min
  });

  test('disabled mappings and unknown params are skipped', () => {
    const out = applyMacros(
      { scale: 1 },
      [
        macro({
          mappings: [
            { targetParam: 'scale', amount: 0.5, min: 0, max: 1, invert: false, curve: 'linear', enabled: false },
            { targetParam: 'nope', amount: 1, min: 0, max: 1, invert: false, curve: 'linear', enabled: true },
          ],
        }),
      ],
      mosaic,
    );
    expect(out.scale).toBe(1);
  });

  test('multiple macros stack additively on one parameter', () => {
    const a = macro({ id: 'a', value: 0.5 }); // +0.5×0.5×3 = 0.75
    const b = macro({ id: 'b', value: 0.5 }); // +0.75
    const out = applyMacros({ scale: 1 }, [a, b], mosaic);
    expect(out.scale).toBeCloseTo(2.5);
  });

  test('macro base feeds modulation; a FROZEN mapping rides on the macroed base', () => {
    const macroed = applyMacros({ scale: 1 }, [macro({ value: 1 })], mosaic); // 2.5
    const frozenMod = {
      id: 'mod-1', enabled: true, source: 'bass', target: 'scale', amount: 0.1,
      min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear' as const, frozenValue: 0.5,
    };
    const out = applyModulations(macroed, [frozenMod], {}, mosaic, new SmoothingState(), 1 / 60);
    // frozen delta = 0.1 × 0.5 × 3 = 0.15 on top of the macroed 2.5.
    expect(out.scale).toBeCloseTo(2.65);
  });
});

describe('performance schema persistence', () => {
  test('macros / pads / quantize round-trip', () => {
    const p = perfProject({
      macros: [macro({})],
      performancePads: [{
        id: 'pad-1', label: 'HIT', velocityScale: false,
        trigger: {
          id: 'pt-1', enabled: true, source: 'manual', action: 'pulse', targetParam: 'depth',
          targetMappingId: null, lookSlot: null, quantize: 'off', cooldownSec: 0,
          attackSec: 0.01, holdSec: 0, decaySec: 0.2, amount: 0.6, curve: 'easeOut',
        },
      }],
      performanceQuantize: '2bars',
    });
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    expect(back.macros).toEqual([macro({})]);
    expect(back.performancePads[0]!.label).toBe('HIT');
    expect(back.performanceQuantize).toBe('2bars');
  });

  test('older projects default: no macros, no pads, quantize bar', () => {
    const raw = JSON.parse(JSON.stringify(perfProject()));
    delete raw.macros;
    delete raw.performancePads;
    delete raw.performanceQuantize;
    const back = parseProject(raw);
    expect(back.macros).toEqual([]);
    expect(back.performancePads).toEqual([]);
    expect(back.performanceQuantize).toBe('bar');
  });
});

describe('quantized performance actions', () => {
  const look = {
    id: 'look-1',
    createdAt: new Date(0).toISOString(),
    label: 'L1',
    note: '',
    slot: 1,
    seed: 1,
    thumbnail: null,
    techniques: [{ id: 't2', techniqueId: 'mosaic', enabled: true, params: { scale: 0.5 } }],
    material: createEmptyProject().material,
    modulations: [],
    triggers: [],
  };

  test('quantize OFF applies immediately', () => {
    useProjectStore.getState().loadProject('', perfProject({ pinnedLooks: [look], performanceQuantize: 'off' }));
    liveScheduler.reset(0.3);
    expect(applyLookQuantized(1)).toBe(true);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(0.5);
  });

  test('quantize BAR queues on the ONE scheduler; visible; executes at boundary', () => {
    useProjectStore.getState().loadProject('', perfProject({ pinnedLooks: [look], performanceQuantize: 'bar' }));
    liveScheduler.reset(0.3);
    // playhead is 0 in jsdom, but fireLive uses playback.getTime() = 0 which
    // IS a boundary — drive the scheduler path directly like the engine does.
    expect(applyLookQuantized(1)).toBe(true);
    // At t=0 (a bar boundary) the action executes immediately — accept both
    // paths; the pending path is exercised below with an off-boundary fire.
    liveScheduler.reset(0.3);
    const ctx = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };
    liveScheduler.fireLive(
      {
        id: 'perf-applyLook-1', enabled: true, source: 'manual', action: 'applyLook',
        targetParam: null, targetMappingId: null, lookSlot: 1, quantize: 'bar',
        cooldownSec: 0, attackSec: 0.01, holdSec: 0, decaySec: 0.18, amount: 0.35, curve: 'easeOut',
      },
      0.3,
      ctx,
    );
    const pending = liveScheduler.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.executeAt).toBeCloseTo(2); // next bar @120 BPM 4/4
    expect(pending[0]!.mapping.lookSlot).toBe(1);
    liveScheduler.advanceTo(2.01, [], ctx);
    expect(useProjectStore.getState().project.activeLookId).toBe('look-1');
  });

  test('cancelPendingActions drops the queue without firing', () => {
    useProjectStore.getState().loadProject('', perfProject({ pinnedLooks: [look] }));
    liveScheduler.reset(0.3);
    const ctx = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };
    liveScheduler.fireLive(
      {
        id: 'perf-applyLook-1', enabled: true, source: 'manual', action: 'applyLook',
        targetParam: null, targetMappingId: null, lookSlot: 1, quantize: 'bar',
        cooldownSec: 0, attackSec: 0.01, holdSec: 0, decaySec: 0.18, amount: 0.35, curve: 'easeOut',
      },
      0.3,
      ctx,
    );
    expect(liveScheduler.getPending()).toHaveLength(1);
    expect(cancelPendingActions()).toBe(1);
    expect(liveScheduler.getPending()).toHaveLength(0);
    liveScheduler.advanceTo(5, [], ctx);
    expect(useProjectStore.getState().project.activeLookId).toBeNull();
  });

  test('cycleQuantize walks off→beat→bar→2bars→4bars→off', () => {
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'off' }));
    const seen: string[] = ['off'];
    for (let i = 0; i < 5; i++) {
      cycleQuantize();
      seen.push(useProjectStore.getState().project.performanceQuantize);
    }
    expect(seen).toEqual(['off', 'beat', 'bar', '2bars', '4bars', 'off']);
  });
});

describe('macro gesture undo coalescing', () => {
  test('one transient gesture = one undo entry', () => {
    useProjectStore.getState().loadProject('', perfProject({ macros: [macro({ value: 0 })] }));
    const store = useProjectStore.getState();
    const depth0 = useProjectStore.getState().past.length;
    store.beginTransient();
    for (let v = 0; v <= 10; v++) setMacroValue('mac-1', v / 10);
    useProjectStore.getState().commitTransient();
    expect(useProjectStore.getState().project.macros[0]!.value).toBe(1);
    expect(useProjectStore.getState().past.length).toBe(depth0 + 1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.macros[0]!.value).toBe(0);
  });
});

describe('MIDI → macro', () => {
  test('CC drives macro value with pickup; external change re-arms pickup', async () => {
    midiEngine.stop();
    useMidiStore.setState({ availability: 'idle', devices: [], bound: {}, status: {} });
    useProjectStore.getState().loadProject(
      '',
      perfProject({
        macros: [macro({ value: 0.5 })],
        midiMappings: [
          {
            id: 'mm-mac', enabled: true, deviceId: 'dev-1', deviceLabel: 'Acme · TestPad',
            channel: null, messageType: 'cc', control: 30, targetType: 'macro',
            targetParam: 'mac-1', action: null, lookSlot: null, targetMappingId: null,
            quantize: 'off', min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear',
            pickupMode: 'pickup', mode: 'absolute',
          },
        ],
      }),
    );
    const fake = new FakeMidiTransport();
    fake.devices = [{ id: 'dev-1', name: 'TestPad', manufacturer: 'Acme' }];
    await midiEngine.start(fake);
    // Knob at 0.1 — far from 0.5 → waiting, value held.
    fake.emitRaw('dev-1', [0xb0, 30, 13]);
    expect(useProjectStore.getState().project.macros[0]!.value).toBe(0.5);
    expect(midiEngine.getPickupState('mm-mac')).toBe('waiting');
    // Sweep across → engaged, macro follows.
    for (let v = 20; v <= 110; v += 10) fake.emitRaw('dev-1', [0xb0, 30, v]);
    expect(midiEngine.getPickupState('mm-mac')).toBe('live');
    expect(useProjectStore.getState().project.macros[0]!.value).toBeCloseTo(110 / 127, 2);
    midiEngine.stop();
  });
});

describe('MIDI macro pickup re-arm', () => {
  test('external macro change drops engaged CC back to waiting', async () => {
    midiEngine.stop();
    useProjectStore.getState().loadProject(
      '',
      perfProject({
        macros: [macro({ value: 0 })],
        midiMappings: [
          {
            id: 'mm-mac2', enabled: true, deviceId: 'dev-1', deviceLabel: 'Acme · TestPad',
            channel: null, messageType: 'cc', control: 31, targetType: 'macro',
            targetParam: 'mac-1', action: null, lookSlot: null, targetMappingId: null,
            quantize: 'off', min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear',
            pickupMode: 'pickup', mode: 'absolute',
          },
        ],
      }),
    );
    const fake = new FakeMidiTransport();
    fake.devices = [{ id: 'dev-1', name: 'TestPad', manufacturer: 'Acme' }];
    await midiEngine.start(fake);
    fake.emitRaw('dev-1', [0xb0, 31, 0]);
    fake.emitRaw('dev-1', [0xb0, 31, 60]);
    expect(midiEngine.getPickupState('mm-mac2')).toBe('live');
    useProjectStore.getState().commitTransient();
    // UI slider (or look logic) moves the macro under the knob.
    setMacroValue('mac-1', 0.05);
    expect(midiEngine.getPickupState('mm-mac2')).toBe('waiting');
    // Knob near old position must not snap the macro.
    fake.emitRaw('dev-1', [0xb0, 31, 62]);
    expect(useProjectStore.getState().project.macros[0]!.value).toBeCloseTo(0.05);
    midiEngine.stop();
  });
});

describe('performance pads', () => {
  test('pad pulse fires through the live scheduler and survives a look apply', async () => {
    const { firePad } = await import('@/performance/performanceActions');
    const look = {
      id: 'look-p', createdAt: new Date(0).toISOString(), label: 'LP', note: '', slot: 1,
      seed: 1, thumbnail: null,
      techniques: [{ id: 'tp', techniqueId: 'mosaic', enabled: true, params: { scale: 0.7 } }],
      material: createEmptyProject().material, modulations: [], triggers: [],
    };
    useProjectStore.getState().loadProject(
      '',
      perfProject({
        pinnedLooks: [look],
        performanceQuantize: 'off',
        performancePads: [{
          id: 'pad-1', label: 'HIT', velocityScale: false,
          trigger: {
            id: 'pt-1', enabled: true, source: 'manual', action: 'pulse', targetParam: 'depth',
            targetMappingId: null, lookSlot: null, quantize: 'off', cooldownSec: 0,
            attackSec: 0.01, holdSec: 0, decaySec: 0.2, amount: 0.6, curve: 'easeOut',
          },
        }],
      }),
    );
    liveScheduler.reset(0);
    // Look apply REPLACES project.triggers — the pad must still fire after.
    applyLookQuantized(1);
    firePad('pad-1');
    const pulses = liveScheduler.livePulseContributions(0.05);
    expect(pulses.get('depth') ?? 0).toBeGreaterThan(0.1);
  });
});
