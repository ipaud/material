import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { useUiStore } from '@/state/uiStore';
import { saveProject } from '@/projects/projectActions';
import { pinCurrentLook } from '@/projects/lookActions';
import { WorkspaceNav } from './WorkspaceNav';
import { MaterialMark } from '@/brand/MaterialMark';
import { iconPositionForSeed } from '@/brand/mark';

export function TitleBar() {
  const name = useProjectStore((s) => s.project.name);
  const dirty = useProjectStore((s) => s.dirty);
  const seed = useProjectStore((s) => s.project.explore.lastSeed ?? 1);

  return (
    <header className="titlebar">
      <MaterialMark position={iconPositionForSeed(seed)} />
      <span className="titlebar-brand">MATERIAL</span>
      {dirty && (
        <span className="titlebar-dirty" title="Unsaved changes" aria-label="Unsaved changes">
          ●
        </span>
      )}
      <WorkspaceNav />
      <span className="titlebar-spacer" />
      <span className="titlebar-project mono">{name}</span>
      <button
        className="titlebar-action"
        onClick={() => useUiStore.getState().toggleShortcuts()}
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>
      <button
        className="titlebar-action"
        onClick={() => pinCurrentLook()}
        title="Pin current look (instant snapshot)"
      >
        Pin
      </button>
      <button className="titlebar-action" onClick={() => void saveProject()}>
        Save
      </button>
      <button
        className="titlebar-action primary"
        onClick={() => useExportStore.getState().openDialog()}
      >
        Export
      </button>
    </header>
  );
}
