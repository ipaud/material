/**
 * Activity window: when a layer takes part in the composition, in composition
 * seconds. `activityAt` is the layer's intensity in [0, 1] at a time — exactly
 * 0 outside the window, exactly 1 on the plateau, a smoothstep through each fade.
 * The fades live INSIDE [start, end], so the window is also the audible/visible
 * extent. Absent window = always 1.
 */
export interface ActivityWindow {
  start: number;
  /** null = open-ended (the layer stays on until the end). */
  end: number | null;
  fadeIn: number;
  fadeOut: number;
}

const smooth = (x: number): number => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

export function activityAt(window: ActivityWindow | null | undefined, timeSec: number): number {
  if (!window) return 1;
  const { start, end, fadeIn, fadeOut } = window;
  if (timeSec < start || (end !== null && timeSec > end)) return 0;
  const up = fadeIn > 0 ? smooth((timeSec - start) / fadeIn) : 1;
  const down = end !== null && fadeOut > 0 ? smooth((end - timeSec) / fadeOut) : 1;
  return Math.min(up, down);
}
