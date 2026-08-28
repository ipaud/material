import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { Viewport } from '@/viewport/Viewport';
import './output.css';

/**
 * OUTPUT — prepare and deliver the result.
 *
 * Phase A exposes only what v0.2 actually supports: the render preview, real
 * project output settings, and the existing export pipeline. Live destinations
 * (second display, Syphon, NDI, camera/screen input) are v0.3; they are listed
 * as disabled placeholders with no handlers so nothing can be faked.
 */
export function OutputWorkspace() {
  return (
    <div className="workspace workspace-output output">
      <OutputDestinationList />
      <OutputPreview />
      <OutputSettingsPanel />
    </div>
  );
}

export function OutputPreview() {
  return (
    <main className="viewport-area output-preview">
      <Viewport />
    </main>
  );
}

/** v0.3 expansion point: live inputs and destinations attach here. */
const FUTURE_DESTINATIONS = [
  'Fullscreen',
  'Second Display',
  'Syphon',
  'NDI',
  'Camera Input',
  'Screen Input',
];

export function OutputDestinationList() {
  return (
    <aside className="panel output-rail" aria-label="Output destinations">
      <div className="panel-header">
        <span className="label">Destination</span>
      </div>
      <div className="panel-body">
        <div className="output-dest active" aria-current="true">
          <span className="output-dest-name">File Export</span>
          <span className="output-dest-state">AVAILABLE</span>
        </div>
        <ul className="output-dest-list">
          {FUTURE_DESTINATIONS.map((name) => (
            <li key={name}>
              {/* No onClick by design — nothing behind this until v0.3. */}
              <button type="button" className="output-dest" disabled aria-disabled="true">
                <span className="output-dest-name">{name}</span>
                <span className="output-dest-state">NOT AVAILABLE · v0.3</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export function OutputSettingsPanel() {
  const composition = useProjectStore((s) => s.project.composition);
  const sources = useProjectStore((s) => s.project.sources);
  const source = sources.find((s) => s.id === composition.sourceId) ?? null;
  const audio = sources.find((s) => s.id === composition.audioSourceId) ?? null;
  const nameOf = (s: typeof source) =>
    s ? (s.metadata?.fileName ?? s.path.split('/').pop() ?? s.id) : '—';

  return (
    <aside className="panel output-settings" aria-label="Output settings">
      <div className="panel-header">
        <span className="label">Output</span>
      </div>
      <div className="panel-body">
        <Row label="Resolution" value={`${composition.width} × ${composition.height}`} />
        <Row label="Background" value={composition.background} />
        <Row label="Source" value={nameOf(source)} />
        <Row label="Audio" value={nameOf(audio)} />

        <div className="output-group-title label">Export</div>
        <Row label="Formats" value="PNG Still · PNG Sequence · H.264" />
        <Row label="Frame rate" value="24–60, set per export" />
        <button className="output-export" onClick={() => useExportStore.getState().openDialog()}>
          Export…
        </button>
      </div>
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
