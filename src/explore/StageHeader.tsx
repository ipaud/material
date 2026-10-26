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
  const previewLabel = useProjectStore((s) => s.previewLabel);
  const activeLook = project.activeLookId
    ? (project.pinnedLooks.find((l) => l.id === project.activeLookId) ?? null)
    : null;
  const dirty = activeLook ? isLookDirty(project, activeLook) : false;
  const candidatePreview = previewing && candidate !== null;
  const isPreviewing = candidatePreview || previewLabel !== null;

  return (
    <div className={`stage-head${isPreviewing ? ' previewing' : ''}`}>
      <span className="stage-state">{isPreviewing ? (candidatePreview ? 'PREVIEWING CANDIDATE' : 'COMPARING') : 'CURRENT'}</span>
      {candidatePreview || previewLabel ? (
        <span className="stage-look mono">{candidatePreview ? candidate.label : previewLabel}</span>
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
      <span className="stage-ab mono" title="Hold a variation to compare it with Current">
        <span className={isPreviewing ? 'ab-dim' : 'ab-live'}>A CURRENT</span>
        {'  '}
        <span className={isPreviewing ? 'ab-live-cand' : 'ab-dim'}>B {candidatePreview ? 'CANDIDATE' : 'VARIATION'}</span>
      </span>
      <span className="stage-seed mono">SEED {project.explore.lastSeed ?? 1}</span>
    </div>
  );
}
