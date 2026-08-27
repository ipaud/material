import { useCallback, useRef } from 'react';
import { useUiStore } from '@/state/uiStore';

interface GutterProps {
  panel: 'library' | 'inspector' | 'timeline';
}

/** Draggable panel-resize handle. */
export function Gutter({ panel }: GutterProps) {
  const dragState = useRef<{ start: number; size: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ui = useUiStore.getState();
      const size =
        panel === 'library'
          ? ui.libraryWidth
          : panel === 'inspector'
            ? ui.inspectorWidth
            : ui.timelineHeight;
      dragState.current = { start: panel === 'timeline' ? e.clientY : e.clientX, size };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [panel],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;
      const pos = panel === 'timeline' ? e.clientY : e.clientX;
      let delta = pos - dragState.current.start;
      if (panel === 'inspector' || panel === 'timeline') delta = -delta;
      useUiStore.getState().setPanelSize(panel, dragState.current.size + delta);
    },
    [panel],
  );

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  return (
    <div
      className={`gutter ${panel === 'timeline' ? 'gutter-h' : 'gutter-v'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
