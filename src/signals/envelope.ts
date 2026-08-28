/**
 * Reusable event envelope: Attack → Hold → Decay, scalar 0..1.
 * A pure function of local time — no state, so it is trivially deterministic
 * and usable by pulses, future MIDI triggers, markers, and performance
 * recording alike. (Release is future-ready: add a fourth stage here and
 * every consumer inherits it.)
 */

export interface EnvelopeShape {
  attackSec: number;
  holdSec: number;
  decaySec: number;
  curve: 'linear' | 'exponential' | 'easeOut';
}

export function envelopeDuration(shape: EnvelopeShape): number {
  return shape.attackSec + shape.holdSec + shape.decaySec;
}

function decayCurve(x: number, curve: EnvelopeShape['curve']): number {
  // x: 0 (decay start) → 1 (decay end). Returns remaining level 1 → 0.
  const clamped = Math.min(Math.max(x, 0), 1);
  switch (curve) {
    case 'exponential':
      // Sharp snap: fast initial drop, long tail.
      return (1 - clamped) * (1 - clamped);
    case 'easeOut':
      // Musical: holds energy briefly, then falls away.
      return 1 - clamped * clamped;
    case 'linear':
    default:
      return 1 - clamped;
  }
}

/** Envelope value 0..1 at `localSec` after the trigger (negative → 0). */
export function envelopeValue(localSec: number, shape: EnvelopeShape): number {
  if (localSec < 0) return 0;
  const { attackSec, holdSec, decaySec } = shape;
  if (localSec < attackSec) {
    return attackSec > 0 ? localSec / attackSec : 1;
  }
  const afterAttack = localSec - attackSec;
  if (afterAttack < holdSec) return 1;
  const afterHold = afterAttack - holdSec;
  if (decaySec <= 0) return 0;
  if (afterHold >= decaySec) return 0;
  return decayCurve(afterHold / decaySec, shape.curve);
}
