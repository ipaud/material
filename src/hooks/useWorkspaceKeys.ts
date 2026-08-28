import { useEffect } from 'react';
import { useUiStore, type WorkspaceId } from '@/state/uiStore';
import { useOutputStore } from '@/state/outputStore';

const ORDER: WorkspaceId[] = ['build', 'explore', 'perform', 'output'];

/**
 * ⌘⌥1–4 switches workspace. Meta+Alt keeps this clear of the performance
 * keys (Looks 1–9), which bail out on any modifier.
 *
 * ⌘⇧F toggles Display fullscreen. This is a safety control as much as a
 * convenience: a fullscreen output covers the whole panel, so on a
 * single-display setup the performer needs a way out that does not require
 * seeing the editor. The editor keeps keyboard focus while the output is
 * live, so this always reaches it.
 */
export function useWorkspaceKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyF') {
        const { status, mode } = useOutputStore.getState();
        if (status.state !== 'open') return;
        e.preventDefault();
        void useOutputStore
          .getState()
          .selectMode(mode === 'fullscreen' ? 'windowed' : 'fullscreen');
        return;
      }
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
