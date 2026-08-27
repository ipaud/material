/**
 * Tap tempo. Collects tap timestamps, derives BPM from the median interval
 * (median resists one mistimed tap), and reports the last tap time so the
 * caller can align the beat offset to where the user actually tapped.
 */

const MAX_TAPS = 8;
/** A gap this long starts a new measurement. */
const RESET_GAP_MS = 2500;
const MIN_BPM = 30;
const MAX_BPM = 300;

export class TapTempo {
  private taps: number[] = [];

  /**
   * Register a tap at `nowMs` (performance.now()).
   * Returns the current estimate, or null until two taps exist.
   */
  tap(nowMs: number): { bpm: number; taps: number } | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && nowMs - last > RESET_GAP_MS) {
      this.taps = [];
    }
    this.taps.push(nowMs);
    if (this.taps.length > MAX_TAPS) this.taps.shift();
    if (this.taps.length < 2) return null;

    const intervals: number[] = [];
    for (let i = 1; i < this.taps.length; i++) {
      intervals.push((this.taps[i] as number) - (this.taps[i - 1] as number));
    }
    intervals.sort((a, b) => a - b);
    const mid = Math.floor(intervals.length / 2);
    const median =
      intervals.length % 2 === 1
        ? (intervals[mid] as number)
        : (((intervals[mid - 1] as number) + (intervals[mid] as number)) / 2);

    const bpm = 60000 / median;
    if (bpm < MIN_BPM || bpm > MAX_BPM) return null;
    return { bpm: Number(bpm.toFixed(1)), taps: this.taps.length };
  }

  reset(): void {
    this.taps = [];
  }
}

/**
 * Beat offset so the grid lands on the tapped moment: the offset is the
 * tapped playback time reduced modulo one beat period.
 */
export function offsetFromTap(tappedPlaybackSec: number, bpm: number): number {
  const period = 60 / bpm;
  const offset = tappedPlaybackSec % period;
  return Number(offset.toFixed(4));
}
