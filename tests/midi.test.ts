import { beforeEach, describe, expect, test } from 'vitest';
import { createEmptyProject, parseProject } from '@shared/schemas/project';
import type { MidiMapping, Project } from '@shared/schemas/project';
import { FakeMidiTransport, parseMidiMessage } from '@/midi/transport';
import {
  matchDevice,
  midiEngine,
  pickupCrossed,
  shapeCcValue,
  useMidiStore,
} from '@/midi/midiEngine';
import { isDeterministicSource } from '@/signals/triggerSources';
import { useProjectStore } from '@/state/projectStore';
import { takeRecorder } from '@/performance/take/recorder';
import { captureBaseline } from '@/performance/take/takeActions';
import { stageParamTarget } from '@/performance/take/model';

const DEVICE = { id: 'dev-1', name: 'TestPad', manufacturer: 'Acme' };

function ccMapping(patch: Partial<MidiMapping>): MidiMapping {
  return {
    id: 'mm-1',
    enabled: true,
    deviceId: 'dev-1',
    deviceLabel: 'Acme · TestPad',
    channel: 0,
    messageType: 'cc',
    control: 21,
    targetType: 'param',
    targetParam: 'scale',
    action: null,
    lookSlot: null,
    targetMappingId: null,
    quantize: 'off',
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    pickupMode: 'pickup',
    mode: 'absolute',
    ...patch,
  };
}

function baseProject(patch: Partial<Project> = {}): Project {
  const p = createEmptyProject('MidiTest');
  return {
    ...p,
    // v0.6: the technique lives on a LAYER. `techniques[]` still parses for
    // pre-v0.6 Looks and presets, but nothing reads it to render.
    layers: [
      {
        ...p.layers[0]!,
        // scale param on the mosaic technique: min 0.1 max 2 (real def).
        technique: { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } },
      },
    ],
    ...patch,
  };
}

async function bootEngine(project: Project): Promise<FakeMidiTransport> {
  midiEngine.stop();
  useProjectStore.getState().loadProject('', project);
  const fake = new FakeMidiTransport();
  fake.devices = [DEVICE];
  await midiEngine.start(fake);
  return fake;
}

describe('parseMidiMessage', () => {
  test('CC / NoteOn / NoteOff / velocity-0 convention', () => {
    expect(parseMidiMessage('d', new Uint8Array([0xb0, 21, 100]))).toEqual({
      type: 'cc',
      deviceId: 'd',
      channel: 0,
      control: 21,
      value: 100,
    });
    expect(parseMidiMessage('d', new Uint8Array([0x92, 36, 90]))).toEqual({
      type: 'noteOn',
      deviceId: 'd',
      channel: 2,
      note: 36,
      velocity: 90,
    });
    expect(parseMidiMessage('d', new Uint8Array([0x80, 36, 0]))?.type).toBe('noteOff');
    expect(parseMidiMessage('d', new Uint8Array([0x90, 36, 0]))?.type).toBe('noteOff');
  });

  test('pitch bend normalizes to -1..1', () => {
    const center = parseMidiMessage('d', new Uint8Array([0xe0, 0x00, 0x40]));
    expect(center?.type === 'pitchBend' && Math.abs(center.value) < 1e-6).toBe(true);
    const max = parseMidiMessage('d', new Uint8Array([0xe0, 0x7f, 0x7f]));
    expect(max?.type === 'pitchBend' && max.value > 0.99).toBe(true);
  });

  test('ignores clock, active sensing, aftertouch, program change, sysex', () => {
    for (const bytes of [[0xf8], [0xfe], [0xfa], [0xfc], [0xa0, 36, 10], [0xd0, 10], [0xc0, 5], [0xf0, 1, 2]]) {
      expect(parseMidiMessage('d', new Uint8Array(bytes))).toBeNull();
    }
  });
});

