import type { PerformanceTake, Project, TakeBaseline } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
import { uid } from '@/utils/id';
import { takeRecorder } from './recorder';
import { takePlayer } from './player';

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
  return { lanes: {}, layerEnabled, frozen };
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

export function stopTake(): void {
  takePlayer.stop();
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
