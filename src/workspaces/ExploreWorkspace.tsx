import { selectedLayerOf } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { WorkspaceEmpty } from '@/components/WorkspaceEmpty';
import { Viewport } from '@/viewport/Viewport';
import { StageHeader } from '@/explore/StageHeader';
import { CandidatePane } from '@/explore/CandidatePane';
import { ExploreRail } from '@/explore/ExploreRail';
import { PopulationStrip } from '@/explore/PopulationStrip';
import { ExploreActions } from '@/explore/ActionBar';
import '@/explore/explore.css';

interface Props {
  isDragOver: boolean;
}

/**
 * EXPLORE — discover variations. One live engine: the stage shows CURRENT,
 * and holding B renders the candidate through the existing overlay path.
 * The CANDIDATE pane is a static deterministic thumbnail, never a second
 * render engine.
 */
export function ExploreWorkspace({ isDragOver }: Props) {
  const hasSystem = useProjectStore(
    (s) => selectedLayerOf(s.project).sourceId !== null && selectedLayerOf(s.project).technique !== null,
  );

  if (!hasSystem) {
    return (
      <div className="workspace workspace-explore">
        <ExploreEmpty />
        {isDragOver && <div className="drop-overlay" />}
      </div>
    );
  }

  return (
    <div className="workspace workspace-explore explore-shell">
      <div className="explore-main">
        <main className="explore-stage">
          <StageHeader />
          <div className="stage-well">
            <Viewport />
          </div>
        </main>
        <CandidatePane />
        <ExploreRail />
      </div>
      <PopulationStrip />
      <ExploreActions />
      {isDragOver && <div className="drop-overlay" />}
    </div>
  );
}

/** No source or no technique: nothing real to explore — say so, offer BUILD. */
export function ExploreEmpty() {
  return (
    <WorkspaceEmpty
      title="BUILD A SYSTEM FIRST"
      hint="EXPLORE mutates the current source + technique — there is nothing to vary yet"
    />
  );
}
