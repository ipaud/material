/** Min/max peak pairs for waveform drawing, computed once per audio load. */
export function computePeaks(mono: Float32Array, buckets: number): Float32Array {
  // Interleaved [min0, max0, min1, max1, ...]
  const peaks = new Float32Array(buckets * 2);
  const samplesPerBucket = Math.max(Math.floor(mono.length / buckets), 1);
  for (let b = 0; b < buckets; b++) {
    let min = 0;
    let max = 0;
    const start = b * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, mono.length);
    for (let i = start; i < end; i++) {
      const v = mono[i] as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}
