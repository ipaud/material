import { useExploreStore } from '@/state/exploreStore';
import {
  applySelectedVariation,
  generateExploration,
  mutateSelected,
  pinSelectedVariation,
} from './exploreActions';

const COUNTS = [4, 8, 12, 20];

/**
 * Horizontal filmstrip over the existing Explore population system.
 * Contact-sheet browsing: thumbnails, numbers, one thin selected outline.
 */
export function PopulationStrip() {
  const variations = useExploreStore((s) => s.variations);
  const thumbnails = useExploreStore((s) => s.thumbnails);
  const selectedSeed = useExploreStore((s) => s.selectedSeed);
  const count = useExploreStore((s) => s.count);
  const setCount = useExploreStore((s) => s.setCount);
  const generating = useExploreStore((s) => s.generating);
  const progress = useExploreStore((s) => s.progress);
  const select = useExploreStore((s) => s.select);

  const selected = variations.find((v) => v.seed === selectedSeed) ?? null;

  return (
    <section className="population" aria-label="Variations">
      <div className="population-bar">
        <span className="rail-head">VARIATIONS</span>
        <div className="population-counts">
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
        <button className="vp-btn" onClick={() => generateExploration()} disabled={generating}>
          {variations.length > 0 ? 'REGENERATE' : 'GENERATE'}
        </button>
        {generating && (
          <span className="vp-readout mono">
            {progress} / {variations.length}
          </span>
        )}
        <span className="population-spacer" />
        {selected && (
          <>
            <span className="vp-readout mono">
              SEED {selected.seed}
              {selected.generation > 0 && ` · GEN ${selected.generation}`}
            </span>
            <button
              className="vp-btn"
              onClick={() => mutateSelected()}
              disabled={generating}
              title="New population around this variation"
            >
              MUTATE SELECTED
            </button>
            <button className="vp-btn" onClick={() => pinSelectedVariation()}>
              PIN
            </button>
            <button className="vp-btn" onClick={() => applySelectedVariation()}>
              APPLY
            </button>
          </>
        )}
      </div>
      <div className="population-strip">
        {variations.length === 0 && !generating && (
          <span className="population-empty">
            GENERATE builds a population of controlled variations around the current system
          </span>
        )}
        {variations.map((v, i) => (
          <button
            key={v.seed}
            className={`pop-card${v.seed === selectedSeed ? ' selected' : ''}`}
            onClick={() => select(v.seed)}
            onDoubleClick={() => {
              select(v.seed);
              applySelectedVariation();
            }}
            title={`Seed ${v.seed}${v.parentSeed ? ` · parent ${v.parentSeed}` : ''} — double-click to apply`}
          >
            {thumbnails[v.seed] ? (
              <img src={thumbnails[v.seed]} alt={`Variation ${i + 1}`} draggable={false} />
            ) : (
              <div className="variation-pending" />
            )}
            <span className="pop-index mono">{String(i + 1).padStart(2, '0')}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
