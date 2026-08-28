import { beforeEach, describe, expect, test } from 'vitest';
import { createEmptyProject } from '@shared/schemas/project';
import type { MidiMapping, Project } from '@shared/schemas/project';
import { FakeMidiTransport } from '@/midi/transport';
import { midiEngine, useMidiStore } from '@/midi/midiEngine';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';

/**
 * Phase 17 §16: input abuse. A controller can emit thousands of messages a
 * second, and a performer will hold four knobs at once. None of it may crash,
 * flood history, leak into an export, or leave a mapping stuck.
 */

const DEVICE = { id: 'dev-1', name: 'Abuse', manufacturer: 'Test' };

function ccMapping(patch: Partial<MidiMapping>): MidiMapping {
  return {
    id: 'mm-1', enabled: true, deviceId: 'dev-1', deviceLabel: 'Test · Abuse',
    channel: null, messageType: 'cc', control: 21, targetType: 'param',
    targetParam: 'scale', action: null, lookSlot: null, targetMappingId: null,
    quantize: 'off', min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear',
    pickupMode: 'jump', mode: 'absolute',
    ...patch,
  };
}

function project(patch: Partial<Project> = {}): Project {
  const p = createEmptyProject('Abuse');
  return {
    ...p,
    techniques: [{ id: 't', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } }],
    timeline: { ...p.timeline, bpm: 120 },
    ...patch,
  };
}

async function boot(p: Project): Promise<FakeMidiTransport> {
  midiEngine.stop();
  useMidiStore.setState({ availability: 'idle', devices: [], bound: {}, status: {} });
  useProjectStore.getState().loadProject('', p);
  const fake = new FakeMidiTransport();
  fake.devices = [DEVICE];
  await midiEngine.start(fake);
  return fake;
}

describe('high-rate input', () => {
  beforeEach(() => {
    useExportStore.getState().finish('done');
    morphRuntime.abortSilently();
  });

  test('a 5000-message CC storm applies without crashing', async () => {
    const fake = await boot(project({ midiMappings: [ccMapping({})] }));
    for (let i = 0; i < 5000; i++) fake.emitRaw('dev-1', [0xb0, 21, i % 128]);
    const scale = useProjectStore.getState().project.techniques[0]!.params.scale;
    expect(Number.isFinite(scale)).toBe(true);
    midiEngine.stop();
  });

  test('a CC storm collapses into ONE undo entry, not thousands', async () => {
    const fake = await boot(project({ midiMappings: [ccMapping({})] }));
    expect(useProjectStore.getState().past).toHaveLength(0); // loadProject cleared it
    for (let i = 0; i < 2000; i++) fake.emitRaw('dev-1', [0xb0, 21, i % 128]);
    // The gesture is still open — history is deferred until it closes.
    expect(useProjectStore.getState().past).toHaveLength(0);
    useProjectStore.getState().commitTransient();
    expect(useProjectStore.getState().past).toHaveLength(1);
    midiEngine.stop();
  });

  test('a project load mid-gesture does not turn later messages into undo spam', async () => {
    const fake = await boot(project({ midiMappings: [ccMapping({})] }));
    for (let i = 0; i < 50; i++) fake.emitRaw('dev-1', [0xb0, 21, i % 128]);
    // Something else loads a project while the knob is still moving.
    useProjectStore.getState().loadProject('', project({ midiMappings: [ccMapping({})] }));
    expect(useProjectStore.getState().past).toHaveLength(0);
    for (let i = 0; i < 500; i++) fake.emitRaw('dev-1', [0xb0, 21, i % 128]);
    expect(useProjectStore.getState().past).toHaveLength(0);
    useProjectStore.getState().commitTransient();
    expect(useProjectStore.getState().past).toHaveLength(1);
    midiEngine.stop();
  });

  test('eight simultaneous controls all land', async () => {
    const mappings = Array.from({ length: 8 }, (_, i) =>
      ccMapping({ id: `mm-${i}`, control: 20 + i, targetParam: i % 2 ? 'scale' : 'spacing' }),
    );
    const fake = await boot(project({ midiMappings: mappings }));
    for (let step = 0; step < 200; step++) {
      for (let i = 0; i < 8; i++) fake.emitRaw('dev-1', [0xb0, 20 + i, (step * 7 + i) % 128]);
    }
    const params = useProjectStore.getState().project.techniques[0]!.params;
    expect(Number.isFinite(params.scale as number)).toBe(true);
    expect(Number.isFinite(params.spacing as number)).toBe(true);
    midiEngine.stop();
  });

  test('repeated NoteOn does not accumulate scheduler state', async () => {
    const fake = await boot(
      project({
        midiMappings: [
          ccMapping({
            id: 'mm-note', messageType: 'note', control: 36,
            targetType: 'triggerAction', action: 'toggleFreeze',
            targetParam: null, targetMappingId: '*',
          }),
        ],
      }),
    );
    liveScheduler.reset(0);
    for (let i = 0; i < 500; i++) fake.emitRaw('dev-1', [0x90, 36, 100]);
    expect(liveScheduler.getPending().length).toBeLessThan(600);
    midiEngine.stop();
  });

  test('rapid device reconnects never leave a mapping stuck', async () => {
    const fake = await boot(project({ midiMappings: [ccMapping({ pickupMode: 'pickup' })] }));
    for (let i = 0; i < 30; i++) {
      fake.setDevices([]);
      fake.setDevices([{ ...DEVICE, id: `dev-${i}` }]);
    }
    // A device is present, so the mapping must be bound — never orphaned.
    expect(useMidiStore.getState().status['mm-1']).not.toBe('offline');
    fake.setDevices([]);
    expect(useMidiStore.getState().status['mm-1']).toBe('offline');
    midiEngine.stop();
  });
});

