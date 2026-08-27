import { useUiStore, type WorkspaceId } from '@/state/uiStore';

const TABS: { id: WorkspaceId; label: string; available: boolean }[] = [
  { id: 'create', label: 'CREATE', available: true },
  { id: 'explore', label: 'EXPLORE', available: true },
  { id: 'techniques', label: 'TECHNIQUES', available: false },
  { id: 'modulation', label: 'MODULATION', available: false },
  { id: 'performance', label: 'PERFORMANCE', available: false },
];

export function WorkspaceTabs() {
  const workspace = useUiStore((s) => s.workspace);
  const setWorkspace = useUiStore((s) => s.setWorkspace);

  return (
    <nav className="workspace-tabs" aria-label="Workspaces">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`workspace-tab${workspace === tab.id ? ' active' : ''}`}
          disabled={!tab.available}
          title={tab.available ? undefined : 'Not available yet'}
          onClick={() => setWorkspace(tab.id)}
        >
          {tab.label}
          {!tab.available && <span className="tab-badge">SOON</span>}
        </button>
      ))}
    </nav>
  );
}
