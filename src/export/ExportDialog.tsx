import { useMemo, useState } from 'react';
import { useExportStore } from '@/state/exportStore';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { exportPngStill } from './exportStill';
import { runAnimationExport } from './exportRunner';
import type { ExportFormat } from '@shared/ipc';
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
  const [rangeMode, setRangeMode] = useState<'full' | 'custom'>('full');
  const [startSec, setStartSec] = useState(0);
  const [durationInput, setDurationInput] = useState<number | null>(null);
  const [includeAudio, setIncludeAudio] = useState(true);

  const { width, height } = useMemo(() => {
    if (resolution === '1080') return { width: 1920, height: 1080 };
    if (resolution === '2160') return { width: 3840, height: 2160 };
    // Source, forced even for encoder friendliness.
    const w = project.composition.width - (project.composition.width % 2);
    const h = project.composition.height - (project.composition.height % 2);
    return { width: Math.max(w, 16), height: Math.max(h, 16) };
  }, [resolution, project.composition.width, project.composition.height]);

  if (!dialogOpen) return null;

  const fullDuration = timelineDuration > 0 ? timelineDuration : 5;
  const effectiveStart = rangeMode === 'full' ? 0 : startSec;
  const effectiveDuration =
    rangeMode === 'full' ? fullDuration : (durationInput ?? Math.max(fullDuration - startSec, 1));
  const estimatedFrames = Math.ceil(effectiveDuration * fps);
  const running = phase === 'running';
  const hasAudio = project.composition.audioSourceId !== null;

  const startExport = async () => {
    if (format === 'png-still') {
      closeDialog();
      await exportPngStill();
      return;
    }
    const outPath = await window.material.exportSaveDialog(format, project.name || 'material');
    if (!outPath) return;
    void runAnimationExport({
      format,
      width,
      height,
      fps,
      startSec: effectiveStart,
      durationSec: effectiveDuration,
      outPath,
      includeAudio: includeAudio && hasAudio,
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
              <select className="select" value={format} onChange={(e) => setFormat(e.target.value as DialogFormat)}>
                <option value="png-still">PNG Still</option>
                <option value="png-sequence">PNG Sequence</option>
                <option value="h264">H.264 MP4</option>
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
                    {FPS_OPTIONS.map((f) => (
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
                    <option value="full">Full ({fullDuration.toFixed(1)}s)</option>
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
                {format === 'h264' && hasAudio && (
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
                <div className="export-summary mono">
                  {width}×{height} · {fps} fps · ~{estimatedFrames} frames
                </div>
              </>
            )}
            <div className="export-actions">
              <button className="titlebar-action primary" onClick={() => void startExport()}>
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
