import { useCallback, useState } from 'react';
import { importMediaPaths } from '@/projects/projectActions';
import { reportError } from '@/state/uiStore';

/** Window-level drag-drop of media files. Returns drag-over state + handlers. */
export function useMediaDrop() {
  const [isDragOver, setIsDragOver] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the window/root element, not children.
    if (e.currentTarget === e.target) setIsDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    try {
      const paths = Array.from(e.dataTransfer.files)
        .map((file) => window.material.getPathForFile(file))
        .filter((p) => p.length > 0);
      if (paths.length > 0) void importMediaPaths(paths);
    } catch (err) {
      reportError('Drop media', err);
    }
  }, []);

  return { isDragOver, onDragOver, onDragLeave, onDrop };
}
