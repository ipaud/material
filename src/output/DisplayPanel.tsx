import { useEffect } from 'react';
import { useOutputStore } from '@/state/outputStore';
import { describeDisplay, type OutputMode } from '@shared/display';

/**
 * DISPLAY destination (Phase 18C).
 *
 * Sends the composition to a physical macOS display through the existing
 * Output replica — the same window 18B built, now with a target. This panel
 * only reads status and asks main to act: every native concern (enumeration,
 * bounds, fullscreen, lifecycle) belongs to the main process.
 *
 * The chosen display is machine setup, not composition: it persists in app
 * settings and never touches the project.
 */

const STATE_TEXT: Record<string, string> = {
  closed: 'READY',
  open: 'LIVE',
  error: 'OUTPUT LOST',
  'display-disconnected': 'DISPLAY DISCONNECTED',
};

export function DisplayPanel() {
  const displays = useOutputStore((s) => s.displays);
  const status = useOutputStore((s) => s.status);
  const targetId = useOutputStore((s) => s.targetDisplayId);
  const mode = useOutputStore((s) => s.mode);
  const refresh = useOutputStore((s) => s.refreshDisplays);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = status.state === 'open';
  const selected = displays.find((d) => d.id === targetId) ?? displays[0] ?? null;
  const liveDisplay = displays.find((d) => d.id === status.displayId) ?? null;

  if (displays.length === 0) {
    return (
      <aside className="output-rail output-settings" aria-label="Display output">
        <span className="label">Display</span>
        <p className="output-note">
          DISPLAY UNAVAILABLE — no monitors could be enumerated.
        </p>
        <button className="vp-btn" onClick={() => void refresh()}>
          RETRY
        </button>
      </aside>
    );
  }

  return (
    <aside className="output-rail output-settings" aria-label="Display output">
      <span className="label">Display</span>

      <div className="output-field">
        <span className="output-field-label">Target</span>
        <select
          className="select"
          aria-label="Target display"
          value={selected?.id ?? ''}
          onChange={(e) => void useOutputStore.getState().selectDisplay(Number(e.target.value))}
        >
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {describeDisplay(d)}
            </option>
          ))}
        </select>
      </div>

      <div className="output-field">
        <span className="output-field-label">Mode</span>
        <select
          className="select"
          aria-label="Display mode"
          value={mode}
          onChange={(e) => void useOutputStore.getState().selectMode(e.target.value as OutputMode)}
        >
          <option value="fullscreen">Fullscreen</option>
          <option value="windowed">Windowed</option>
        </select>
      </div>

      <div className="output-field">
        <span className="output-field-label">Status</span>
        <span className={`output-status${open ? ' live' : ''}`}>
          {STATE_TEXT[status.state] ?? 'READY'}
          {open && liveDisplay && (
            <span className="output-status-detail mono">
              {' · '}
              {status.bounds?.width ?? liveDisplay.bounds.width}×
              {status.bounds?.height ?? liveDisplay.bounds.height}
              {status.scaleFactor && status.scaleFactor !== 1 ? ` @${status.scaleFactor}×` : ''}
            </span>
          )}
        </span>
      </div>

      <div className="output-actions">
        {open ? (
          <>
            <button
              className="vp-btn"
              onClick={() =>
                void useOutputStore
                  .getState()
                  .selectMode(mode === 'fullscreen' ? 'windowed' : 'fullscreen')
              }
            >
              {mode === 'fullscreen' ? 'EXIT FULLSCREEN' : 'FULLSCREEN'}
            </button>
            <button className="vp-btn" onClick={() => void window.material.outputClose()}>
              CLOSE DISPLAY
            </button>
          </>
        ) : (
          <button
            className="vp-btn primary"
            onClick={() => void useOutputStore.getState().openDisplay()}
          >
            OPEN DISPLAY
          </button>
        )}
      </div>

      {status.state === 'display-disconnected' && (
        <p className="output-note">
          The target display was disconnected, so the output closed. Pick a display and open it
          again when you are ready.
        </p>
      )}
      {mode === 'fullscreen' && selected?.primary && displays.length === 1 && (
        <p className="output-note">
          Only one display is connected — fullscreen output will cover this screen. Press Escape on
          the output window to return to windowed.
        </p>
      )}
    </aside>
  );
}
