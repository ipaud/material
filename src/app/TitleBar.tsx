import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { saveProject } from '@/projects/projectActions';
import { pinCurrentLook } from '@/projects/lookActions';

export function TitleBar() {
  const name = useProjectStore((s) => s.project.name);
  const dirty = useProjectStore((s) => s.dirty);

  return (
    <header className="titlebar">
      <span className="titlebar-brand">MATERIAL</span>
      <span className="titlebar-project">
        {name}
        {dirty && <span className="titlebar-dirty"> ●</span>}
      </span>
      <span className="titlebar-spacer" />
      <button className="titlebar-action" onClick={() => pinCurrentLook()} title="Pin current look (instant snapshot)">
        ◆ Pin
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
