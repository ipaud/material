import { useEffect, useState } from 'react';
import { discardRecovery, pendingRecoveries, restoreRecovery } from '@/projects/autosave';
import { useUiStore } from '@/state/uiStore';
import type { RecoveryEntry } from '@shared/ipc';
import { basename } from '@/utils/platform';

function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleString();
}

export function RecoveryPrompt() {
  const [entries, setEntries] = useState<RecoveryEntry[]>([]);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    void pendingRecoveries().then(setEntries);
  }, []);

  if (entries.length === 0) return null;
  const entry = entries[0];
  if (!entry) return null;

  const dismiss = async (discard: boolean) => {
    if (discard) await discardRecovery(entry);
    setEntries((prev) => prev.slice(1));
  };

  return (
    <div className="export-overlay">
      <div
        className="export-dialog recovery-dialog"
        role="alertdialog"
        aria-label="Recovery available"
      >
        <div className="export-header">
          <span className="label">Recovery Available</span>
        </div>
        <p className="recovery-text">MATERIAL closed unexpectedly. An autosave is available.</p>
        <div className="recovery-facts">
          <div className="recovery-fact">
            <span className="recovery-fact-label">PROJECT</span>
            <span className="recovery-fact-value mono">{entry.project.name || 'Untitled'}</span>
          </div>
          <div className="recovery-fact">
            <span className="recovery-fact-label">SAVED</span>
            <span className="recovery-fact-value mono">{relativeTime(entry.savedAt)}</span>
          </div>
          <div className="recovery-fact">
            <span className="recovery-fact-label">ON DISK</span>
            <span className="recovery-fact-value mono">
              {entry.projectPath ? (basename(entry.projectPath) || '—') : 'NEVER SAVED'}
            </span>
          </div>
        </div>
        <p className="recovery-note">
          {entry.projectPath
            ? 'Recovering loads it into the editor only — the file on disk is untouched until you save.'
            : 'Recovering loads it into the editor; use Save As to keep it.'}
        </p>
        <div className="export-actions recovery-actions">
          <button className="titlebar-action" onClick={() => void dismiss(true)}>
            Discard
          </button>
          <button className="titlebar-action" onClick={() => void dismiss(false)}>
            Ignore for now
          </button>
          <button
            className="titlebar-action primary"
            onClick={() => {
              restoreRecovery(entry);
              pushToast('info', 'Project recovered — save to keep the changes');
              void dismiss(true);
            }}
          >
            Recover
          </button>
        </div>
      </div>
    </div>
  );
}
