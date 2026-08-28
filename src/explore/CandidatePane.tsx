import { candidateRuntime, useCandidateStore } from '@/performance/candidateRuntime';

/**
 * The CANDIDATE side of the comparison. Static deterministic thumbnail —
 * the live engine stays single; auditioning (hold B) renders the candidate
 * on the main stage through the existing overlay path.
 */
export function CandidatePane() {
  const candidate = useCandidateStore((s) => s.candidate);
  const previewing = useCandidateStore((s) => s.previewing);
  const queuedId = useCandidateStore((s) => s.queuedId);

  if (!candidate) {
    return (
      <aside className="cand-pane empty" aria-label="Candidate">
        <div className="cand-head">
          <span className="cand-title">CANDIDATE</span>
        </div>
        <div className="cand-empty">
          <span className="cand-empty-label">NO CANDIDATE</span>
          <button className="cand-mutate-cta" onClick={() => candidateRuntime.generate()}>
            MUTATE CURRENT
          </button>
          <span className="cand-hint mono">G</span>
        </div>
      </aside>
    );
  }

  const queued = queuedId === candidate.id;

  return (
    <aside className={`cand-pane${previewing ? ' previewing' : ''}`} aria-label="Candidate">
      <div className="cand-head">
        <span className="cand-title">CANDIDATE</span>
        <span className="cand-name mono">{candidate.label}</span>
        {previewing && <span className="cand-live-badge">ON STAGE</span>}
      </div>
      <div className="cand-thumb">
        {candidate.thumbnail ? (
          <img src={candidate.thumbnail} alt={candidate.label} draggable={false} />
        ) : (
          <div className="variation-pending" />
        )}
        {candidate.darkThumbnail && (
          <button
            className="cand-dark-note"
            onClick={() => candidateRuntime.rethumbnail()}
            title="The captured frame was almost black — re-capture from the current playhead"
          >
            DARK FRAME — RE-THUMBNAIL
          </button>
        )}
      </div>
      <div className="cand-meta mono">
        SEED {candidate.seed} · GEN {String(candidate.metadata.generation).padStart(2, '0')}
        {queued && <span className="cand-queued"> · QUEUED</span>}
      </div>
      <button
        className="cand-audition"
        onPointerDown={() => candidateRuntime.setPreview(true)}
        onPointerUp={() => candidateRuntime.setPreview(false)}
        onPointerLeave={() => candidateRuntime.setPreview(false)}
        title="Hold to audition the candidate on the stage (or hold B)"
      >
        <span className="cand-audition-key mono">B</span>
        {previewing ? 'AUDITIONING — RELEASE FOR CURRENT' : 'HOLD TO AUDITION'}
      </button>
    </aside>
  );
}
