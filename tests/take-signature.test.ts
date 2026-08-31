import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseProject, type PerformanceTake } from '@shared/schemas/project';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';
import { useProjectStore } from '@/state/projectStore';
import { playback } from '@/playback/PlaybackController';
import { createFrameEvaluator, createSecondaryLayerEvaluator } from '@/export/exportRunner';
import { takePlayer } from '@/performance/take/player';
import { takeRecorder } from '@/performance/take/recorder';
import { morphRuntime } from '@/performance/morphRuntime';
import { resolveAgainstProject, resolveTakeAt } from '@/performance/take/evaluate';

/**
 * v0.7 — THE flagship regression (§96, §159).
 *
 * A real-shaped performance, committed to disk as a project fixture so the
 * whole chain is exercised: parse, migrate, replay, seek, and export. Every
 * control class the Take contract admits appears in it once.
 *
 *   0.0s  Look A recalled
 *   1–3s  base layer's `scale` dragged 1 → 3.5
 *   2–4s  layer 2 opacity ramped 1 → 0.15
 *   4–7s  macro swept up and released
 *   6.0s  morph to Look B over two seconds
 *   8.0s  Freeze
 *   8.5s  unfreeze (from MIDI)
 *  10–12s layer 3 faded out, then muted at 11s
 */

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/v07-signature.material');
const load = () => parseProject(JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>);

let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(playback, 'getTime').mockImplementation(() => clock);
  takeRecorder.abort();
  takePlayer.reset();
  morphRuntime.abortSilently();
  useProjectStore.setState({
    project: load(),
    past: [],
    future: [],
    dirty: false,
    transientBase: null,
    silent: false,
  });
});

const take = (): PerformanceTake => useProjectStore.getState().project.takes[0]!;

function exportParams(fps: number, fromSec: number, frames: number): Record<string, unknown>[] {
  const evaluate = createFrameEvaluator(0, fps);
  const startFrame = Math.round(fromSec * fps);
  const out: Record<string, unknown>[] = [];
  for (let f = 0; f < startFrame; f++) evaluate(f);
  for (let i = 0; i < frames; i++) out.push({ ...evaluate(startFrame + i).params });
  return out;
}

describe('the signature Take survives the round trip', () => {
  it('parses at the current schema version with everything intact', () => {
    const project = load();
    expect(project.version).toBe(PROJECT_FORMAT_VERSION);
    const t = project.takes[0]!;
    expect(t.name).toBe('SIGNATURE');
    expect(t.durationSec).toBe(12);
    expect(t.lanes).toHaveLength(4);
    expect(t.events.map((e) => e.kind)).toEqual([
      'look.recall',
      'morph.start',
      'freeze.set',
      'freeze.set',
      'layer.enable',
    ]);
    expect(project.activeTakeId).toBe(t.id);
  });

  it('re-serialising and re-parsing changes nothing', () => {
    const once = load();
    const twice = parseProject(JSON.parse(JSON.stringify(once)) as Record<string, unknown>);
    expect(twice).toEqual(once);
  });

  it('every target it names still exists', () => {
    const project = useProjectStore.getState().project;
    expect(resolveAgainstProject(take(), project)).toEqual({
      unresolvedLanes: [],
      unresolvedEvents: [],
    });
  });

  it('records that one event came from MIDI, as diagnostics only', () => {
    const origins = take().events.map((e) => e.origin);
    expect(origins).toContain('midi');
    // …and origin is never a replay input: the resolver ignores it entirely.
    const midiOnly = { ...take(), events: take().events.map((e) => ({ ...e, origin: 'user' as const })) };
    expect(resolveTakeAt(midiOnly, 9)).toEqual(resolveTakeAt(take(), 9));
  });
});

