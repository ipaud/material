import { useUiStore, type WorkspaceId } from '@/state/uiStore';

const WORKSPACES: { id: WorkspaceId; label: string }[] = [
  { id: 'build', label: 'BUILD' },
  { id: 'explore', label: 'EXPLORE' },
  { id: 'perform', label: 'PLAY' },
  { id: 'output', label: 'OUTPUT' },
];

export function WorkspaceNav() {
  const workspace = useUiStore((s) => s.workspace);
  const setWorkspace = useUiStore((s) => s.setWorkspace);

  return (
    <nav className="workspace-nav" aria-label="Workspaces">
      {WORKSPACES.map((w) => {
        const active = workspace === w.id;
        return (
          <button
            key={w.id}
            type="button"
            className={`workspace-nav-item${active ? ' active' : ''}`}
            // State is not colour-only: assistive tech reads the current page.
            aria-current={active ? 'page' : undefined}
            onClick={() => setWorkspace(w.id)}
          >
            {w.label}
          </button>
        );
      })}
    </nav>
  );
}
