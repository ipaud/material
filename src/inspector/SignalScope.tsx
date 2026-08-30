import { useEffect, useRef, useState } from 'react';
import { modulationRuntime } from '@/modulation/runtime';
import { calibrationStore } from '@/signals/visual/calibrationStore';
import { VISUAL_SIGNALS, type RawVisualStats, type VisualSignalId } from '@/signals/visual/types';
import { unwatchSignal, watchSignal } from '@/signals/visual/scopeStore';

/**
 * v0.4A A6 — RAW, CALIBRATED, the range, and validity.
 *
 * The calibrated value is never opaque: a performer needs to see that a signal
 * is warming rather than dead, and that its range is adapting rather than
 * stuck. Scalar history only — the sparkline holds numbers, never frames.
 */

const HISTORY = 120; // ~4s at the 30Hz analysis rate

function rawOf(id: VisualSignalId, stats: RawVisualStats | null): number | null {
  if (!stats) return null;
  if (id === 'image.luminance') return stats.luminance;
  if (!stats.hasFlow) return null;
  return id === 'motion.amount' ? stats.motionAmount : stats.motionX;
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="scope-spark" />;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${(1 - Math.min(Math.max(v, 0), 1)) * 100}`)
    .join(' ');
  return (
    <svg className="scope-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function SignalRow({ id }: { id: VisualSignalId }) {
  const def = VISUAL_SIGNALS.find((s) => s.id === id)!;
  const [tick, setTick] = useState(0);
  const history = useRef<number[]>([]);

  useEffect(() => {
    watchSignal(id);
    const h = setInterval(() => setTick((t) => t + 1), 100);
    return () => {
      clearInterval(h);
      unwatchSignal(id);
    };
  }, [id]);

  const stats = modulationRuntime.visualStats;
  const raw = rawOf(id, stats);
  const published = modulationRuntime.visualValues()[id];
  const range = calibrationStore.inspect(modulationRuntime.visualOriginKey, id);

  if (published !== undefined) {
    history.current.push(published);
    if (history.current.length > HISTORY) history.current.shift();
  }

  const validity =
    raw === null ? 'INACTIVE' : published === undefined ? 'WARMING' : 'LIVE';

  return (
    <div className="scope-row" data-tick={tick}>
      <div className="scope-head">
        <span className="scope-name">{def.label}</span>
        <span className={`scope-validity ${validity.toLowerCase()}`}>{validity}</span>
      </div>
      <div className="scope-values">
        <span>RAW {raw === null ? '—' : raw.toFixed(3)}</span>
        <span>CAL {published === undefined ? '—' : published.toFixed(3)}</span>
        {def.calibrated && range ? (
          <span className="scope-range">
            {range.lo.toFixed(2)} – {range.hi.toFixed(2)}
          </span>
        ) : (
          <span className="scope-range">{def.calibrated ? '—' : 'no calibration'}</span>
        )}
      </div>
      <Sparkline values={history.current} />
      <div className="scope-unit">{def.unit}</div>
    </div>
  );
}

export function SignalScope() {
  return (
    <div className="signal-scope">
      {VISUAL_SIGNALS.map((s) => (
        <SignalRow key={s.id} id={s.id} />
      ))}
    </div>
  );
}
