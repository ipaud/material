import { audioEngine } from '@/audio/AudioEngine';
import { detectTempo } from '@/audio/tempo';
import { onsetEventTimes } from '@/signals/triggerSources';
import { runAnimationExport } from '@/export/exportRunner';
import { defaultFps, probeSourceFps } from '@/export/exportSettings';
import { openProjectFromPath } from '@/projects/projectActions';
import { playback } from '@/playback/PlaybackController';
import { useAudioStore } from '@/state/audioStore';
import { useExportStore } from '@/state/exportStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { isFileSource } from '@shared/schemas/project';
import type { ExportFormat } from '@shared/ipc';

/**
 * Entry points for the headless CLI (electron/cli). The main process drives a
 * hidden window through these, so `material render` runs EXACTLY the code the
 * export dialog runs — same evaluator, same engine, same encoder.
 */
export interface RenderJob {
  project: string;
  out: string;
  codec: 'prores422hq' | 'prores4444' | 'h264';
  fps: number | null;
  range: [number, number] | null;
}

const FORMAT: Record<RenderJob['codec'], ExportFormat> = {
  prores422hq: 'prores422',
  prores4444: 'prores4444',
  h264: 'h264',
};
const READY_TIMEOUT_MS = 120_000;
const FALLBACK_FPS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until every file source the project uses has decoded (or failed loudly). */
async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const ui = useUiStore.getState();
    if (ui.pendingProxy) {
      throw new Error(
        `Cannot play ${ui.pendingProxy.path} (${ui.pendingProxy.codec ?? 'unknown codec'}); ` +
          'open the project once in MATERIAL and make the H.264 proxy',
      );
    }
    const { project } = useProjectStore.getState();
    const needsVideo = project.sources.some(
      (s) => s.kind === 'video' && project.layers.some((l) => l.sourceId === s.id),
    );
    const needsAudio = project.composition.audioSourceId !== null;
    const videoReady = !needsVideo || playback.hasVideo;
    const audioReady = !needsAudio || !useAudioStore.getState().loading;
    if (videoReady && audioReady) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for media to load');
    await sleep(100);
  }
}

async function render(job: RenderJob): Promise<{ out: string; frames: number }> {
  await openProjectFromPath(job.project);
  const repair = useUiStore.getState().pendingRepair;
  if (repair) {
    throw new Error(`Invalid project:\n${repair.issues.map((i) => `  ${i.text}`).join('\n')}`);
  }
  await waitUntilReady();
  const { project } = useProjectStore.getState();

  const fps = job.fps ?? defaultFps(await probeSourceFps(project), [24, 25, 30, 50, 60]) ?? FALLBACK_FPS;
  const clock = usePlaybackStore.getState().durationSec;
  const [startSec, endSec] = job.range ?? [0, clock];
  if (!(endSec > startSec)) {
    throw new Error('Project has no media clock (no video/audio length); pass --range start:end');
  }
  const width = Math.max(project.composition.width - (project.composition.width % 2), 16);
  const height = Math.max(project.composition.height - (project.composition.height % 2), 16);
  const hasAudio =
    project.composition.audioSourceId !== null &&
    project.sources.filter(isFileSource).some((s) => s.id === project.composition.audioSourceId);

  await runAnimationExport({
    format: FORMAT[job.codec],
    width,
    height,
    fps,
    startSec,
    durationSec: endSec - startSec,
    outPath: job.out,
    includeAudio: hasAudio,
  });
  const done = useExportStore.getState();
  if (done.phase !== 'done') throw new Error(done.message ?? `Export ${done.phase}`);
  return { out: job.out, frames: done.totalFrames };
}

async function analyzeAudio(path: string): Promise<unknown> {
  await audioEngine.load(path);
  const { analysis, durationSec, path: loaded } = useAudioStore.getState();
  if (!analysis || loaded !== path) throw new Error(`Could not analyse ${path}`);
  const tempo = detectTempo(analysis);
  const onsets = Array.from(onsetEventTimes(analysis), (t) => Math.round(t * 1000) / 1000);
  return {
    file: path,
    durationSec,
    bpm: tempo?.bpm ?? null,
    confidence: tempo?.confidence ?? null,
    beatOffsetSec: tempo?.beatOffsetSec ?? null,
    alternativeBpm: tempo?.alternativeBpm ?? null,
    onsets,
    markers: onsets.map((timeSec, i) => ({ id: `onset-${i + 1}`, timeSec, label: 'onset' })),
  };
}

function status() {
  const s = useExportStore.getState();
  return { phase: s.phase, frame: s.progress, totalFrames: s.totalFrames, message: s.message };
}

declare global {
  interface Window {
    __materialCli?: { render: typeof render; analyzeAudio: typeof analyzeAudio; status: typeof status };
  }
}

window.__materialCli = { render, analyzeAudio, status };
