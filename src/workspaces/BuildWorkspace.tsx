import { useEffect, useState } from 'react';
import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { Gutter } from '@/components/Gutter';
import { EmptyState } from '@/components/EmptyState';
import { LibraryPanel } from '@/library/LibraryPanel';
import { Viewport } from '@/viewport/Viewport';
import { InspectorPanel } from '@/inspector/InspectorPanel';
import { TimelinePanel } from '@/timeline/TimelinePanel';
import { TechniquesBrowser } from '@/techniques/TechniquesBrowser';
import { SystemPath } from '@/build/SystemPath';

interface Props {
  isDragOver: boolean;
}

/**
 * BUILD — construct the visual system. Library / Viewport / Inspector / Timeline,
 * with Techniques as an overlay and Modulation living inside the Inspector.
 * Panel resizing (library width, inspector width, timeline height) is unchanged.
 */
export function BuildWorkspace({ isDragOver }: Props) {
  const [mobilePanel, setMobilePanel] = useState<'library' | 'inspector' | null>(null);
  useEffect(() => {
    const breakpoint = window.matchMedia?.('(min-width: 761px)');
    if (!breakpoint) return;
    const closeDrawer = () => { if (breakpoint.matches) setMobilePanel(null); };
    breakpoint.addEventListener('change', closeDrawer);
    return () => breakpoint.removeEventListener('change', closeDrawer);
  }, []);
  const libraryWidth = useUiStore((s) => s.libraryWidth);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const timelineHeight = useUiStore((s) => s.timelineHeight);
  const techniquesOpen = useUiStore((s) => s.techniquesOpen);
  const hasSources = useProjectStore((s) => s.project.sources.length > 0);

  return (
    <div className="workspace workspace-build">
      <div className="build-toolbar">
        <SystemPath />
        <div className="build-mobile-panels" role="group" aria-label="Workspace panels">
          <button aria-controls="build-library-panel" aria-expanded={mobilePanel === 'library'} onClick={() => setMobilePanel((panel) => panel === 'library' ? null : 'library')}>Library</button>
          <button aria-controls="build-inspector-panel" aria-expanded={mobilePanel === 'inspector'} onClick={() => setMobilePanel((panel) => panel === 'inspector' ? null : 'inspector')}>Inspector</button>
        </div>
      </div>
      <div className="main-row">
        <aside id="build-library-panel" className={`panel panel-left${mobilePanel === 'library' ? ' mobile-open' : ''}`} style={{ width: libraryWidth }}>
          <LibraryPanel />
        </aside>
        <Gutter panel="library" />
        <main className="viewport-area" inert={mobilePanel !== null}>
          <Viewport />
          {techniquesOpen && <TechniquesBrowser />}
          {!hasSources && <EmptyState isDragOver={isDragOver} />}
          {isDragOver && <div className="drop-overlay" />}
        </main>
        <Gutter panel="inspector" />
        <aside id="build-inspector-panel" className={`panel panel-right${mobilePanel === 'inspector' ? ' mobile-open' : ''}`} style={{ width: inspectorWidth }}>
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