describe('shapeCcValue', () => {
  test('normalizes 0–127, applies invert and min/max window', () => {
    const m = ccMapping({});
    expect(shapeCcValue(m, 0)).toBe(0);
    expect(shapeCcValue(m, 127)).toBe(1);
    expect(shapeCcValue(ccMapping({ invert: true }), 0)).toBe(1);
    const windowed = ccMapping({ min: 0.2, max: 0.8 });
    expect(shapeCcValue(windowed, 0)).toBeCloseTo(0.2);
    expect(shapeCcValue(windowed, 127)).toBeCloseTo(0.8);
  });

  test('curve applies before the window', () => {
    const m = ccMapping({ curve: 'exponential' });
    expect(shapeCcValue(m, 64)).toBeCloseTo((64 / 127) ** 2, 4);
  });
});

describe('pickupCrossed', () => {
  test('within epsilon counts as caught', () => {
    expect(pickupCrossed(null, 0.5, 0.505)).toBe(true);
  });
  test('sign change across target crosses', () => {
    expect(pickupCrossed(0.3, 0.7, 0.5)).toBe(true);
    expect(pickupCrossed(0.7, 0.3, 0.5)).toBe(true);
  });
  test('same side never crosses; first event far away never crosses', () => {
    expect(pickupCrossed(0.1, 0.3, 0.5)).toBe(false);
    expect(pickupCrossed(null, 0.9, 0.5)).toBe(false);
  });
});

describe('matchDevice (§12)', () => {
  const devices = [
    DEVICE,
    { id: 'dev-2', name: 'OtherKnob', manufacturer: 'Zed' },
  ];
  test('exact id wins', () => {
    expect(matchDevice({ deviceId: 'dev-1', deviceLabel: 'x' }, devices)?.id).toBe('dev-1');
  });
  test('unique label match binds after id change', () => {
    expect(
      matchDevice({ deviceId: 'stale', deviceLabel: 'Acme · TestPad' }, devices)?.id,
    ).toBe('dev-1');
  });
  test('ambiguous label stays unbound', () => {
    const twins = [DEVICE, { ...DEVICE, id: 'dev-1b' }];
    expect(matchDevice({ deviceId: 'stale', deviceLabel: 'Acme · TestPad' }, twins)).toBeNull();
  });
  test('no candidates → null (mapping persists offline)', () => {
    expect(matchDevice({ deviceId: 'stale', deviceLabel: 'Gone · Device' }, [])).toBeNull();
  });
});

describe('serialization', () => {
  test('midiMappings round-trip through parseProject', () => {
    const p = baseProject({ midiMappings: [ccMapping({})] });
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    expect(back.midiMappings).toEqual([ccMapping({})]);
  });
  test('projects without the field parse with []', () => {
    const p = JSON.parse(JSON.stringify(baseProject()));
    delete p.midiMappings;
    expect(parseProject(p).midiMappings).toEqual([]);
  });

  test('stage-target MIDI mappings preserve stable layer and stage IDs', () => {
    const mapping = ccMapping({ targetLayerId: 'layer-a', targetStageId: 'stage-b' } as Partial<MidiMapping>);
    const back = parseProject(JSON.parse(JSON.stringify(baseProject({ midiMappings: [mapping] }))));
    expect(back.midiMappings[0]).toMatchObject({ targetLayerId: 'layer-a', targetStageId: 'stage-b' });
  });
});

