import { useProjectStore } from '@/state/projectStore';
import { saveProject } from '@/projects/projectActions';
import { useUiStore } from '@/state/uiStore';

export function TitleBar() {
  const name = useProjectStore((s) => s.project.name);
  const dirty = useProjectStore((s) => s.dirty);
  const pushToast = useUiStore((s) => s.pushToast);

  return (
    <header className="titlebar">
      <span className="titlebar-brand">MATERIAL</span>
      <span className="titlebar-project">
        {name}
        {dirty && <span className="titlebar-dirty"> ●</span>}
      </span>
      <span className="titlebar-spacer" />
      <button className="titlebar-action" onClick={() => void saveProject()}>
        Save
      </button>
      <button
        className="titlebar-action primary"
        onClick={() => pushToast('info', 'Export is not available yet')}
      >
        Export
      </button>
    </header>
  );
}
