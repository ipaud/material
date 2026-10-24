import { openProjectFromPath } from '@/projects/projectActions';
import { reportError, useUiStore } from '@/state/uiStore';
import { basename } from '@/utils/platform';

const MAX_LISTED = 50;

/** Persistent (not a toast): a file that will not open needs a decision, not a glance. */
export function ProjectRepairDialog() {
  const pending = useUiStore((s) => s.pendingRepair);
  const setPending = useUiStore((s) => s.setPendingRepair);
  if (!pending) return null;

  const { issues, repairable, path } = pending;
  const listed = issues.slice(0, MAX_LISTED);
  const name = basename(path);

  const repair = () => {
    openProjectFromPath(path, true).catch((err: unknown) => reportError('Repair project', err));
  };

  return (
    <div className="export-overlay">
      <div
        className="export-dialog recovery-dialog"
        role="alertdialog"
        aria-label="Project cannot be opened"
        aria-describedby="repair-text"
      >
        <div className="export-header">
          <span className="label">Project Cannot Be Opened</span>
        </div>
        <p className="recovery-text" id="repair-text">
          {name} has {issues.length} invalid value{issues.length === 1 ? '' : 's'}. Your current
          project is untouched.
        </p>
        <ul className="repair-issues mono">
          {listed.map((issue, i) => (
            <li key={`${issue.path}:${i}`}>{issue.text}</li>
          ))}
          {issues.length > listed.length && <li>…and {issues.length - listed.length} more</li>}
        </ul>
        <p className="recovery-note">
          {repairable
            ? 'Repair clamps each value to its allowed range. The file on disk is untouched until you save.'
            : 'These problems cannot be fixed automatically.'}
        </p>
        <div className="export-actions recovery-actions">
          <button className="titlebar-action" autoFocus onClick={() => setPending(null)}>
            Cancel
          </button>
          {repairable && (
            <button className="titlebar-action primary" onClick={repair}>
              Repair and open
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