describe('engine: CC → ABSOLUTE parameter (pickup)', () => {
  beforeEach(() => {
    useMidiStore.setState({ availability: 'idle', devices: [], bound: {}, status: {} });
  });

  test('waiting until the knob crosses the current value, then live', async () => {
    const fake = await bootEngine(baseProject({ midiMappings: [ccMapping({})] }));
    // scale=1 in def range [min,max] — knob far below → no jump.
    fake.emitRaw('dev-1', [0xb0, 21, 10]);
    const p1 = useProjectStore.getState().project;
    expect(p1.layers[0]!.technique!.params.scale).toBe(1);
    expect(midiEngine.getPickupState('mm-1')).toBe('waiting');
    // Sweep upward across the current normalized value → engages.
    for (let v = 20; v <= 127; v += 10) fake.emitRaw('dev-1', [0xb0, 21, v]);
    expect(midiEngine.getPickupState('mm-1')).toBe('live');
    const p2 = useProjectStore.getState().project;
    expect(p2.layers[0]!.technique!.params.scale).not.toBe(1);
    midiEngine.stop();
  });

  test('jump mode takes control immediately', async () => {
    const fake = await bootEngine(
      baseProject({ midiMappings: [ccMapping({ pickupMode: 'jump' })] }),
    );
    fake.emitRaw('dev-1', [0xb0, 21, 0]);
    expect(midiEngine.getPickupState('mm-1')).toBe('live');
    midiEngine.stop();
  });

  test('stage-target CC writes the stable stage ID and records that Take lane', async () => {
    const project = baseProject();
    const layer = project.layers[0]!;
    project.midiMappings = [ccMapping({
      targetLayerId: layer.id, targetStageId: 'stage-b', targetParam: 'columns', pickupMode: 'jump',
    } as Partial<MidiMapping>)];
    const chain = [
      { id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { columns: 12 } },
      { id: 'stage-b', techniqueId: 'mosaic', enabled: true, params: { columns: 24 } },
    ];
    const fake = await bootEngine({ ...project, layers: [{ ...layer, techniqueChain: chain }] });
    takeRecorder.abort();
    takeRecorder.begin(0, captureBaseline(useProjectStore.getState().project));
    fake.emitRaw('dev-1', [0xb0, 21, 127]);
    const updated = useProjectStore.getState().project.layers[0]!;
    expect(updated.techniqueChain.find((stage) => stage.id === 'stage-a')?.params.columns).toBe(12);
    expect(updated.techniqueChain.find((stage) => stage.id === 'stage-b')?.params.columns).toBeGreaterThan(24);
    expect(takeRecorder.stop(1, 'MIDI stage control')?.lanes.map((lane) => lane.target))
      .toContain(stageParamTarget(layer.id, 'stage-b', 'columns'));
    midiEngine.stop();
  });

  test('stage-target CC stays blocked by matching frozen stage modulation', async () => {
    const project = baseProject();
    const layer = project.layers[0]!;
    project.midiMappings = [ccMapping({
      targetLayerId: layer.id, targetStageId: 'stage-b', targetParam: 'columns', pickupMode: 'jump',
    } as Partial<MidiMapping>)];
    const chain = [
      { id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { columns: 12 } },
      { id: 'stage-b', techniqueId: 'mosaic', enabled: true, params: { columns: 24 } },
    ];
    const modulations = [{
      id: 'mod-stage-b', enabled: true, source: 'image.luminance', target: 'columns', amount: 1,
      min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear' as const, frozenValue: 0.6,
      targetLayerId: layer.id, targetStageId: 'stage-b',
    }];
    const fake = await bootEngine({ ...project, layers: [{ ...layer, techniqueChain: chain }], modulations });
    takeRecorder.abort();
    takeRecorder.begin(0, captureBaseline(useProjectStore.getState().project));
    try {
      fake.emitRaw('dev-1', [0xb0, 21, 127]);
      const updated = useProjectStore.getState().project.layers[0]!;
      expect(updated.techniqueChain.find((stage) => stage.id === 'stage-b')?.params.columns).toBe(24);
      expect(useMidiStore.getState().status['mm-1']).toBe('frozen');
      expect(takeRecorder.stop(1, 'Frozen MIDI stage control')).toBeNull();
    } finally {
      midiEngine.stop();
      takeRecorder.abort();
    }
  });

  test('channel filter: wrong channel ignored; omni accepts all', async () => {
    const fake = await bootEngine(baseProject({ midiMappings: [ccMapping({ channel: 0, pickupMode: 'jump' })] }));
    fake.emitRaw('dev-1', [0xb1, 21, 127]); // channel 1
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(1);
    midiEngine.stop();
    const fake2 = await bootEngine(
      baseProject({ midiMappings: [ccMapping({ channel: null, pickupMode: 'jump' })] }),
    );
    fake2.emitRaw('dev-1', [0xb5, 21, 127]); // any channel
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).not.toBe(1);
    midiEngine.stop();
  });

  test('external param change (look apply) drops engaged pickup to waiting (§18)', async () => {
    const fake = await bootEngine(baseProject({ midiMappings: [ccMapping({})] }));
    for (let v = 0; v <= 127; v += 8) fake.emitRaw('dev-1', [0xb0, 21, v]);
    expect(midiEngine.getPickupState('mm-1')).toBe('live');
    // Commit the MIDI transient, then move params externally.
    useProjectStore.getState().commitTransient();
    useProjectStore.getState().apply((p) => ({
      ...p,
      layers: [{ ...p.layers[0]!, technique: { ...p.layers[0]!.technique!, params: { scale: 0.2 } } }],
    }));
    expect(midiEngine.getPickupState('mm-1')).toBe('waiting');
    // Knob must cross the NEW value before controlling again.
    fake.emitRaw('dev-1', [0xb0, 21, 120]);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(0.2);
    midiEngine.stop();
  });

  test('frozen target blocks MIDI (§17)', async () => {
    const frozenMod = {
      id: 'mod-f',
      enabled: true,
      source: 'bass',
      target: 'scale',
      amount: 0.5,
      min: 0,
      max: 1,
      invert: false,
      smoothing: 0,
      curve: 'linear' as const,
      frozenValue: 0.6,
    };
    const fake = await bootEngine(
      baseProject({
        modulations: [frozenMod],
        midiMappings: [ccMapping({ pickupMode: 'jump' })],
      }),
    );
    fake.emitRaw('dev-1', [0xb0, 21, 127]);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(1);
    expect(useMidiStore.getState().status['mm-1']).toBe('frozen');
    midiEngine.stop();
  });

  test('disabled mapping never applies', async () => {
    const fake = await bootEngine(
      baseProject({ midiMappings: [ccMapping({ enabled: false, pickupMode: 'jump' })] }),
    );
    fake.emitRaw('dev-1', [0xb0, 21, 127]);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(1);
    midiEngine.stop();
  });

  test('offline device: mapping persists, marked offline, reattaches on hot-plug', async () => {
    const fake = await bootEngine(baseProject({ midiMappings: [ccMapping({})] }));
    fake.setDevices([]);
    expect(useMidiStore.getState().status['mm-1']).toBe('offline');
    expect(useProjectStore.getState().project.midiMappings).toHaveLength(1);
    // Same hardware back under a NEW platform id → label fallback binds.
    fake.setDevices([{ id: 'dev-99', name: 'TestPad', manufacturer: 'Acme' }]);
    expect(useMidiStore.getState().bound['mm-1']).toBe('dev-99');
    fake.emitRaw('dev-99', [0xb0, 21, 0]);
    fake.emitRaw('dev-99', [0xb0, 21, 127]);
    expect(midiEngine.getPickupState('mm-1')).toBe('live');
    midiEngine.stop();
  });
});

