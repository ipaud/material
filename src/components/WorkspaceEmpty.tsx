import { useUiStore } from '@/state/uiStore';

/**
 * Shared "nothing here yet" state for workspaces that need a built system
 * (EXPLORE / PLAY / OUTPUT). One voice: short, technical, GO TO BUILD.
 */
export function WorkspaceEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="ws-none">
      <span className="ws-none-title">{title}</span>
      <span className="ws-none-hint">{hint}</span>
      <button className="ws-none-goto" onClick={() => useUiStore.getState().setWorkspace('build')}>
        GO TO BUILD
      </button>
    </div>
  );
}
