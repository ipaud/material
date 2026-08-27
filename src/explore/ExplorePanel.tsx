import { useState } from 'react';
import { useExploreStore } from '@/state/exploreStore';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import {
  applySelectedVariation,
  generateExploration,
  mutateSelected,
  pinSelectedVariation,
  toggleLock,
} from './exploreActions';
import './explore.css';

const COUNTS = [4, 8, 12, 20];

export function ExplorePanel() {
  const variations = useExploreStore((s) => s.variations);
  const thumbnails = useExploreStore((s) => s.thumbnails);
  const selectedSeed = useExploreStore((s) => s.selectedSeed);
  const count = useExploreStore((s) => s.count);
  const setCount = useExploreStore((s) => s.setCount);
  const generating = useExploreStore((s) => s.generating);
  const progress = useExploreStore((s) => s.progress);
  const select = useExploreStore((s) => s.select);
  const [showLocks, setShowLocks] = useState(false);

  const selected = variations.find((v) => v.seed === selectedSeed) ?? null;

  return (
    <div className="explore-panel">
      <div className="explore-toolbar">
        <span className="label">Explore</span>
        <div className="explore-counts">
          {COUNTS.map((c) => (
            <button
              key={c}
              className={`vp-btn${count === c ? ' active' : ''}`}
              onClick={() => setCount(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <button className="titlebar-action" onClick={() => generateExploration()} disabled={generating}>
          {variations.length > 0 ? 'Regenerate' : 'Generate'}
        </button>
        <button
          className="titlebar-action"
          onClick={() => mutateSelected()}
          disabled={!selected || generating}
          title="New population around the selected variation"
        >
          Mutate
        </button>
        <button className={`vp-btn${showLocks ? ' active' : ''}`} onClick={() => setShowLocks(!showLocks)}>
          LOCKS
        </button>
        <span className="explore-spacer" />
        {generating && (
          <span className="vp-readout mono">
            {progress} / {variations.length}
          </span>
        )}
        {selected && (
          <>
            <span className="vp-readout mono">seed {selected.seed}</span>
            {selected.generation > 0 && (
              <span className="vp-readout mono dim">gen {selected.generation}</span>
            )}
            <button className="titlebar-action" onClick={() => pinSelectedVariation()}>
              ◆ Pin
            </button>
            <button className="titlebar-action primary" onClick={() => applySelectedVariation()}>
              Apply
            </button>
          </>
        )}
      </div>
      {showLocks && <LocksRow />}
      <div className="explore-grid">
        {variations.length === 0 && !generating && (
          <div className="explore-empty">
            <span className="label">Generate controlled variations of the current system</span>
          </div>
        )}
        {variations.map((v, i) => (
          <button
            key={v.seed}
            className={`variation-card${v.seed === selectedSeed ? ' selected' : ''}`}
            onClick={() => select(v.seed)}
            onDoubleClick={() => {
              select(v.seed);
              applySelectedVariation();
            }}
            title={`Seed ${v.seed}${v.parentSeed ? ` · parent ${v.parentSeed}` : ''}`}
          >
            {thumbnails[v.seed] ? (
              <img src={thumbnails[v.seed]} alt={`Variation ${i + 1}`} draggable={false} />
            ) : (
              <div className="variation-pending" />
            )}
            <span className="variation-index mono">{String(i + 1).padStart(2, '0')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LocksRow() {
  const lockedParams = useProjectStore((s) => s.project.explore.lockedParams);
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const modulations = useProjectStore((s) => s.project.modulations);
  const definition = technique ? getTechnique(technique.techniqueId) : null;
  if (!definition) return null;

  const randomizable = allParams(definition).filter((p) => p.explore?.randomizable);
  const isLocked = (id: string) => lockedParams.includes(id);

  return (
    <div className="locks-row">
      <span className="label">Lock:</span>
      {randomizable.map((p) => (
        <button
          key={p.id}
          className={`lock-chip${isLocked(p.id) ? ' locked' : ''}`}
          onClick={() => toggleLock(p.id)}
          title={isLocked(p.id) ? 'Locked — will not randomize' : 'Unlocked — may randomize'}
        >
          {isLocked(p.id) ? '🔒 ' : ''}
          {p.label}
        </button>
      ))}
      {modulations.map((m) => (
        <button
          key={m.id}
          className={`lock-chip mod${isLocked(`mod:${m.id}`) ? ' locked' : ''}`}
          onClick={() => toggleLock(`mod:${m.id}`)}
        >
          {isLocked(`mod:${m.id}`) ? '🔒 ' : ''}
          {m.source}→{m.target}
        </button>
      ))}
    </div>
  );
}
