import { useAudioStore } from '@/state/audioStore';
import { reportError } from '@/state/uiStore';
import { computePeaks } from './waveform';
import type { AudioAnalysis } from './analysis';

const WAVEFORM_BUCKETS = 2000;

function mediaUrl(path: string): string {
  return `material://media?p=${encodeURIComponent(path)}`;
}

function downmixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      mono[i] = (mono[i] as number) + (data[i] as number) / channels;
    }
  }
  return mono;
}

/**
 * Audio decode, offline analysis (worker), and sample-accurate playback.
 * When audio is loaded it is the authoritative playback clock
 * (AudioContext.currentTime), and video slaves to it.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private startOffset = 0;
  private pausedAt = 0;
  playing = false;
  analysis: AudioAnalysis | null = null;
  private loadGeneration = 0;

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get isLoaded(): boolean {
    return this.buffer !== null;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  async load(path: string): Promise<void> {
    const generation = ++this.loadGeneration;
    this.stopNode();
    this.playing = false;
    this.pausedAt = 0;
    useAudioStore.getState().setLoading(path);
    try {
      const response = await fetch(mediaUrl(path));
      if (!response.ok) throw new Error(`Could not read audio file (${response.status})`);
      const encoded = await response.arrayBuffer();
      const ctx = this.ensureCtx();
      const buffer = await ctx.decodeAudioData(encoded);
      if (generation !== this.loadGeneration) return;
      this.buffer = buffer;

      const mono = downmixToMono(buffer);
      const peaks = computePeaks(mono, WAVEFORM_BUCKETS);

      const analysis = await this.runAnalysisWorker(mono, buffer.sampleRate);
      if (generation !== this.loadGeneration) return;
      this.analysis = analysis;
      useAudioStore.getState().setLoaded(path, analysis, peaks, buffer.duration);
    } catch (err) {
      if (generation === this.loadGeneration) {
        useAudioStore.getState().clear();
        reportError('Load audio', err);
      }
    }
  }

  unload(): void {
    this.loadGeneration++;
    this.stopNode();
    this.buffer = null;
    this.analysis = null;
    this.playing = false;
    this.pausedAt = 0;
    useAudioStore.getState().clear();
  }

  private runAnalysisWorker(mono: Float32Array, sampleRate: number): Promise<AudioAnalysis> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<AudioAnalysis>) => {
        resolve(e.data);
        worker.terminate();
      };
      worker.onerror = (e) => {
        reject(new Error(`Audio analysis failed: ${e.message}`));
        worker.terminate();
      };
      // Copy: the engine keeps its mono for potential re-analysis-free reuse.
      const copy = Float32Array.from(mono);
      worker.postMessage({ mono: copy, sampleRate }, [copy.buffer]);
    });
  }

  // ---- transport (audio-master clock) ----

  getTime(): number {
    if (!this.ctx || !this.buffer) return 0;
    if (!this.playing) return this.pausedAt;
    return Math.min(this.startOffset + this.ctx.currentTime - this.startCtxTime, this.duration);
  }

  play(fromSec?: number): void {
    const ctx = this.ensureCtx();
    if (!this.buffer) return;
    void ctx.resume();
    this.stopNode();
    const offset = Math.min(Math.max(fromSec ?? this.pausedAt, 0), this.duration);
    const node = ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(ctx.destination);
    node.start(0, offset);
    this.sourceNode = node;
    this.startCtxTime = ctx.currentTime;
    this.startOffset = offset;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.getTime();
    this.stopNode();
    this.playing = false;
  }

  seek(timeSec: number): void {
    const clamped = Math.min(Math.max(timeSec, 0), this.duration);
    if (this.playing) {
      this.play(clamped);
    } else {
      this.pausedAt = clamped;
    }
  }

  private stopNode(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
      } catch {
        /* already stopped */
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }
}

export const audioEngine = new AudioEngine();