describe('engine: MIDI Learn', () => {
  beforeEach(() => {
    useMidiStore.setState({ availability: 'idle', devices: [], bound: {}, status: {} });
  });

  test('CC learn requires meaningful movement; noise does not bind (§6)', async () => {
    const fake = await bootEngine(baseProject());
    const promise = midiEngine.startLearn({ targetType: 'param', targetParam: 'scale' }, 'Scale');
    fake.emitRaw('dev-1', [0xb0, 30, 64]); // first sighting: remember only
    fake.emitRaw('dev-1', [0xb0, 30, 66]); // Δ2 < 4 → noise
    expect(useMidiStore.getState().learn).not.toBeNull();
    fake.emitRaw('dev-1', [0xb0, 30, 80]); // Δ16 → binds
    const mapping = await promise;
    expect(mapping?.control).toBe(30);
    expect(mapping?.messageType).toBe('cc');
    expect(useProjectStore.getState().project.midiMappings).toHaveLength(1);
    midiEngine.stop();
  });

  test('stage-target learn persists identity and replaces only the same stage binding', async () => {
    const primary = ccMapping({ id: 'primary' });
    const stageA = ccMapping({ id: 'stage-a-old', targetLayerId: 'layer-1', targetStageId: 'stage-a' } as Partial<MidiMapping>);
    const stageB = ccMapping({ id: 'stage-b', targetLayerId: 'layer-1', targetStageId: 'stage-b' } as Partial<MidiMapping>);
    const fake = await bootEngine(baseProject({ midiMappings: [primary, stageA, stageB] }));
    const promise = midiEngine.startLearn(
      { targetType: 'param', targetParam: 'scale', targetLayerId: 'layer-1', targetStageId: 'stage-a' } as Parameters<typeof midiEngine.startLearn>[0],
      'Stage A · Scale',
    );
    fake.emitRaw('dev-1', [0xb0, 31, 20]);
    fake.emitRaw('dev-1', [0xb0, 31, 80]);
    const learned = await promise;
    expect(learned).toMatchObject({ targetLayerId: 'layer-1', targetStageId: 'stage-a' });
    const mappings = useProjectStore.getState().project.midiMappings;
    expect(mappings).toHaveLength(3);
    expect(mappings).toContainEqual(primary);
    expect(mappings).toContainEqual(stageB);
    expect(mappings.find((m) => (m as MidiMapping & { targetStageId?: string }).targetStageId === 'stage-a'))
      .toMatchObject({ control: 31, targetLayerId: 'layer-1', targetStageId: 'stage-a' });
    midiEngine.stop();
  });

  test('system noise (active sensing / clock) never reaches learn', async () => {
    const fake = await bootEngine(baseProject());
    void midiEngine.startLearn({ targetType: 'param', targetParam: 'scale' }, 'Scale');
    fake.emitRaw('dev-1', [0xfe]);
    fake.emitRaw('dev-1', [0xf8]);
    expect(useMidiStore.getState().learn).not.toBeNull();
    midiEngine.cancelLearn();
    midiEngine.stop();
  });

  test('note learn binds NoteOn only; learning replaces same-target binding', async () => {
    const fake = await bootEngine(baseProject());
    const p1 = midiEngine.startLearn(
      { targetType: 'triggerAction', action: 'toggleFreeze', targetMappingId: '*' },
      'Freeze',
    );
    fake.emitRaw('dev-1', [0x80, 36, 0]); // NoteOff → ignored
    expect(useMidiStore.getState().learn).not.toBeNull();
    fake.emitRaw('dev-1', [0x90, 36, 100]);
    const m1 = await p1;
    expect(m1?.messageType).toBe('note');
    expect(m1?.control).toBe(36);
    // Relearn the same action on a different pad → replaces, not duplicates.
    const p2 = midiEngine.startLearn(
      { targetType: 'triggerAction', action: 'toggleFreeze', targetMappingId: '*' },
      'Freeze',
    );
    fake.emitRaw('dev-1', [0x90, 40, 100]);
    await p2;
    const notes = useProjectStore.getState().project.midiMappings.filter((m) => m.messageType === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.control).toBe(40);
    midiEngine.stop();
  });

  test('cancel resolves null and disarms', async () => {
    await bootEngine(baseProject());
    const promise = midiEngine.startLearn({ targetType: 'param', targetParam: 'scale' }, 'Scale');
    midiEngine.cancelLearn();
    expect(await promise).toBeNull();
    expect(useMidiStore.getState().learn).toBeNull();
    midiEngine.stop();
  });
});

