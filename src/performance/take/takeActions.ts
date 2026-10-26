import type { PerformanceTake, Project, TakeBaseline } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
import { uid } from '@/utils/id';
import { takeRecorder } from './recorder';
import { takePlayer } from './player';
import { addLane } from './edit';
import { layerOpacityTarget, macroTarget, paramTarget, stageParamTarget, parseControlTarget } from './model';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';

/**
 * v0.7 — Take-level operations: arm, record, replay, and the small library
 * of Takes a project holds.
 *
 * Deliberately NOT a gesture module: nothing here is recordable. Selecting a
 * Take is not a performance, and a Take that recorded its own selection would
 * be a loop waiting to happen.
 */

function nextTakeName(project: Project): string {
  return `TAKE ${String(project.takes.length + 1).padStart(2, '0')}`;
}

/**
 * The state the performance starts from.
 *
 * Layers and freezes are captured whole — four booleans and one nullable
 * number per mapping. Continuous values are NOT captured here: the recorder
 * adds each one the first time it is touched, which is both smaller and more
 * accurate, since the value that matters is the one immediately before the
 * hand arrived (§52).
 */
export function captureBaseline(project = useProjectStore.getState().project): TakeBaseline {
  const layerEnabled: Record<string, boolean> = {};
  for (const layer of project.layers) layerEnabled[layer.id] = layer.enabled;
  const frozen: Record<string, number | null> = {};
  for (const m of project.modulations) frozen[m.id] = m.frozenValue;
  // lookCore is captured lazily, the first time the Take actually recalls a
  // Look — a Take that never does should not carry a copy of the composition.
  return { lanes: {}, layerEnabled, frozen, lookCore: null, activeLookId: null };
}

/** Loop state suspended for the duration of a recording — see beginRecording. */
let loopBeforeRecord: boolean | null = null;

export function armRecord(): void {
  if (takeRecorder.recording) return;
  takeRecorder.arm();
  if (usePlaybackStore.getState().playing) beginRecording();
}

export function disarmRecord(): void {
  takeRecorder.disarm();
}

export function toggleArm(): void {
  if (takeRecorder.recording) {
    stopRecording();
    return;
  }
  if (takeRecorder.armed) disarmRecord();
  else armRecord();
}

/**
 * Start capturing at the current playhead.
 *
 * Called when an armed transport starts, and immediately when REC is pressed
 * on a transport already running — the second case is what makes "hit play on
 * the song, then hit record" line up with composition t=0 (§123).
 *
 * Looping is suspended for the duration. A wrapped playhead would send event
 * times backwards into a lane that has to stay monotonic, and multi-cycle
 * takes are explicitly out of scope for v0.7 (§40).
 */
export function beginRecording(): void {
  if (takeRecorder.recording) return;
  const { loop } = usePlaybackStore.getState();
  loopBeforeRecord = loop;
  if (loop) {
    playback.setLoop(false);
    useUiStore.getState().pushToast('info', 'Loop off while recording');
  }
  // A Take replaying into a Take being recorded would capture the replay.
  takePlayer.stop();
  takeRecorder.begin(playback.getTime(), captureBaseline());
}

/**
 * Stop and commit.
 *
 * ONE project transaction, not thousands (§75): every sample and event lands
 * in a single `apply`, so undo removes the whole Take.
 */
export function stopRecording(): PerformanceTake | null {
  if (!takeRecorder.recording) {
    takeRecorder.disarm();
    return null;
  }
  const { project } = useProjectStore.getState();
  const take = takeRecorder.stop(playback.getTime(), nextTakeName(project));
  if (loopBeforeRecord !== null) {
    playback.setLoop(loopBeforeRecord);
    loopBeforeRecord = null;
  }
  if (!take) {
    useUiStore.getState().pushToast('info', 'Nothing was played — no Take saved');
    return null;
  }
  useProjectStore.getState().apply((p) => ({
    ...p,
    takes: [...p.takes, take],
    activeTakeId: take.id,
  }));
  const samples = take.lanes.reduce((n, l) => n + l.samples.length, 0);
  useUiStore
    .getState()
    .pushToast(
      'info',
      `${take.name} — ${take.durationSec.toFixed(1)}s, ${take.lanes.length} lanes, ${samples} points, ${take.events.length} events`,
    );
  return take;
}

export function cancelRecording(): void {
  takeRecorder.abort();
  if (loopBeforeRecord !== null) {
    playback.setLoop(loopBeforeRecord);
    loopBeforeRecord = null;
  }
}

