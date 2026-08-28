import { useCandidateStore } from '@/performance/candidateRuntime';
import { useProjectStore } from '@/state/projectStore';
import { isLookDirty } from '@/performance/lookCore';

/**
 * One quiet line over the live stage. Answers "what am I looking at" without
 * relying on the frame colour alone: CURRENT vs PREVIEWING CANDIDATE is text.
 */
export function StageHeader() {
  const previewing = useCandidateStore((s) => s.previewing);
  const candidate = useCandidateStore((s) => s.candidate);
  const project = useProjectStore((s) => s.project);
  const activeLook = project.activeLookId
    ? (project.pinnedLooks.find((l) => l.id === project.activeLookId) ?? null)
    : null;
  const dirty = activeLook ? isLookDirty(project, activeLook) : false;
  const isPreviewing = previewing && candidate !== null;

  return (
    <div className={`stage-head${isPreviewing ? ' previewing' : ''}`}>
      <span className="stage-state">{isPreviewing ? 'PREVIEWING CANDIDATE' : 'CURRENT'}</span>
      {isPreviewing ? (
        <span className="stage-look mono">{candidate.label}</span>
      ) : (
        activeLook && (
          <span className="stage-look mono">
            {activeLook.label}
            {dirty && (
              <span className="stage-dirty" title="Current state differs from this look">
                {' '}
                ● MODIFIED
              </span>
            )}
          </span>
        )
      )}
      <span className="stage-spacer" />
      <span className="stage-ab mono" title="A = CURRENT · B = CANDIDATE (hold)">
        <span className={isPreviewing ? 'ab-dim' : 'ab-live'}>A CURRENT</span>
        {'  '}
        <span className={isPreviewing ? 'ab-live-cand' : 'ab-dim'}>B CANDIDATE</span>
      </span>
      <span className="stage-seed mono">SEED {project.explore.lastSeed ?? 1}</span>
    </div>
  );
}
