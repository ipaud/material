import { useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useUiStore } from '@/state/uiStore';
import { useOutputStore } from '@/state/outputStore';
import { DisplayPanel } from './DisplayPanel';
import { Viewport } from '@/viewport/Viewport';
import { WorkspaceEmpty } from '@/components/WorkspaceEmpty';
import './output.css';

/**
 * OUTPUT — what MATERIAL is producing, where it can go, how it is delivered.
 *
 * v0.2 reality: the editor preview (the one live engine) and file export
 * through the existing ExportDialog. Live destinations are v0.3 and appear
 * only as disabled roadmap rows. Camera/screen capture are SOURCES, not
 * destinations — they belong to BUILD in v0.3 and are not listed here.
 *
 * v0.3 expansion points: add a destination to DESTINATIONS (left rail) and
 * its surface to the preview pane; the workspace shell does not change.
 */

type DestinationId = 'editor' | 'display' | 'file';

export function OutputWorkspace() {
  const hasSource = useProjectStore((s) => s.project.composition.sourceId !== null);
  const [selected, setSelected] = useState<DestinationId>('editor');

  return (
    <div className="workspace workspace-output">
      <div className="output-main">
        <OutputDestinations selected={selected} onSelect={setSelected} />
        <OutputPreviewPane hasSource={hasSource} />
        {selected === 'display' ? <DisplayPanel /> : <OutputSettings />}
      </div>
      <OutputExportBar hasSource={hasSource} emphasized={selected === 'file'} />
    </div>
  );
}

// ---- Destinations ------------------------------------------------------

const FUTURE_LIVE = [
  { name: 'SECOND DISPLAY', hint: 'Simultaneous output to two displays is a later phase.' },
];
const FUTURE_INTEROP = [
  { name: 'SYPHON', hint: 'Syphon interop is under research — not committed to v0.3.' },
];

export function OutputDestinations({
  selected,
  onSelect,
}: {
  selected: DestinationId;
  onSelect: (id: DestinationId) => void;
}) {
  return (
    <aside className="output-rail" aria-label="Output destinations">
      <span className="output-rail-head">DESTINATIONS</span>
      <button
        className={`output-dest${selected === 'editor' ? ' selected' : ''}`}
        aria-current={selected === 'editor' ? 'true' : undefined}
        onClick={() => onSelect('editor')}
      >
        <span className="output-dest-dot live" aria-hidden="true" />
        <span className="output-dest-text">
          <span className="output-dest-name">EDITOR PREVIEW</span>
          <span className="output-dest-state">ACTIVE</span>
        </span>
      </button>
      <button
        className={`output-dest${selected === 'file' ? ' selected' : ''}`}
        aria-current={selected === 'file' ? 'true' : undefined}
        onClick={() => onSelect('file')}
      >
        <span className="output-dest-dot" aria-hidden="true" />
        <span className="output-dest-text">
          <span className="output-dest-name">FILE EXPORT</span>
          <span className="output-dest-state">ON DEMAND</span>
        </span>
      </button>

      <DisplayRow selected={selected === 'display'} onSelect={() => onSelect('display')} />

      <span className="output-rail-head future">LIVE OUTPUT — LATER</span>
      {FUTURE_LIVE.map((d) => (
        <FutureRow key={d.name} name={d.name} state="NOT AVAILABLE · v0.3" hint={d.hint} />
      ))}

      <span className="output-rail-head future">INTEROP — FUTURE</span>
      {FUTURE_INTEROP.map((d) => (
        <FutureRow key={d.name} name={d.name} state="RESEARCH" hint={d.hint} />
      ))}
    </aside>
  );
}

function DisplayRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  const status = useOutputStore((s) => s.status);
  const open = status.state === 'open';
  const state =
    status.state === 'open'
      ? status.mode === 'fullscreen'
        ? 'LIVE · FULLSCREEN'
        : 'LIVE · WINDOWED'
      : status.state === 'display-disconnected'
        ? 'DISCONNECTED'
        : status.state === 'error'
          ? 'OUTPUT LOST'
          : 'READY';
  return (
    <button
      className={`output-dest${selected ? ' selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      title="Send the composition to a physical display"
    >
      <span className={`output-dest-dot${open ? ' live' : ''}`} aria-hidden="true" />
      <span className="output-dest-text">
        <span className="output-dest-name">DISPLAY</span>
        <span className="output-dest-state">{state}</span>
      </span>
    </button>
  );
}

function FutureRow({ name, state, hint }: { name: string; state: string; hint: string }) {
  return (
    // No onClick by design — nothing exists behind these until v0.3.
    <button type="button" className="output-dest future" disabled aria-disabled="true" title={hint}>
      <span className="output-dest-dot" aria-hidden="true" />
      <span className="output-dest-text">
        <span className="output-dest-name">{name}</span>
        <span className="output-dest-state">{state}</span>
      </span>
    </button>
  );
}

// ---- Preview -----------------------------------------------------------

export function OutputPreviewPane({ hasSource }: { hasSource: boolean }) {
  const composition = useProjectStore((s) => s.project.composition);
  const offline = useUiStore((s) => s.offlineSources);
  const sourceOffline = composition.sourceId !== null && offline.includes(composition.sourceId);

  if (!hasSource) {
    return (
      <main className="output-stage empty" aria-label="Output preview">
        <WorkspaceEmpty title="NOTHING TO OUTPUT" hint="Import media and build a system first" />
      </main>
    );
  }

  return (
    <main className="output-stage" aria-label="Output preview">
      <div className="output-stage-head">
        <span className="output-stage-title">OUTPUT PREVIEW</span>
        <span className="output-stage-dims mono">
          {composition.width} × {composition.height}
        </span>
        <span className="output-stage-spacer" />
        {sourceOffline && <span className="output-offline mono">MEDIA OFFLINE</span>}
      </div>
      <div className="output-stage-well">
        <Viewport />
      </div>
    </main>
  );
}

// ---- Settings ----------------------------------------------------------

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

export function OutputSettings() {
  const project = useProjectStore((s) => s.project);
  const durationSec = usePlaybackStore((s) => s.durationSec);
  const { composition } = project;
  const source = project.sources.find((s) => s.id === composition.sourceId) ?? null;
  const audio = project.sources.find((s) => s.id === composition.audioSourceId) ?? null;
  const bpm = project.timeline.bpm;

  const sourceDims =
    source?.metadata?.width && source.metadata.height
      ? `${source.metadata.width} × ${source.metadata.height}`
      : null;
  const projectDims = `${composition.width} × ${composition.height}`;

  return (
    <aside className="output-rail output-settings" aria-label="Output settings">
      <span className="output-rail-head">PROJECT</span>
      <Row label="RESOLUTION" value={projectDims} />
      {sourceDims && sourceDims !== projectDims && <Row label="SOURCE RES" value={sourceDims} />}
      <Row label="BACKGROUND" value={composition.background.toUpperCase()} />
      {durationSec > 0 && <Row label="DURATION" value={formatDuration(durationSec)} />}

      <span className="output-rail-head">SOURCE</span>
      <Row
        label={source ? source.kind.toUpperCase() : 'SOURCE'}
        value={source ? (source.metadata?.fileName ?? source.path.split('/').pop() ?? '—') : 'NONE'}
      />
      {source?.metadata?.frameRate != null && (
        <Row label="SOURCE FPS" value={source.metadata.frameRate.toFixed(2)} />
      )}

      <span className="output-rail-head">AUDIO</span>
      {audio ? (
        <>
          <Row
            label="FILE"
            value={audio.metadata?.fileName ?? audio.path.split('/').pop() ?? '—'}
          />
          {bpm != null && <Row label="BPM" value={String(bpm)} />}
        </>
      ) : (
        <Row label="AUDIO" value="NONE" />
      )}

      {/* Resolution/FPS/format live in the ExportDialog per export — one
          source of truth, no second settings state that could diverge. */}
      <span className="output-rail-head">EXPORT DEFAULT</span>
      <Row label="FORMAT" value="H.264" />
      <Row label="FPS" value="30 · SET PER EXPORT" />
      <Row label="ALPHA" value="PNG SEQ / PRORES 4444" />
      <button
        className="output-configure"
        onClick={() => useExportStore.getState().openDialog()}
        title="Resolution, frame rate, format and range are configured per export"
      >
        CONFIGURE EXPORT
      </button>

      <OutputStatus />
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="output-row">
      <span className="output-row-label">{label}</span>
      <span className="output-row-value mono">{value}</span>
    </div>
  );
}

// ---- Status ------------------------------------------------------------

export function OutputStatus() {
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  const totalFrames = useExportStore((s) => s.totalFrames);
  const message = useExportStore((s) => s.message);

  return (
    <>
      <span className="output-rail-head">STATUS</span>
      {phase === 'running' ? (
        <>
          <Row
            label="RENDERING"
            value={totalFrames > 0 ? `${Math.round((progress / totalFrames) * 100)}%` : '…'}
          />
          <Row label="FRAME" value={`${progress} / ${totalFrames}`} />
        </>
      ) : phase === 'done' ? (
        <Row label="COMPLETE" value={message ?? 'EXPORTED'} />
      ) : phase === 'error' ? (
        <Row label="ERROR" value={message ?? 'EXPORT FAILED'} />
      ) : phase === 'cancelled' ? (
        <Row label="CANCELLED" value="—" />
      ) : (
        <Row label="IDLE" value="READY" />
      )}
    </>
  );
}

// ---- Export bar --------------------------------------------------------

export function OutputExportBar({
  hasSource,
  emphasized,
}: {
  hasSource: boolean;
  emphasized: boolean;
}) {
  const name = useProjectStore((s) => s.project.name);
  const composition = useProjectStore((s) => s.project.composition);
  const durationSec = usePlaybackStore((s) => s.durationSec);

  return (
    <div className={`output-bar${emphasized ? ' emphasized' : ''}`}>
      <span className="output-bar-label">FILE EXPORT</span>
      <span className="output-bar-value mono">{name}</span>
      <span className="output-bar-sep" />
      <span className="output-bar-value mono">
        {composition.width} × {composition.height}
      </span>
      {durationSec > 0 && (
        <>
          <span className="output-bar-sep" />
          <span className="output-bar-value mono">{formatDuration(durationSec)}</span>
        </>
      )}
      <span className="output-bar-note">
        Export renders committed project state deterministically
      </span>
      <span className="output-bar-spacer" />
      {!hasSource && <span className="output-bar-reason mono">NO MEDIA</span>}
      <button
        className="output-export"
        disabled={!hasSource}
        onClick={() => useExportStore.getState().openDialog()}
        aria-label="Export (opens export settings)"
      >
        EXPORT
      </button>
    </div>
  );
}
