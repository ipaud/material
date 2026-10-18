import { applyCurve } from '@/modulation/evaluator';
import { envelopeDuration, envelopeValue } from '@/signals/envelope';
import type { ModulationMapping, TriggerMapping } from '@shared/schemas/project';

export interface Point {
  x: number;
  y: number;
}

/**
 * The mapping's shape, before smoothing: source value (x, 0..1) → output (y).
 * Same order as `shapedUnitValue`: input window, invert, curve, then the output range.
 */
export function transferPoints(m: ModulationMapping, steps = 48): Point[] {
  const inMin = m.inMin ?? 0;
  const inMax = m.inMax ?? 1;
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    let v = x;
    if (inMax !== inMin && (inMin !== 0 || inMax !== 1)) {
      v = Math.min(Math.max((x - inMin) / (inMax - inMin), 0), 1);
    }
    if (m.invert) v = 1 - v;
    v = applyCurve(v, m.curve);
    out.push({ x, y: m.min + (m.max - m.min) * v });
  }
  return out;
}

/** A pulse's contribution over time (x in seconds): attack, hold, decay, times amount. */
export function envelopePoints(t: TriggerMapping, steps = 60): Point[] {
  const total = envelopeDuration(t);
  if (total <= 0) return [{ x: 0, y: 0 }];
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * total;
    out.push({ x, y: envelopeValue(x, t) * t.amount });
  }
  return out;
}

const W = 120;
const H = 36;
const PAD = 3;

function polyline(points: Point[], xMax: number, yMin: number, yMax: number): string {
  const span = yMax - yMin || 1;
  return points
    .map((p) => {
      const x = PAD + (p.x / (xMax || 1)) * (W - 2 * PAD);
      const y = H - PAD - ((p.y - yMin) / span) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** What this mapping does to a signal: input along the bottom, output up the side. */
export function TransferPreview({ mapping }: { mapping: ModulationMapping }) {
  const points = transferPoints(mapping);
  const ys = points.map((p) => p.y);
  const lo = Math.min(0, ...ys);
  const hi = Math.max(1, ...ys);
  return (
    <svg
      className="curve-preview"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Mapping response: input signal to output value"
    >
      <polyline points={polyline(points, 1, lo, hi)} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The shape of one hit: attack, hold, decay. */
export function EnvelopePreview({ trigger }: { trigger: TriggerMapping }) {
  const points = envelopePoints(trigger);
  const total = envelopeDuration(trigger);
  const ys = points.map((p) => p.y);
  const lo = Math.min(0, ...ys);
  const hi = Math.max(0.0001, ...ys);
  return (
    <figure className="curve-preview-wrap">
      <svg
        className="curve-preview"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Pulse envelope: attack, hold, decay"
      >
        <polyline points={polyline(points, total, lo, hi)} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mono">{total.toFixed(2)}s</figcaption>
    </figure>
  );
}