describe('engine: notes → trigger engine', () => {
  test('noteOn fires the mapped action through the live scheduler', async () => {
    const look = {
      id: 'look-a',
      createdAt: new Date(0).toISOString(),
      label: 'A',
      note: '',
      slot: 1,
      seed: 1,
      thumbnail: null,
      techniques: [
        { id: 't2', techniqueId: 'mosaic', enabled: true, params: { scale: 0.5 } },
      ],
      material: createEmptyProject().material,
      modulations: [],
      triggers: [],
    };
    const fake = await bootEngine(
      baseProject({
        pinnedLooks: [look],
        midiMappings: [
          ccMapping({
            id: 'mm-note',
            messageType: 'note',
            control: 37,
            targetType: 'triggerAction',
            action: 'applyLook',
            lookSlot: 1,
            targetParam: null,
          }),
        ],
      }),
    );
    fake.emitRaw('dev-1', [0x90, 37, 110]);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(0.5);
    expect(useProjectStore.getState().project.activeLookId).toBe('look-a');
    midiEngine.stop();
  });

  test('midi trigger source is live-class: export ignores it (§26)', () => {
    expect(isDeterministicSource('midi:mm-1')).toBe(false);
    expect(isDeterministicSource('manual')).toBe(false);
    expect(isDeterministicSource('beat')).toBe(true);
  });
});

