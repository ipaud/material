import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useUiStore } from '@/state/uiStore';
import { playback } from '@/playback/PlaybackController';
import { takeRecorder } from '@/performance/take/recorder';
import { takePlayer } from '@/performance/take/player';
import { layerOpacityTarget, macroTarget, paramTarget } from '@/performance/take/model';
import { addGeneratorSource } from '@/projects/projectActions';
import {
  addLaneToTake,
  armRecord,
  cancelRecording,
  createManualTake,
  deleteTake,
  duplicateTake,
  editTake,
  keyframeTargets,
  playTake,
  renameTake,
  selectTake,
  stopRecording,
  toggleArm,
  toggleTakePlayback,
} from '@/performance/take/takeActions';

/** Performance Capture as the performer drives it: arm, record, stop, keep, and manage Takes. */

const project = () => useProjectStore.getState().project;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
let clock = 0;

/** Record one gesture so the Take is not empty. */
function play(): void {
  const layerId = project().layers[0]!.id;
  takeRecorder.control(layerOpacityTarget(layerId), 0.4, clock + 1, 1);
  clock += 2;
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(playback, 'getTime').mockImplementation(() => clock);
  vi.spyOn(playback, 'setLoop').mockImplementation((loop) => usePlaybackStore.getState().setLoop(loop));
  useProjectStore.getState().newProject();
  usePlaybackStore.setState({ playing: false, loop: false, durationSec: 0 });
  useUiStore.setState({ toasts: [] });
  takeRecorder.abort();
  takeRecorder.disarm();
  takePlayer.reset();
});

afterEach(() => {
  takeRecorder.abort();
  takePlayer.reset();
  vi.restoreAllMocks();
});

describe('recording', () => {
  it('arming a stopped transport waits for play; arming a running one starts now', () => {
    armRecord();
    expect(takeRecorder.armed).toBe(true);
    expect(takeRecorder.recording).toBe(false);
    toggleArm(); // disarm
    expect(takeRecorder.armed).toBe(false);

    usePlaybackStore.setState({ playing: true });
    armRecord();
    expect(takeRecorder.recording).toBe(true);
  });

  it('loop is suspended while recording and restored after', () => {
    usePlaybackStore.setState({ playing: true, loop: true });
    armRecord();
    expect(usePlaybackStore.getState().loop).toBe(false);
    expect(toasts()).toContain('Loop off while recording');
    play();
    stopRecording();
    expect(usePlaybackStore.getState().loop).toBe(true);
  });

  it('stopping commits the whole Take as one undo step and selects it', () => {
    usePlaybackStore.setState({ playing: true });
    armRecord();
    play();
    toggleArm(); // REC while recording stops it
    expect(project().takes).toHaveLength(1);
    expect(project().activeTakeId).toBe(project().takes[0]!.id);
    expect(toasts().at(-1)).toMatch(/^TAKE 01 — 2\.0s, 1 lanes, \d+ points, 0 events$/);
    useProjectStore.getState().undo();
    expect(project().takes).toHaveLength(0);
  });

  it('nothing played means nothing saved', () => {
    usePlaybackStore.setState({ playing: true });
    armRecord();
    expect(stopRecording()).toBeNull();
    expect(project().takes).toHaveLength(0);
    expect(toasts().at(-1)).toBe('Nothing was played — no Take saved');
    expect(stopRecording()).toBeNull(); // not recording: just disarms
    expect(takeRecorder.armed).toBe(false);
  });

  it('cancel throws the recording away and restores loop', () => {
    usePlaybackStore.setState({ playing: true, loop: true });
    armRecord();
    play();
    cancelRecording();
    expect(takeRecorder.recording).toBe(false);
    expect(project().takes).toHaveLength(0);
    expect(usePlaybackStore.getState().loop).toBe(true);
  });
});

