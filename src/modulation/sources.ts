import { sampleTrack, type AudioAnalysis, type TrackId } from '@/audio/analysis';
import { divisionPhase, type MusicalDivision } from '@/audio/beatGrid';

export interface ModSourceDef {
  id: string;
  label: string;
  group: 'audio' | 'time' | 'beat';
}

export const MOD_SOURCES: ModSourceDef[] = [
  { id: 'master', label: 'Master', group: 'audio' },
  { id: 'rms', label: 'RMS', group: 'audio' },
  { id: 'peak', label: 'Peak', group: 'audio' },
  { id: 'bass', label: 'Bass', group: 'audio' },
  { id: 'mids', label: 'Mids', group: 'audio' },
  { id: 'highs', label: 'Highs', group: 'audio' },
  { id: 'centroid', label: 'Centroid', group: 'audio' },
  { id: 'flux', label: 'Flux', group: 'audio' },
  { id: 'onset', label: 'Onset', group: 'audio' },
  { id: 'transients', label: 'Transients', group: 'audio' },
  { id: 'time', label: 'Time', group: 'time' },
  { id: 'beat:bar', label: 'Beat · Bar', group: 'beat' },
  { id: 'beat:1/2', label: 'Beat · 1/2', group: 'beat' },
  { id: 'beat:1/4', label: 'Beat · 1/4', group: 'beat' },
  { id: 'beat:1/8', label: 'Beat · 1/8', group: 'beat' },
  { id: 'beat:1/16', label: 'Beat · 1/16', group: 'beat' },
];

export interface SourceContext {
  analysis: AudioAnalysis | null;
  durationSec: number;
  bpm: number | null;
  beatOffsetSec: number;
  beatsPerBar: number;
}

/**
 * Evaluate every modulation source at an exact time. Pure + deterministic:
 * preview and export produce identical values for identical inputs.
 */
export function evalSources(timeSec: number, ctx: SourceContext): Record<string, number> {
  const values: Record<string, number> = {};
  const audioTracks: TrackId[] = [
    'master',
    'rms',
    'peak',
    'bass',
    'mids',
    'highs',
    'centroid',
    'flux',
    'onset',
    'transients',
  ];
  for (const id of audioTracks) {
    values[id] = ctx.analysis ? sampleTrack(ctx.analysis, id, timeSec) : 0;
  }
  values.time = ctx.durationSec > 0 ? Math.min(Math.max(timeSec / ctx.durationSec, 0), 1) : 0;
  const divisions: MusicalDivision[] = ['bar', '1/2', '1/4', '1/8', '1/16'];
  for (const div of divisions) {
    values[`beat:${div}`] =
      ctx.bpm && ctx.bpm > 0
        ? divisionPhase(timeSec, ctx.bpm, ctx.beatOffsetSec, div, ctx.beatsPerBar)
        : 0;
  }
  return values;
}
