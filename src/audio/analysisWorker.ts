import { analyzeBuffer } from './analysis';

interface AnalyzeRequest {
  mono: Float32Array;
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { mono, sampleRate } = event.data;
  const analysis = analyzeBuffer(mono, sampleRate);
  const transfer = Object.values(analysis.tracks).map((t) => t.buffer);
  (self as unknown as Worker).postMessage(analysis, transfer);
};