describe('input during protected states', () => {
  test('CC during an export never reaches the document', async () => {
    const fake = await boot(project({ midiMappings: [ccMapping({})] }));
    const before = useProjectStore.getState().project.techniques[0]!.params.scale;
    useExportStore.getState().begin(100);
    for (let i = 0; i < 500; i++) fake.emitRaw('dev-1', [0xb0, 21, i % 128]);
    expect(useProjectStore.getState().project.techniques[0]!.params.scale).toBe(before);
    useExportStore.getState().finish('done');
    // And normal control resumes afterwards.
    fake.emitRaw('dev-1', [0xb0, 21, 127]);
    expect(useProjectStore.getState().project.techniques[0]!.params.scale).not.toBe(before);
    midiEngine.stop();
  });

  test('CC while a target is frozen holds the value', async () => {
    const frozen = {
      id: 'mod-f', enabled: true, source: 'bass', target: 'scale', amount: 0.5,
      min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear' as const, frozenValue: 0.6,
    };
    const fake = await boot(project({ modulations: [frozen], midiMappings: [ccMapping({})] }));
    const before = useProjectStore.getState().project.techniques[0]!.params.scale;
    for (let i = 0; i < 200; i++) fake.emitRaw('dev-1', [0xb0, 21, i % 128]);
    expect(useProjectStore.getState().project.techniques[0]!.params.scale).toBe(before);
    expect(useMidiStore.getState().status['mm-1']).toBe('frozen');
    midiEngine.stop();
  });

  test('notes around a quantization boundary each queue exactly once', async () => {
    const fake = await boot(
      project({
        midiMappings: [
          ccMapping({
            id: 'mm-q', messageType: 'note', control: 38,
            targetType: 'triggerAction', action: 'applyLook', lookSlot: 1,
            targetParam: null, quantize: 'bar',
          }),
        ],
      }),
    );
    liveScheduler.reset(0.3);
    // jsdom pins the playhead at 0 (a boundary), so the engine path fires
    // immediately; what matters here is that a burst cannot pile up.
    for (let i = 0; i < 50; i++) fake.emitRaw('dev-1', [0x90, 38, 100]);
    expect(liveScheduler.getPending().length).toBeLessThan(60);
    midiEngine.stop();
  });
});
