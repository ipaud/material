import { useEffect } from 'react';
import { useUiStore, type WorkspaceId } from '@/state/uiStore';

const ORDER: WorkspaceId[] = ['build', 'explore', 'perform', 'output'];

/**
 * ⌘⌥1–4 switches workspace. Meta+Alt keeps this clear of the performance
 * keys (Looks 1–9), which bail out on any modifier.
 */
export function useWorkspaceKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
      if (!e.code.startsWith('Digit')) return;
      const index = Number(e.code.slice(5)) - 1;
      const target = ORDER[index];
      if (!target) return;
      e.preventDefault();
      useUiStore.getState().setWorkspace(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
