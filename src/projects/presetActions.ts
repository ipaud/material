import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { withTechniqueEnsured } from '@/projects/projectActions';
import { uid } from '@/utils/id';
import type { Preset } from '@shared/schemas/preset';

/** Built-in starting points. Source media is never part of a preset. */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-clean-mosaic',
    name: 'Clean Mosaic',
    techniqueId: 'mosaic',
    params: { columns: 64, rows: 36, scale: 1, spacing: 0.15, lumToScale: 0.9 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    id: 'builtin-dense-grid',
    name: 'Dense Grid',
    techniqueId: 'mosaic',
    params: { columns: 160, rows: 90, scale: 1.1, spacing: 0, lumToScale: 1, contrast: 1.3 },
    material: { materialId: 'circle', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    id: 'builtin-broken-portrait',
    name: 'Broken Portrait',
    techniqueId: 'mosaic',
    params: {
      columns: 72,
      rows: 96,
      scale: 1.2,
      spacing: 0.05,
      lumToScale: 1,
      randomRotation: 0.12,
      jitterX: 0.35,
      jitterY: 0.2,
      threshold: 0.08,
    },
    material: { materialId: 'rectangle', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    id: 'builtin-halftone',
    name: 'Halftone',
    techniqueId: 'mosaic',
    params: { columns: 96, rows: 54, scale: 1.3, spacing: 0.1, lumToScale: 1, gamma: 1.4 },
    material: { materialId: 'dot', colorMode: 'mono', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    // Official system preset (Phase 5 creative review): the past reaches
    // further from center when the low end hits. Needs a video source.
    id: 'builtin-echo-chamber',
    name: 'Echo Chamber',
    techniqueId: 'mosaic',
    params: {
      columns: 18,
      rows: 11,
      scale: 1,
      spacing: 0.08,
      lumToScale: 0.4,
      tileMode: 'tile',
      offsetMode: 'radial',
      temporalDirection: 'outward', // center = now, outer = progressively older
      maxOffsetSec: 0.9,
      falloff: 1,
      centerX: 0,
      centerY: 0,
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'echo-bass-offset',
        enabled: true,
        source: 'bass',
        target: 'maxOffsetSec',
        amount: 0.6,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.3,
        curve: 'linear',
        frozenValue: null,
      },
    ],
    builtin: true,
  },
  {
    // System preset: every tile holds a different, seeded moment — a broken
    // mirror in time. Bass widens the spread. Needs a video source.
    id: 'builtin-time-fracture',
    name: 'Time Fracture',
    techniqueId: 'mosaic',
    params: {
      columns: 24,
      rows: 14,
      scale: 1,
      spacing: 0.02,
      lumToScale: 0,
      tileMode: 'tile',
      offsetMode: 'random',
      maxOffsetSec: 2,
      falloff: 1,
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'fracture-bass-offset',
        enabled: true,
        source: 'bass',
        target: 'maxOffsetSec',
        amount: 0.5,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null,
      },
    ],
    builtin: true,
  },
  {
    // System preset (spec §50): the image loses modules as energy rises —
    // disintegration by threshold and scatter, not a fire simulation.
    id: 'builtin-slow-burn',
    name: 'Slow Burn',
    techniqueId: 'mosaic',
    params: {
      columns: 96,
      rows: 54,
      scale: 1.15,
      spacing: 0.08,
      lumToScale: 0.9,
      threshold: 0.05,
      contrast: 1.2,
      randomRotation: 0.08,
      tileMode: 'off',
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'burn-time-threshold',
        enabled: true,
        source: 'time',
        target: 'threshold',
        amount: 0.55,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.15,
        curve: 'linear',
        frozenValue: null,
      },
      {
        id: 'burn-master-scatter',
        enabled: true,
        source: 'master',
        target: 'jitterX',
        amount: 0.35,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.3,
        curve: 'linear',
        frozenValue: null,
      },
      {
        id: 'burn-transient-scatter',
        enabled: true,
        source: 'transients',
        target: 'jitterY',
        amount: 0.3,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.1,
        curve: 'exponential',
        frozenValue: null,
      },
    ],
    builtin: true,
  },
  {
    // Official system preset (Phase 5 creative review): beat-quarter pump —
    // invert + exponential gives the rise-and-snap. Needs BPM set.
    id: 'builtin-pump',
    name: 'Pump',
    techniqueId: 'mosaic',
    params: { columns: 64, rows: 36, scale: 1, spacing: 0.12, lumToScale: 0.9 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'pump-beat-scale',
        enabled: true,
        source: 'beat:1/4',
        target: 'scale',
        amount: -0.3,
        min: 0,
        max: 1,
        invert: true,
        smoothing: 0.05,
        curve: 'exponential',
        frozenValue: null,
      },
    ],
    builtin: true,
  },
];

const AUDIO_SOURCES = new Set(['master', 'rms', 'bass', 'mids', 'highs', 'transients']);

/**
 * What a preset needs from the project to actually do something.
 * Derived from the preset's own content so nothing has to be declared twice.
 */
export function presetRequirements(preset: Preset): { video: boolean; audio: boolean; bpm: boolean } {
  const temporalTechniques = new Set(['echo', 'step-print', 'slit-scan']);
  return {
    video: preset.params.tileMode === 'tile' || temporalTechniques.has(preset.techniqueId),
    audio: preset.modulations.some((m) => AUDIO_SOURCES.has(m.source)),
    bpm: preset.modulations.some((m) => m.source.startsWith('beat:')),
  };
}

/** Human-readable note for a preset that needs more than the current project has. */
export function unmetRequirementNote(
  preset: Preset,
  project: { hasVideo: boolean; hasAudio: boolean; hasBpm: boolean },
): string | null {
  const req = presetRequirements(preset);
  const missing: string[] = [];
  if (req.video && !project.hasVideo) missing.push('a video source');
  if (req.audio && !project.hasAudio) missing.push('an audio source');
  if (req.bpm && !project.hasBpm) missing.push('a BPM');
  if (missing.length === 0) return null;
  return `Needs ${missing.join(' and ')}`;
}

export async function listAllPresets(): Promise<Preset[]> {
  try {
    const user = await window.material.listPresets();
    return [...BUILTIN_PRESETS, ...user];
  } catch (err) {
    reportError('List presets', err);
    return BUILTIN_PRESETS;
  }
}

export function applyPreset(preset: Preset): void {
  useProjectStore.getState().apply((p) => {
    const base = withTechniqueEnsured(p);
    return {
      ...base,
      techniques: base.techniques.map((t, i) =>
        i === 0
          ? { ...t, techniqueId: preset.techniqueId, params: { ...t.params, ...preset.params } }
          : t,
      ),
      material: preset.material,
      modulations: preset.modulations,
    };
  });
}

export async function saveCurrentAsPreset(name: string): Promise<Preset | null> {
  const { project } = useProjectStore.getState();
  const technique = project.techniques.find((t) => t.enabled);
  if (!technique) {
    useUiStore.getState().pushToast('info', 'Nothing to save as a preset');
    return null;
  }
  const preset: Preset = {
    id: uid('preset'),
    name,
    techniqueId: technique.techniqueId,
    params: technique.params,
    material: project.material,
    modulations: project.modulations,
    builtin: false,
  };
  try {
    await window.material.savePreset(preset);
    useUiStore.getState().pushToast('info', `Preset "${name}" saved`);
    return preset;
  } catch (err) {
    reportError('Save preset', err);
    return null;
  }
}