describe('the Take library', () => {
  function recordOne(): string {
    usePlaybackStore.setState({ playing: true });
    armRecord();
    play();
    return stopRecording()!.id;
  }

  it('selecting a Take is focus, not an edit (no undo step, not dirty)', () => {
    const a = recordOne();
    const b = recordOne();
    useProjectStore.getState().markSaved('/s.material');
    selectTake(a);
    expect(project().activeTakeId).toBe(a);
    expect(useProjectStore.getState().dirty).toBe(false);
    selectTake(b);
    useProjectStore.getState().undo();
    expect(project().takes).toHaveLength(1); // the undo removed the last recording, not a selection
  });

  it('rename trims and caps; duplicate is selected; deleting the active one clears it', () => {
    const id = recordOne();
    renameTake(id, `  ${'x'.repeat(50)}  `);
    expect(project().takes[0]!.name).toBe('x'.repeat(40));
    renameTake(id, '   ');
    expect(project().takes[0]!.name).toBe('x'.repeat(40));

    const copy = duplicateTake(id)!;
    expect(project().takes[1]).toMatchObject({ id: copy, name: `${'x'.repeat(40)} COPY` });
    expect(project().activeTakeId).toBe(copy);
    expect(duplicateTake('missing')).toBeNull();

    deleteTake(copy);
    expect(project().activeTakeId).toBeNull();
    expect(project().takes.map((t) => t.id)).toEqual([id]);
  });

  it('play starts the selected Take; stop with nothing resolved commits nothing', () => {
    expect(playTake()).toBe(false);
    const id = recordOne();
    expect(playTake(id)).toBe(true);
    expect(takePlayer.isPlaying).toBe(true);
    const before = project();
    clock = -5; // before the Take: nothing to resolve
    toggleTakePlayback();
    expect(takePlayer.isPlaying).toBe(false);
    expect(project().layers[0]!.opacity).toBe(before.layers[0]!.opacity);
  });

  it('stopping replay keeps the faders where the Take left them, as one undo step', () => {
    const id = recordOne();
    playTake(id);
    clock = 1.5;
    toggleTakePlayback();
    expect(project().layers[0]!.opacity).toBeCloseTo(0.4);
    useProjectStore.getState().undo();
    expect(project().layers[0]!.opacity).toBe(1);
  });

  it('an edit that changes nothing is not an undo step', () => {
    const id = recordOne();
    const before = project();
    editTake(id, (t) => t);
    editTake('missing', (t) => ({ ...t, name: 'x' }));
    expect(project()).toBe(before);
  });
});

describe('hand-drawn keyframes', () => {
  it('a manual Take spans the song, or 10 s without one', () => {
    createManualTake();
    expect(project().takes[0]!.durationSec).toBe(10);
    usePlaybackStore.setState({ durationSec: 95 });
    createManualTake();
    expect(project().takes[1]!.durationSec).toBe(95);
    expect(project().takes.map((t) => t.name)).toEqual(['TAKE 01', 'TAKE 02']);
  });

  it('lists every drivable control and starts a lane at the control’s current value', () => {
    addGeneratorSource('noise');
    useProjectStore.getState().apply((p) => ({
      ...p,
      macros: [{ id: 'mx', name: 'Energy', value: 0.7, bindings: [] }] as unknown as typeof p.macros,
    }));
    const targets = keyframeTargets(project());
    const layer = project().layers[0]!;
    expect(targets[0]).toEqual({ target: layerOpacityTarget(layer.id), label: 'Layer 1 · Opacity' });
    expect(targets.some((t) => t.target === paramTarget(layer.id, 'scale'))).toBe(true);
    expect(targets.at(-1)).toEqual({ target: macroTarget('mx'), label: 'Macro · Energy' });

    const take = createManualTake();
    addLaneToTake(take, macroTarget('mx'));
    addLaneToTake(take, paramTarget(layer.id, 'scale'));
    const lanes = project().takes[0]!.lanes;
    expect(lanes.map((l) => l.samples[0]!.v)).toEqual([0.7, layer.technique!.params.scale]);
  });
});
