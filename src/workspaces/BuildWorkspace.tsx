import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { Gutter } from '@/components/Gutter';
import { EmptyState } from '@/components/EmptyState';
import { LibraryPanel } from '@/library/LibraryPanel';
import { Viewport } from '@/viewport/Viewport';
import { InspectorPanel } from '@/inspector/InspectorPanel';
import { TimelinePanel } from '@/timeline/TimelinePanel';
import { TechniquesBrowser } from '@/techniques/TechniquesBrowser';

interface Props {
  isDragOver: boolean;
}

/**
 * BUILD — construct the visual system. Library / Viewport / Inspector / Timeline,
 * with Techniques as an overlay and Modulation living inside the Inspector.
 * Panel resizing (library width, inspector width, timeline height) is unchanged.
 */
export function BuildWorkspace({ isDragOver }: Props) {
  const libraryWidth = useUiStore((s) => s.libraryWidth);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const timelineHeight = useUiStore((s) => s.timelineHeight);
  const techniquesOpen = useUiStore((s) => s.techniquesOpen);
  const hasSources = useProjectStore((s) => s.project.sources.length > 0);

  return (
    <div className="workspace workspace-build">
      <div className="main-row">
        <aside className="panel panel-left" style={{ width: libraryWidth }}>
          <LibraryPanel />
        </aside>
        <Gutter panel="library" />
        <main className="viewport-area">
          <Viewport />
          {techniquesOpen && <TechniquesBrowser />}
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
    </div>
  );
}
