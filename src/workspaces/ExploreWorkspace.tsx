import { useProjectStore } from '@/state/projectStore';
import { EmptyState } from '@/components/EmptyState';
import { Viewport } from '@/viewport/Viewport';
import { ExplorePanel } from '@/explore/ExplorePanel';

interface Props {
  isDragOver: boolean;
}

/**
 * EXPLORE — discover variations. Phase A keeps the existing Explore/Candidate
 * panel intact; the CURRENT/CANDIDATE layout lands in Phase C.
 */
export function ExploreWorkspace({ isDragOver }: Props) {
  const hasSources = useProjectStore((s) => s.project.sources.length > 0);

  return (
    <div className="workspace workspace-explore">
      <main className="viewport-area">
        <Viewport />
        <ExplorePanel />
        {!hasSources && <EmptyState isDragOver={isDragOver} />}
        {isDragOver && <div className="drop-overlay" />}
      </main>
    </div>
  );
}
