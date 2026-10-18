import { useEffect, useMemo, useState } from 'react';
import { useExportStore } from '@/state/exportStore';
import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { isLiveSource } from '@shared/schemas/project';
import { usePlaybackStore } from '@/state/playbackStore';
import { exportPngStill } from './exportStill';
import { runAnimationExport } from './exportRunner';
import type { ExportFormat } from '@shared/ipc';
import {
  defaultFps,
  loadExportSettings,
  probeSourceFps,
  saveExportSettings,
  type ExportSettings,
} from './exportSettings';
import './export.css';

type DialogFormat = 'png-still' | ExportFormat;

const RESOLUTIONS = [
  { id: 'source', label: 'Source' },
  { id: '1080', label: '1920 × 1080' },
  { id: '2160', label: '3840 × 2160' },
] as const;

const FPS_OPTIONS = [24, 25, 30, 50, 60];

export function ExportDialog() {
  const dialogOpen = useExportStore((s) => s.dialogOpen);
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  const totalFrames = useExportStore((s) => s.totalFrames);
  const message = useExportStore((s) => s.message);
  const closeDialog = useExportStore((s) => s.closeDialog);
  const requestCancel = useExportStore((s) => s.requestCancel);

  const project = useProjectStore((s) => s.project);
  const timelineDuration = usePlaybackStore((s) => s.durationSec);

  const [format, setFormat] = useState<DialogFormat>('h264');
  const [resolution, setResolution] = useState<string>('source');
  const [fps, setFps] = useState(30);
  const [sourceFps, setSourceFps] = useState<number | null>(null);
  const [rangeMode, setRangeMode] = useState<'full' | 'custom'>('full');
  const [startSec, setStartSec] = useState(0);
  const [durationInput, setDurationInput] = useState<number | null>(null);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [alpha, setAlpha] = useState(false);
  const [encoders, setEncoders] = useState<string[]>([]);

  useEffect(() => {
    void window.material.getAppInfo().then((info) => setEncoders(info.availableEncoders));
  }, []);

  const projectPath = useProjectStore((s) => s.projectPath);
  const settingsKey = projectPath ?? `unsaved:${project.name}`;
  const activeSourceId = project.composition.sourceId;

  // Probe the source's frame rate once per open: the default must match the
  // footage, not a fixed 30 that would silently resample 25 fps material.
  useEffect(() => {
    if (!dialogOpen) return;
    let cancelled = false;
    const probe = probeSourceFps(useProjectStore.getState().project);
    void probe.then((rate) => {
        if (cancelled) return;
        setSourceFps(rate);
        const saved = loadExportSettings(settingsKey);
        if (saved) {
          setFormat(saved.format);
          setResolution(saved.resolution);
          setFps(saved.fps);
          setIncludeAudio(saved.includeAudio);
          setAlpha(saved.alpha);
        } else {
          setFps(defaultFps(rate, FPS_OPTIONS));
        }
      });
    return () => {
      cancelled = true;
    };
    // project.sources is deliberately not a dependency: re-probing mid-dialog would clobber edits.
  }, [dialogOpen, settingsKey, activeSourceId]);

  // "Saved" is news, not a decision: close the dialog and toast with a Finder shortcut.
  useEffect(() => {
    if (!dialogOpen || phase !== 'done' || !message) return;
    const file = message;
    closeDialog();
    useUiStore.getState().pushToast('info', `Saved ${file.split('/').pop() ?? file}`, {
      label: 'Show in Finder',
      run: () => void window.material.showInFinder(file),
    });
  }, [dialogOpen, phase, message, closeDialog]);

  // The footage's own rate (23.976, 29.97…) and any remembered rate stay selectable.
  const fpsChoices = useMemo(
    () =>
      [...new Set([...FPS_OPTIONS, ...(sourceFps ? [defaultFps(sourceFps, FPS_OPTIONS)] : []), fps])].sort(
        (a, b) => a - b,
      ),
    [sourceFps, fps],
  );

  const { width, height } = useMemo(() => {
    if (resolution === '1080') return { width: 1920, height: 1080 };
    if (resolution === '2160') return { width: 3840, height: 2160 };
    // Source, forced even for encoder friendliness.
    const w = project.composition.width - (project.composition.width % 2);
    const h = project.composition.height - (project.composition.height % 2);
    return { width: Math.max(w, 16), height: Math.max(h, 16) };
  }, [resolution, project.composition.width, project.composition.height]);

  if (!dialogOpen) return null;

  // No media clock (generator-only project, or a video that failed to load): say
  // so instead of presenting the 5 s placeholder as the real length.
  const hasClock = timelineDuration > 0;
  const fullDuration = hasClock ? timelineDuration : 5;
  const effectiveStart = rangeMode === 'full' ? 0 : startSec;
  const effectiveDuration =
    rangeMode === 'full' ? fullDuration : (durationInput ?? Math.max(fullDuration - startSec, 1));
  const estimatedFrames = Math.ceil(effectiveDuration * fps);
  const running = phase === 'running';
  const hasAudio = project.composition.audioSourceId !== null;
  // 18D: a live camera is not seekable or deterministic — offline
  // sequence/movie export is impossible by capability, not by policy. A
  // still capture of "now" stays honest and allowed.
  const activeSource = project.sources.find((s) => s.id === project.composition.sourceId) ?? null;
  const liveSource = activeSource !== null && isLiveSource(activeSource);
  const liveBlocked = liveSource && format !== 'png-still';
  const hasProRes = encoders.includes('prores_ks');
  const supportsAlpha = format === 'prores4444' || format === 'png-sequence';

  const startExport = async () => {
    if (liveBlocked) return;
    if (format === 'png-still') {
      closeDialog();
      await exportPngStill();
      return;
    }
    const outPath = await window.material.exportSaveDialog(format, project.name || 'material');
    if (!outPath) return;
    saveExportSettings(settingsKey, {
      format,
      resolution: resolution as ExportSettings['resolution'],
      fps,
      includeAudio,
      alpha,
    });
    void runAnimationExport({
      format,
      width,
      height,
      fps,
      startSec: effectiveStart,
      durationSec: effectiveDuration,
      outPath,
      includeAudio: includeAudio && hasAudio,
      alpha: alpha && supportsAlpha,
    });
  };

  return (
    <div className="export-overlay" onClick={running ? undefined : closeDialog}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-header">
          <span className="label">Export</span>
          {!running && (
            <button className="vp-btn" onClick={closeDialog}>
              ✕
            </button>
          )}
        </div>

        {!running && phase !== 'done' && (
          <>
            <div className="export-field">
              <span className="param-label">Format</span>
              <select
                className="select"
                value={format}
                onChange={(e) => setFormat(e.target.value as DialogFormat)}
              >
                <option value="png-still">PNG Still</option>
                <option value="png-sequence">PNG Sequence (alpha)</option>
                <option value="h264">H.264 MP4</option>
                {/* Only offered when this machine's FFmpeg can actually encode it. */}
                {hasProRes && <option value="prores422">ProRes 422 HQ</option>}
                {hasProRes && <option value="prores4444">ProRes 4444 (alpha)</option>}
              </select>
            </div>
            <div className="export-field">
              <span className="param-label">Resolution</span>
              <select className="select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                {RESOLUTIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id === 'source'
                      ? `Source (${project.composition.width}×${project.composition.height})`
                      : r.label}
                  </option>
                ))}
              </select>
            </div>
            {format !== 'png-still' && (
              <>
                <div className="export-field">
                  <span className="param-label">Frame Rate</span>
                  <select className="select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                    {fpsChoices.map((f) => (
                      <option key={f} value={f}>
                        {f} fps
                      </option>
                    ))}
                  </select>
                </div>
                <div className="export-field">
                  <span className="param-label">Range</span>
                  <select
                    className="select"
                    value={rangeMode}
                    onChange={(e) => setRangeMode(e.target.value as 'full' | 'custom')}
                  >
                    <option value="full">
                      {hasClock
                        ? `Full (${fullDuration.toFixed(1)}s)`
                        : `Default (${fullDuration.toFixed(1)}s — no media clock)`}
                    </option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                {rangeMode === 'custom' && (
                  <div className="export-field">
                    <span className="param-label">Start / Dur</span>
                    <div className="export-range-inputs">
                      <input
                        className="timeline-num mono"
                        type="number"
                        min={0}
                        step={0.1}
                        value={startSec}
                        onChange={(e) => setStartSec(Math.max(Number(e.target.value) || 0, 0))}
                      />
                      <input
                        className="timeline-num mono"
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={durationInput ?? ''}
                        placeholder={(fullDuration - startSec).toFixed(1)}
                        onChange={(e) =>
                          setDurationInput(e.target.value === '' ? null : Math.max(Number(e.target.value), 0.1))
                        }
                      />
                    </div>
                  </div>
                )}
                {format !== 'png-sequence' && hasAudio && (
                  <div className="export-field">
                    <span className="param-label">Audio</span>
                    <button
                      className={`toggle${includeAudio ? ' on' : ''}`}
                      role="switch"
                      aria-checked={includeAudio}
                      aria-label="Include audio"
                      onClick={() => setIncludeAudio(!includeAudio)}
                    />
                  </div>
                )}
                {supportsAlpha && (
                  <div className="export-field">
                    <span className="param-label">Alpha</span>
                    <button
                      className={`toggle${alpha ? ' on' : ''}`}
                      role="switch"
                      aria-checked={alpha}
                      aria-label="Transparent background"
                      onClick={() => setAlpha(!alpha)}
                    />
                  </div>
                )}
                <div className="export-summary mono">
                  {width}×{height} · {fps} fps · ~{estimatedFrames} frames
                </div>
              </>
            )}
            <div className="export-actions">
              {liveBlocked && (
                <span className="export-live-note">
                  LIVE SOURCE — sequence/movie export unavailable. Still export captures now.
                </span>
              )}
              <button
                className="titlebar-action primary"
                disabled={liveBlocked}
                onClick={() => void startExport()}
              >
                Export…
              </button>
            </div>
          </>
        )}

        {running && (
          <div className="export-progress">
            <div className="export-progress-bar">
              <div
                className="export-progress-fill"
                style={{ width: `${totalFrames > 0 ? (progress / totalFrames) * 100 : 0}%` }}
              />
            </div>
            <span className="mono">
              {progress} / {totalFrames} frames
            </span>
            <button className="titlebar-action" onClick={requestCancel}>
              Cancel
            </button>
          </div>
        )}

        {!running && (phase === 'done' || phase === 'error' || phase === 'cancelled') && (
          <div className="export-result">
            <span className={phase === 'error' ? 'export-error' : ''}>
              {phase === 'done' ? `Saved: ${message}` : (message ?? phase)}
            </span>
            <button className="titlebar-action" onClick={closeDialog}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
