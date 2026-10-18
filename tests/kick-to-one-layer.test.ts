import { beforeEach, describe, expect, it } from 'vitest';
import { createSecondaryLayerEvaluator } from '@/export/exportRunner';
import { TRACK_IDS, type AudioAnalysis } from '@/audio/analysis';
import { useAudioStore } from '@/state/audioStore';
import {
  createEmptyProject,
  emptyLayer,
  type ModulationMapping,
  type Project,
} from '@shared/schemas/project';

const HOP = 0.01;
const FRAMES = 1000;

/** Bass is `level` during [1.0, 1.2) and 0 elsewhere; every other track is silent. */
function analysis(level: number): AudioAnalysis {
  const tracks = Object.fromEntries(TRACK_IDS.map((id) => [id, new Float32Array(FRAMES)])) as AudioAnalysis['tracks'];
  for (let i = 100; i < 120; i++) tracks.bass[i] = level;
  return { sampleRate: 44100, hopSec: HOP, frameCount: FRAMES, durationSec: FRAMES * HOP, tracks };
}

const kick = (over: Partial<ModulationMapping> = {}): ModulationMapping =>
  ({
    id: 'kick', enabled: true, source: 'bass', target: 'scale', amount: 0.8, min: 0, max: 1,
    invert: false, smoothing: 0, curve: 'linear', frozenValue: null, mode: 'add',
    targetLayerId: 'l3', ...over,
  }) as ModulationMapping;

function project(mapping: ModulationMapping): Project {
  const base = createEmptyProject('kick');
  const tech = (id: string) => ({ id, techniqueId: 'mosaic', enabled: true, params: { scale: 1 } });
  return {
    ...base,
    layers: [
      { ...base.layers[0]!, id: 'l1', technique: tech('t1') },
      { ...emptyLayer('l2'), technique: tech('t2') },
      { ...emptyLayer('l3'), technique: tech('t3') },
    ],
    selectedLayerId: 'l1',
    modulations: [mapping],
  };
}

const scales = (p: Project, t: number) => {
  const out = createSecondaryLayerEvaluator(p, 'l1', 100, () => ({})).paramsAt(t);
  return { l2: out.get('l2')!.scale as number, l3: out.get('l3')!.scale as number };
};

beforeEach(() => useAudioStore.setState({ analysis: analysis(0.9) }));

describe('a kick mapping aimed at layer 3', () => {
  it('moves layer 3 on the hit and leaves layer 2 alone', () => {
    const p = project(kick());
    const quiet = scales(p, 0.5);
    const hit = scales(p, 1.1);
    expect(quiet).toEqual({ l2: 1, l3: 1 });
    expect(hit.l3).toBeGreaterThan(1.2);
    expect(hit.l2).toBe(1);
  });

  it('inMin/inMax act as a threshold: a soft hit below inMin does nothing', () => {
    useAudioStore.setState({ analysis: analysis(0.3) });
    const p = project(kick({ inMin: 0.5, inMax: 1 }));
    expect(scales(p, 1.1).l3).toBe(1);
    useAudioStore.setState({ analysis: analysis(0.9) });
    expect(scales(p, 1.1).l3).toBeGreaterThan(1.1);
  });
});
