/**
 * Minimal iterative radix-2 FFT + windowing for offline audio analysis.
 * Deterministic: same input → same output, always.
 */

const windowCache = new Map<number, Float32Array>();

export function hannWindow(size: number): Float32Array {
  const cached = windowCache.get(size);
  if (cached) return cached;
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  windowCache.set(size, win);
  return win;
}

/** In-place radix-2 FFT. Length must be a power of two. */
export function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');

  // Bit reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const evenRe = re[i + k] as number;
        const evenIm = im[i + k] as number;
        const oddRe = re[i + k + len / 2] as number;
        const oddIm = im[i + k + len / 2] as number;
        const tRe = oddRe * curRe - oddIm * curIm;
        const tIm = oddRe * curIm + oddIm * curRe;
        re[i + k] = evenRe + tRe;
        im[i + k] = evenIm + tIm;
        re[i + k + len / 2] = evenRe - tRe;
        im[i + k + len / 2] = evenIm - tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Windowed magnitude spectrum of one frame (length = fftSize).
 * Returns fftSize/2 bins.
 */
export function magnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length;
  const win = hannWindow(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = (frame[i] as number) * (win[i] as number);
  fftRadix2(re, im);
  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    const r = re[i] as number;
    const j = im[i] as number;
    mags[i] = Math.sqrt(r * r + j * j);
  }
  return mags;
}