describe('replay reaches every control class', () => {
  it('resolves each lane at the instant it should', () => {
    const t = take();
    expect(resolveTakeAt(t, 0).opacity.get('sig_l2')).toBe(1);
    expect(resolveTakeAt(t, 3).opacity.get('sig_l2')).toBeCloseTo(0.575, 3);
    expect(resolveTakeAt(t, 4).opacity.get('sig_l2')).toBeCloseTo(0.15, 3);
    expect(resolveTakeAt(t, 6).macros.get('sig_macro')).toBeCloseTo(1, 3);
    expect(resolveTakeAt(t, 7).macros.get('sig_macro')).toBeCloseTo(0.2, 3);
    expect(resolveTakeAt(t, 2).params.get('sig_l1')?.scale).toBeCloseTo(2.25, 3);
    expect(resolveTakeAt(t, 12).opacity.get('sig_l3')).toBe(0);
  });

  it('seeks INTO the morph and lands on the right progress', () => {
    const t = take();
    takePlayer.start(t, 7); // morph runs 6 → 8
    const active = morphRuntime.current;
    expect(active).not.toBeNull();
    expect(active!.startTime).toBe(6);
    expect(active!.endTime).toBe(8);
    expect(morphRuntime.progressAt(7)).toBeCloseTo(0.5, 9);
    // The interpolated core at the midpoint is between the two Looks.
    const mid = morphRuntime.resolveOverlay(7)!;
    const a = 6;
    const b = 12;
    expect(mid.params.scale as number).toBeGreaterThan(a);
    expect(mid.params.scale as number).toBeLessThan(b);
  });

  it('seeking backwards out of the morph leaves no zombie', () => {
    const t = take();
    takePlayer.start(t, 7);
    expect(morphRuntime.progressAt(7)).not.toBeNull();
    takePlayer.seek(3);
    // Before the morph's start there is no overlay at all: the composition
    // shows the document, not the morph's frozen source snapshot.
    expect(morphRuntime.resolveOverlay(3)).toBeNull();
  });

  it('reconstructs freeze state on either side of the pair', () => {
    const t = take();
    const frozenCount = () =>
      useProjectStore.getState().project.modulations.filter((m) => m.frozenValue !== null).length;
    takePlayer.start(t, 8.25);
    expect(frozenCount()).toBe(1);
    takePlayer.seek(9);
    expect(frozenCount()).toBe(0);
    takePlayer.seek(8.25);
    expect(frozenCount()).toBe(1);
    takePlayer.seek(1);
    expect(frozenCount()).toBe(0);
  });

  it('reconstructs layer visibility', () => {
    const t = take();
    const enabled = () =>
      useProjectStore.getState().project.layers.find((l) => l.id === 'sig_l3')!.enabled;
    takePlayer.start(t, 11.5);
    expect(enabled()).toBe(false);
    takePlayer.seek(5);
    expect(enabled()).toBe(true);
  });

  it('a replayed morph writes no morph history and no dirty flag', () => {
    const t = take();
    useProjectStore.setState({ dirty: false, past: [] });
    takePlayer.start(t, 5.9);
    for (let f = Math.round(5.9 * 30); f <= 9 * 30; f++) {
      const time = f / 30;
      takePlayer.tick(time);
      morphRuntime.tick(time);
    }
    // The morph completed — the composition is on Look B…
    expect(morphRuntime.current).toBeNull();
    // …and it left no second record of itself. Two records means the next
    // export replays the same gesture twice.
    expect(useProjectStore.getState().project.morphEvents).toHaveLength(0);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.getState().past).toHaveLength(0);
  });
});

describe('the signature Take as an export program', () => {
  it('ANTI-NOOP: deselecting it changes the render', () => {
    const withTake = exportParams(30, 0, 12 * 30);
    useProjectStore.setState({
      project: { ...useProjectStore.getState().project, activeTakeId: null },
    });
    const without = exportParams(30, 0, 12 * 30);
    expect(withTake).not.toEqual(without);
  });

  it('TIME-LIVENESS: the parameter path actually moves', () => {
    const frames = exportParams(30, 0, 12 * 30);
    const scales = new Set(frames.map((f) => f.scale));
    expect(scales.size).toBeGreaterThan(20);
  });

  it('REPEAT: twelve identical runs', () => {
    const golden = JSON.stringify(exportParams(30, 3, 90));
    for (let i = 0; i < 11; i++) {
      expect(JSON.stringify(exportParams(30, 3, 90))).toBe(golden);
    }
  });

  it('FULL vs SUBRANGE: matching global frames agree, morph included', () => {
    const full = exportParams(30, 0, 12 * 30);
    for (const [from, count] of [
      [1, 60],
      [6.5, 45],
      [9, 60],
    ] as const) {
      const sub = exportParams(30, from, count);
      for (let i = 0; i < count; i++) {
        expect(sub[i], `from ${from}s, global frame ${Math.round(from * 30) + i}`).toEqual(
          full[Math.round(from * 30) + i],
        );
      }
    }
  });

  it('CROSS-FPS: the same composition time resolves identically', () => {
    // Whole seconds only, on purpose: a 25fps render has no frame at 2.5s, so
    // comparing "the last frame before 2.5s" across rates compares different
    // instants. The contract is that the same composition TIME resolves to the
    // same value — not that every rate can land on every time (§101).
    const at = (fps: number, sec: number) => exportParams(fps, 0, Math.round(sec * fps) + 1).pop()!;
    for (const sec of [2, 5, 7, 11]) {
      const golden = at(30, sec).scale as number;
      for (const fps of [24, 25, 60]) {
        expect(at(fps, sec).scale as number, `${sec}s @ ${fps}fps`).toBeCloseTo(golden, 6);
      }
    }
  });

  it('layer opacity and visibility both reach the export', () => {
    const project = useProjectStore.getState().project;
    const layers = createSecondaryLayerEvaluator(project, 'sig_l1', 30, () => ({}), take());
    expect(layers.opacityAt(0).get('sig_l2')).toBe(1);
    expect(layers.opacityAt(4).get('sig_l2')).toBeCloseTo(0.15, 3);
    const evaluate = createFrameEvaluator(0, 30);
    for (let f = 0; f <= 12 * 30; f++) evaluate(f);
    expect(evaluate.layerEnabled().get('sig_l3')).toBe(false);
  });
});
