import type { PatternSource, PatternTransformJson } from '@shared/schemas/project';
import { updatePatternSource } from '@/pattern/patternSourceActions';
import { NumberField } from './NumberField';

/**
 * Transforms are an ORDERED LIST, not a set of toggles — P2 locked
 * `fast → reverse` and `reverse → fast` as different compositions, so the UI
 * shows the serialized order with explicit numbers and explicit reordering.
 * A prettier row of independent switches would quietly destroy that.
 *
 * `degrade` is called PROBABILITY here (0–100%); the serialized type stays
 * `degrade`, and it is deterministic per step, never unstable randomness.
 */

type Transform = PatternTransformJson;

const NESTABLE = ['reverse', 'rotate', 'fast', 'slow'] as const;

const TYPE_LABEL: Record<string, string> = {
  fast: 'Fast',
  slow: 'Slow',
  reverse: 'Reverse',
  rotate: 'Rotate',
  every: 'Every',
  degrade: 'Probability',
};

function defaultTransform(type: string): Transform {
  switch (type) {
    case 'fast':
      return { type: 'fast', factor: 2 };
    case 'slow':
      return { type: 'slow', factor: 2 };
    case 'reverse':
      return { type: 'reverse' };
    case 'rotate':
      return { type: 'rotate', steps: 1 };
    case 'every':
      return { type: 'every', cycles: 4, transform: { type: 'reverse' } };
    default:
      return { type: 'degrade', probability: 0.5 };
  }
}

export function TransformList({ source }: { source: PatternSource }) {
  const transforms = source.transforms;

  const write = (next: Transform[]) => updatePatternSource(source.id, { transforms: next });
  const replace = (index: number, transform: Transform) =>
    write(transforms.map((t, i) => (i === index ? transform : t)));
  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= transforms.length) return;
    const next = [...transforms];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item as Transform);
    write(next);
  };

  return (
    <div className="pat-block">
      <div className="pat-block-head">
        <span className="label">Transforms</span>
        <span className="pat-hint">applied in order</span>
      </div>
      {transforms.length === 0 && <div className="pat-empty-line">No transforms</div>}
      <ol className="pat-transforms">
        {transforms.map((transform, index) => (
          <li key={index} className="pat-transform">
            <span className="pat-transform-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="pat-transform-name">{TYPE_LABEL[transform.type]}</span>
            <div className="pat-transform-args">
              <TransformArgs
                transform={transform}
                onChange={(next) => replace(index, next)}
              />
            </div>
            <div className="pat-transform-order">
              <button
                className="vp-btn"
                disabled={index === 0}
                aria-label={`Move ${TYPE_LABEL[transform.type]} earlier`}
                title="Move earlier — order changes the result"
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                className="vp-btn"
                disabled={index === transforms.length - 1}
                aria-label={`Move ${TYPE_LABEL[transform.type]} later`}
                title="Move later — order changes the result"
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                className="vp-btn"
                aria-label={`Remove ${TYPE_LABEL[transform.type]}`}
                title="Remove transform"
                onClick={() => write(transforms.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="pat-add-row">
        <select
          className="select"
          value=""
          aria-label="Add transform"
          onChange={(e) => {
            if (!e.target.value) return;
            write([...transforms, defaultTransform(e.target.value)]);
            e.target.value = '';
          }}
        >
          <option value="">+ Add transform</option>
          {['fast', 'slow', 'reverse', 'rotate', 'every', 'degrade'].map((type) => (
            <option key={type} value={type}>
              {TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function TransformArgs({
  transform,
  onChange,
}: {
  transform: Transform;
  onChange: (next: Transform) => void;
}) {
  switch (transform.type) {
    case 'fast':
    case 'slow':
      return (
        <NumberField
          label="factor"
          suffix="×"
          value={transform.factor}
          validate={(v) => v > 0}
          onCommit={(factor) => onChange({ type: transform.type, factor })}
        />
      );
    case 'rotate':
      return (
        <NumberField
          label="steps"
          value={transform.steps}
          integer
          onCommit={(steps) => onChange({ type: 'rotate', steps })}
        />
      );
    case 'reverse':
      return null;
    case 'every':
      return (
        <>
          <NumberField
            label="cycles"
            value={transform.cycles}
            integer
            validate={(v) => v >= 1}
            onCommit={(cycles) => onChange({ ...transform, cycles })}
          />
          <span className="pat-arrow">→</span>
          <select
            className="select"
            aria-label="Transform applied every N cycles"
            value={transform.transform.type}
            onChange={(e) =>
              onChange({
                ...transform,
                transform: defaultTransform(e.target.value) as typeof transform.transform,
              })
            }
          >
            {NESTABLE.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          {transform.transform.type === 'rotate' && (
            <NumberField
              label="steps"
              value={transform.transform.steps}
              integer
              onCommit={(steps) => onChange({ ...transform, transform: { type: 'rotate', steps } })}
            />
          )}
          {(transform.transform.type === 'fast' || transform.transform.type === 'slow') && (
            <NumberField
              label="factor"
              suffix="×"
              value={transform.transform.factor}
              validate={(v) => v > 0}
              onCommit={(factor) =>
                onChange({
                  ...transform,
                  transform: { type: transform.transform.type as 'fast' | 'slow', factor },
                })
              }
            />
          )}
        </>
      );
    case 'degrade':
      return (
        <NumberField
          label="chance"
          suffix="%"
          // Stored 0..1, shown 0..100. Rounded on display only — the stored
          // value is recomputed from the integer percent, so repeatedly
          // opening the editor cannot drift the probability.
          value={Math.round(transform.probability * 100)}
          integer
          validate={(v) => v >= 0 && v <= 100}
          onCommit={(percent) => onChange({ type: 'degrade', probability: percent / 100 })}
        />
      );
  }
}
