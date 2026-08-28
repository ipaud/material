import { useEffect } from 'react';
import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { useMenuEvents } from '@/hooks/useMenuEvents';
import { useMediaDrop } from '@/hooks/useMediaDrop';
import { TitleBar } from './TitleBar';
import { WorkspaceTabs } from './WorkspaceTabs';
import { Toasts } from './Toasts';
import { Gutter } from '@/components/Gutter';
import { EmptyState } from '@/components/EmptyState';
import { LibraryPanel } from '@/library/LibraryPanel';
import { Viewport } from '@/viewport/Viewport';
import { ExplorePanel } from '@/explore/ExplorePanel';
import { ExportDialog } from '@/export/ExportDialog';
import { RecoveryPrompt } from './RecoveryPrompt';
import { TechniquesBrowser } from '@/techniques/TechniquesBrowser';
import { startAutosave } from '@/projects/autosave';
import { usePerformanceKeys } from '@/hooks/usePerformanceKeys';
import { InspectorPanel } from '@/inspector/InspectorPanel';
import { TimelinePanel } from '@/timeline/TimelinePanel';
import './app.css';

export function App() {
  useMenuEvents();
  usePerformanceKeys();
  useEffect(() => startAutosave(), []);
  const { isDragOver, onDragOver, onDragLeave, onDrop } = useMediaDrop();
  const libraryWidth = useUiStore((s) => s.libraryWidth);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const timelineHeight = useUiStore((s) => s.timelineHeight);
  const hasSources = useProjectStore((s) => s.project.sources.length > 0);
  const workspace = useUiStore((s) => s.workspace);

  return (
    <div className="app" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <TitleBar />
      <div className="main-row">
        <aside className="panel panel-left" style={{ width: libraryWidth }}>
          <LibraryPanel />
        </aside>
        <Gutter panel="library" />
        <main className="viewport-area">
          <Viewport />
          {workspace === 'explore' && <ExplorePanel />}
          {workspace === 'techniques' && <TechniquesBrowser />}
          {!hasSources && <EmptyState isDragOver={isDragOver} />}
          {isDragOver && <div className="drop-overlay" />}
        </main>
        <Gutter panel="inspector" />
        <aside className="panel panel-right" style={{ width: inspectorWidth }}>
          <InspectorPanel />
        </aside>
      </div>
      <Gutter panel="timeline" />
      <div className="timeline-strip" style={{ height: timelineHeight }}>
        <TimelinePanel />
      </div>
      <WorkspaceTabs />
      <Toasts />
      <ExportDialog />
      <RecoveryPrompt />
    </div>
  );
}