describe('engine: quantized MIDI note + morph interaction', () => {
  test('quantized pad action waits for the musical boundary (§20)', async () => {
    const look = {
      id: 'look-q',
      createdAt: new Date(0).toISOString(),
      label: 'Q',
      note: '',
      slot: 1,
      seed: 1,
      thumbnail: null,
      techniques: [{ id: 't3', techniqueId: 'mosaic', enabled: true, params: { scale: 0.25 } }],
      material: createEmptyProject().material,
      modulations: [],
      triggers: [],
    };
    await bootEngine(
      baseProject({
        pinnedLooks: [look],
        timeline: { ...createEmptyProject().timeline, bpm: 120 },
      }),
    );
    // The engine synthesizes this exact shape on NoteOn; in jsdom the
    // playhead is pinned at 0 (a bar boundary), so fire at 0.3 directly —
    // same code path (fireLive → pending → advanceTo).
    const { liveScheduler: sched } = await import('@/signals/triggerRuntime');
    const ctx = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };
    sched.reset(0.3);
    sched.fireLive(
      {
        id: 'midi-mm-q',
        enabled: true,
        source: 'midi:mm-q',
        action: 'applyLook',
        targetParam: null,
        targetMappingId: null,
        lookSlot: 1,
        quantize: 'bar',
        cooldownSec: 0,
        attackSec: 0.01,
        holdSec: 0,
        decaySec: 0.18,
        amount: 0.8,
        curve: 'easeOut',
      },
      0.3,
      ctx,
    );
    // Pending — not applied yet; note the mapping is NOT in the configured
    // trigger list (regression: pending must carry the mapping object).
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(1);
    sched.advanceTo(1.9, [], ctx);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(1);
    sched.advanceTo(2.01, [], ctx);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(0.25);
    midiEngine.stop();
  });

  test('armed morph blocks CC writes (§19)', async () => {
    const look = {
      id: 'look-m',
      createdAt: new Date(0).toISOString(),
      label: 'M',
      note: '',
      slot: 2,
      seed: 1,
      thumbnail: null,
      techniques: [{ id: 't4', techniqueId: 'mosaic', enabled: true, params: { scale: 1.5 } }],
      material: createEmptyProject().material,
      modulations: [],
      triggers: [],
    };
    const fake = await bootEngine(
      baseProject({
        pinnedLooks: [look],
        midiMappings: [ccMapping({ pickupMode: 'jump' })],
      }),
    );
    const { morphRuntime } = await import('@/performance/morphRuntime');
    morphRuntime.start(
      'look-m',
      { startQuantize: 'off', duration: { mode: 'seconds', seconds: 60 }, curve: 'linear' },
      0,
    );
    fake.emitRaw('dev-1', [0xb0, 21, 127]);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).toBe(1);
    expect(useMidiStore.getState().status['mm-1']).toBe('morph');
    morphRuntime.abortSilently();
    // Morph gone → same knob movement applies again.
    fake.emitRaw('dev-1', [0xb0, 21, 127]);
    expect(useProjectStore.getState().project.layers[0]!.technique!.params.scale).not.toBe(1);
    midiEngine.stop();
  });
});