// ---- Replay ---------------------------------------------------------------

export function activeTake(project = useProjectStore.getState().project): PerformanceTake | null {
  return project.takes.find((t) => t.id === project.activeTakeId) ?? null;
}

export function playTake(takeId?: string): boolean {
  const { project } = useProjectStore.getState();
  const take = takeId ? project.takes.find((t) => t.id === takeId) : activeTake(project);
  if (!take) return false;
  if (takeRecorder.recording) stopRecording();
  if (take.id !== project.activeTakeId) selectTake(take.id);
  takePlayer.start(take, playback.getTime());
  return true;
}

/**
 * The performer pressed STOP.
 *
 * The composition stays where the Take left it (§117), which for the discrete
 * side is automatic — a recalled Look and a muted layer are already in the
 * document. The continuous side is not: lanes drive an overlay that never
 * writes, so releasing it alone would snap every fader back to its stored
 * value the instant you stopped.
 *
 * So a deliberate stop COMMITS the resolved values, as one undo entry. That is
 * not playback dirtying the project — it is the performer saying "keep the
 * faders here and let me take over", and taking over from a value that just
 * jumped somewhere else is the thing that makes a Take unusable live. The
 * internal release (`takePlayer.stop()`, used when another Take is selected or
 * a recording begins) commits nothing.
 */
export function stopTake(): void {
  const resolved = takePlayer.resolvedAt(playback.getTime());
  takePlayer.stop();
  if (!resolved) return;
  if (resolved.opacity.size === 0 && resolved.macros.size === 0 && resolved.params.size === 0 && resolved.stageParams.size === 0) {
    return;
  }
  useProjectStore.getState().apply((p) => ({
    ...p,
    layers: p.layers.map((l) => {
      const opacity = resolved.opacity.get(l.id);
      const params = resolved.params.get(l.id);
      const stageParams = resolved.stageParams.get(l.id);
      if (opacity === undefined && !params && !stageParams) return l;
      return {
        ...l,
        opacity: opacity ?? l.opacity,
        technique:
          params && l.technique
            ? { ...l.technique, params: { ...l.technique.params, ...params } }
            : l.technique,
        techniqueChain: stageParams ? l.techniqueChain.map((stage) => {
          const values = stageParams.get(stage.id);
          return values ? { ...stage, params: { ...stage.params, ...values } } : stage;
        }) : l.techniqueChain,
      };
    }),
    macros: p.macros.map((m) => {
      const v = resolved.macros.get(m.id);
      return v === undefined ? m : { ...m, value: v };
    }),
  }));
}

export function toggleTakePlayback(): void {
  if (takePlayer.isPlaying) stopTake();
  else playTake();
}

// ---- Library --------------------------------------------------------------

/** Selection is editing focus, so it does not dirty the project (§76). */
export function selectTake(takeId: string | null): void {
  const { project } = useProjectStore.getState();
  if (project.activeTakeId === takeId) return;
  if (takePlayer.isPlaying) takePlayer.stop();
  useProjectStore.getState().runSilently(() => {
    useProjectStore.getState().apply((p) => ({ ...p, activeTakeId: takeId }));
  });
}

export function renameTake(takeId: string, name: string): void {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return;
  useProjectStore.getState().apply((p) => ({
    ...p,
    takes: p.takes.map((t) => (t.id === takeId ? { ...t, name: trimmed } : t)),
  }));
}

export function duplicateTake(takeId: string): string | null {
  const { project } = useProjectStore.getState();
  const source = project.takes.find((t) => t.id === takeId);
  if (!source) return null;
  const id = uid('take');
  useProjectStore.getState().apply((p) => ({
    ...p,
    takes: [
      ...p.takes,
      { ...source, id, name: `${source.name} COPY`, createdAt: new Date().toISOString() },
    ],
    activeTakeId: id,
  }));
  return id;
}

/**
 * Apply a pure Take edit through the store.
 *
 * ONE undo entry per operation, and the editing surface never touches a
 * runtime: the player reads whatever the project holds, so an edited Take
 * takes effect on the next evaluation with nothing to invalidate.
 */
export function editTake(
  takeId: string,
  edit: (take: PerformanceTake) => PerformanceTake,
): void {
  useProjectStore.getState().apply((p) => {
    const current = p.takes.find((t) => t.id === takeId);
    if (!current) return p;
    const next = edit(current);
    if (next === current) return p;
    return { ...p, takes: p.takes.map((t) => (t.id === takeId ? next : t)) };
  });
  // A Take being replayed has to pick the edit up immediately, or the panel
  // and the picture disagree until the next transport action.
  if (takePlayer.isPlaying) {
    const next = activeTake();
    if (next && next.id === takeId) takePlayer.start(next, playback.getTime());
  }
}

