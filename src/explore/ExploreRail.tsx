import { toggleMutationLock, useCandidateStore } from '@/performance/candidateRuntime';
import { useProjectStore } from '@/state/projectStore';
import type { MutationLocks } from '@/performance/mutation';

/**
 * Metadata rail: MUTATION info, LOCKS, LINEAGE. Technical, mono, secondary —
 * the two visuals stay the loudest thing in the workspace.
 */
export function ExploreRail() {
  return (
    <aside className="explore-rail" aria-label="Mutation details">
      <MutationInfo />
      <LocksSection />
      <LineageSection />
    </aside>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rail-row" title={title}>
      <span className="rail-label">{label}</span>
      <span className="rail-value mono">{value}</span>
    </div>
  );
}

function MutationInfo() {
  const candidate = useCandidateStore((s) => s.candidate);
  const intensity = useCandidateStore((s) => s.intensity);
  const lastSeed = useProjectStore((s) => s.project.explore.lastSeed);

  return (
    <section className="rail-section">
      <span className="rail-head">MUTATION</span>
      <Row label="INTENSITY" value={intensity.toUpperCase()} />
      {candidate ? (
        <>
          <Row label="GENERATION" value={String(candidate.metadata.generation).padStart(2, '0')} />
          <Row label="SEED" value={String(candidate.seed)} />
          <Row label="PARENT SEED" value={String(candidate.parentSeed)} />
          <Row
            label="CHANGES"
            value={`${candidate.metadata.changedParams}P / ${candidate.metadata.changedModulations}M`}
            title="Parameters / modulations that actually moved"
          />
        </>
      ) : (
        <Row label="SEED" value={String(lastSeed ?? 1)} title="Current system seed" />
      )}
    </section>
  );
}

const LOCK_LABELS: { key: keyof MutationLocks; label: string; hint: string }[] = [
  { key: 'technique', label: 'TECHNIQUE', hint: 'Freeze every technique parameter' },
  { key: 'timing', label: 'TIMING', hint: 'Freeze temporal / time-offset parameters' },
  { key: 'color', label: 'COLOR', hint: 'Freeze sampling / colour parameters' },
  { key: 'signals', label: 'SIGNALS', hint: 'Freeze modulation amounts' },
  { key: 'material', label: 'MATERIAL', hint: 'Material never mutates in v0.2 — reserved' },
];

function LocksSection() {
  const locks = useCandidateStore((s) => s.locks);
  return (
    <section className="rail-section">
      <span className="rail-head">LOCKS</span>
      {LOCK_LABELS.map(({ key, label, hint }) => (
        <button
          key={key}
          className={`rail-lock${locks[key] ? ' locked' : ''}`}
          onClick={() => toggleMutationLock(key)}
          role="switch"
          aria-checked={locks[key]}
          title={hint}
        >
          <span className="rail-lock-mark">{locks[key] ? '●' : '○'}</span>
          {label}
          {locks[key] && <span className="rail-lock-state">LOCKED</span>}
        </button>
      ))}
    </section>
  );
}

function LineageSection() {
  const candidate = useCandidateStore((s) => s.candidate);
  const activeLook = useProjectStore((s) => {
    const id = s.project.activeLookId;
    return id ? (s.project.pinnedLooks.find((l) => l.id === id) ?? null) : null;
  });
  if (!candidate) return null;

  const priors = candidate.metadata.generation - 1;

  return (
    <section className="rail-section">
      <span className="rail-head">LINEAGE</span>
      <div className="rail-lineage mono">
        <div className="lineage-node">CURRENT{activeLook ? ` · ${activeLook.label}` : ''}</div>
        {priors > 0 && (
          <div className="lineage-node dim">
            ↓ {priors} prior mutation{priors === 1 ? '' : 's'}
          </div>
        )}
        <div className="lineage-node candidate">↓ {candidate.label}</div>
      </div>
    </section>
  );
}
