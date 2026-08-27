/**
 * CPU mirrors of the GLSL sampling math (see shaders/chunks.ts).
 * Used for tests and for CPU-side evaluation (Explore thumbnails, debug).
 */

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function adjustSample(
  v: number,
  contrast: number,
  gamma: number,
  invert: boolean,
): number {
  let out = Math.min(Math.max((v - 0.5) * contrast + 0.5, 0), 1);
  out = Math.pow(out, 1 / Math.max(gamma, 0.001));
  return invert ? 1 - out : out;
}

/**
 * Map an adjusted sample to a cell scale factor.
 * amount = 0 → constant base scale; amount = 1 → fully luminance-driven.
 */
export function sampleToScale(
  sample: number,
  baseScale: number,
  amount: number,
  minScale: number,
  maxScale: number,
): number {
  const driven = baseScale * (1 - amount + amount * sample);
  return Math.min(Math.max(driven, minScale), maxScale);
}
