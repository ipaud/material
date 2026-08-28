import {
  candidateRuntime,
  setMutationIntensity,
  useCandidateStore,
} from '@/performance/candidateRuntime';
import type { MutationIntensity } from '@/performance/mutation';

const INTENSITIES: { id: MutationIntensity; label: string; hint: string }[] = [
  { id: 'low', label: 'LOW', hint: 'Close variation' },
  { id: 'med', label: 'MED', hint: 'Balanced' },
  { id: 'high', label: 'HIGH', hint: 'Wider search' },
];

/** Bottom action bar: intensity, then the candidate verbs. MUTATE is primary. */
export function ExploreActions() {
  const candidate = useCandidateStore((s) => s.candidate);
  const intensity = useCandidateStore((s) => s.intensity);
  const hasCandidate = candidate !== null;

  return (
    <div className="explore-actions">
      <div className="intensity-seg" role="radiogroup" aria-label="Mutation intensity">
        {INTENSITIES.map((it) => (
          <button
            key={it.id}
            className={`intensity-btn${intensity === it.id ? ' active' : ''}`}
            role="radio"
            aria-checked={intensity === it.id}
            onClick={() => setMutationIntensity(it.id)}
            title={it.hint}
          >
            {it.label}
          </button>
        ))}
      </div>
      <span className="actions-sep" />
      <button
        className="explore-primary"
        onClick={() => candidateRuntime.generate()}
        title="Generate a candidate from CURRENT (G)"
      >
        {hasCandidate ? 'REGENERATE' : 'MUTATE'}
      </button>
      <button
        className="explore-btn"
        onClick={() => candidateRuntime.generate({ fromCandidate: true })}
        disabled={!hasCandidate}
        title="Mutate again, using the candidate as parent (Shift+G)"
      >
        MUTATE AGAIN
      </button>
      <span className="actions-sep" />
      <button
        className={`explore-btn${hasCandidate ? ' strong' : ''}`}
        onClick={() => candidateRuntime.apply()}
        disabled={!hasCandidate}
        title="Commit the candidate as CURRENT (Enter; quantized when a grid exists)"
      >
        APPLY
      </button>
      <button
        className="explore-btn"
        onClick={() => candidateRuntime.pin()}
        disabled={!hasCandidate}
        title="Pin the candidate as a Look without changing output"
      >
        PIN
      </button>
      <button
        className="explore-btn"
        onClick={() => candidateRuntime.discard()}
        disabled={!hasCandidate}
        title="Discard the candidate (Backspace)"
      >
        DISCARD
      </button>
      <span className="explore-actions-spacer" />
      <button
        className="explore-btn quiet"
        onClick={() => candidateRuntime.rethumbnail()}
        disabled={!hasCandidate}
        title="Re-capture the candidate thumbnail from the current playhead"
      >
        RE-THUMBNAIL
      </button>
    </div>
  );
}