export function deleteTake(takeId: string): void {
  if (takePlayer.isPlaying && activeTake()?.id === takeId) takePlayer.reset();
  useProjectStore.getState().apply((p) => ({
    ...p,
    takes: p.takes.filter((t) => t.id !== takeId),
    activeTakeId: p.activeTakeId === takeId ? null : p.activeTakeId,
  }));
}


// ---- Hand-authored keyframes ----------------------------------------------

/**
 * An empty Take to draw lanes into. Same object the recorder produces, so
 * playback, export and the lane editor treat it identically; `durationSec`
 * defaults to the composition length so keys can reach the end of the piece.
 */
export function createManualTake(durationSec?: number): string {
  const clock = usePlaybackStore.getState().durationSec;
  const length = Math.max(durationSec ?? (clock > 0 ? clock : 10), 1);
  const project = useProjectStore.getState().project;
  const take: PerformanceTake = {
    id: uid('take'),
    name: nextTakeName(project),
    createdAt: new Date().toISOString(),
    startSec: 0,
    durationSec: length,
    lanes: [],
    events: [],
    baseline: captureBaseline(project),
  };
  useProjectStore.getState().apply((p) => ({
    ...p,
    takes: [...p.takes, take],
    activeTakeId: take.id,
  }));
  return take.id;
}

export interface KeyframeTarget {
  target: string;
  label: string;
}

/** Everything a lane can drive: layer opacities, macros and modulatable parameters. */
export function keyframeTargets(project: Project): KeyframeTarget[] {
  const out: KeyframeTarget[] = [];
  project.layers.forEach((layer, i) => {
    const name = layer.name || `Layer ${i + 1}`;
    out.push({ target: layerOpacityTarget(layer.id), label: `${name} · Opacity` });
    const def = layer.technique ? getTechnique(layer.technique.techniqueId) : null;
    if (!def) return;
    for (const p of allParams(def)) {
      if (p.type === 'number' && p.modulatable) {
        out.push({ target: paramTarget(layer.id, p.id), label: `${name} · ${p.label}` });
      }
    }
    layer.techniqueChain.forEach((stage, stageIndex) => {
      const stageDef = getTechnique(stage.techniqueId);
      if (!stageDef || !stage.enabled) return;
      for (const p of allParams(stageDef)) {
        if (p.type === 'number' && p.modulatable) {
          out.push({ target: stageParamTarget(layer.id, stage.id, p.id), label: `${name} · Stage ${stageIndex + 2} ${p.label}` });
        }
      }
    });
  });
  for (const m of project.macros) out.push({ target: macroTarget(m.id), label: `Macro · ${m.name}` });
  return out;
}

/** The control's value right now: what a fresh lane should hold until keys move it. */
function currentValue(project: Project, target: string): number {
  const parsed = parseControlTarget(target);
  if (!parsed) return 0;
  if (parsed.kind === 'layerOpacity') {
    return project.layers.find((l) => l.id === parsed.layerId)?.opacity ?? 1;
  }
  if (parsed.kind === 'macro') return project.macros.find((m) => m.id === parsed.macroId)?.value ?? 0;
  const layer = project.layers.find((l) => l.id === parsed.layerId);
  if (parsed.stageId) {
    const stage = layer?.techniqueChain.find((entry) => entry.id === parsed.stageId);
    const stored = stage?.params[parsed.paramId];
    if (typeof stored === 'number') return stored;
    const definition = stage ? getTechnique(stage.techniqueId) : null;
    const param = definition ? allParams(definition).find((entry) => entry.id === parsed.paramId) : null;
    return param && param.type === 'number' ? param.default : 0;
  }
  const stored = layer?.technique?.params[parsed.paramId];
  if (typeof stored === 'number') return stored;
  const def = layer?.technique ? getTechnique(layer.technique.techniqueId) : null;
  const param = def ? allParams(def).find((p) => p.id === parsed.paramId) : null;
  return param && param.type === 'number' ? param.default : 0;
}

export function addLaneToTake(takeId: string, target: string): void {
  const project = useProjectStore.getState().project;
  editTake(takeId, (take) => addLane(take, target, currentValue(project, target)));
}
