import { useState } from 'react';
import { retryMediaPath } from '@/rendering/engineBridge';
import { setProxy } from '@/sources/mediaProxy';
import { reportError, useUiStore } from '@/state/uiStore';

/** Offered when the viewer cannot decode a video (ProRes and friends). */
export function MediaProxyDialog() {
  const pending = useUiStore((s) => s.pendingProxy);
  const setPending = useUiStore((s) => s.setPendingProxy);
  const pushToast = useUiStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  if (!pending) return null;

  const name = pending.path.split('/').pop() ?? pending.path;

  const make = async () => {
    setBusy(true);
    try {
      const proxy = await window.material.createProxy(pending.path);
      setProxy(pending.path, proxy);
      setPending(null);
      retryMediaPath(pending.path);
      pushToast('info', `Proxy ready for ${name}`);
    } catch (err) {
      reportError('Make proxy', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-overlay">
      <div
        className="export-dialog recovery-dialog"
        role="alertdialog"
        aria-label="Video cannot be played"
        aria-describedby="proxy-text"
      >
        <div className="export-header">
          <span className="label">Video Cannot Be Played</span>
        </div>
        <p className="recovery-text" id="proxy-text">
          {name}
          {pending.codec ? ` (${pending.codec})` : ''} is not a format the viewer can decode.
        </p>
        <p className="recovery-note">
          MATERIAL can make a high-quality H.264 proxy (all-intra, CRF 14) and use it for the
          viewer and the export. Your original is not modified. Long clips take a few minutes.
        </p>
        <div className="export-actions recovery-actions">
          <button
            className="titlebar-action"
            disabled={busy}
            autoFocus
            onClick={() => setPending(null)}
          >
            Skip
          </button>
          <button className="titlebar-action primary" disabled={busy} onClick={() => void make()}>
            {busy ? 'Making proxy…' : 'Make H.264 proxy'}
          </button>
        </div>
      </div>
    </div>
  );
}
