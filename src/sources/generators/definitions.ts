import type { NumberParamDef, ParamDef } from '@/techniques/types';

/**
 * CE1F — generator definitions. A generator is a SOURCE: it produces
 * pixels for a technique to consume, exactly like a file or a camera. Its
 * parameters use the SAME ParamDef vocabulary as techniques, so the
 * existing modulation/Explore/inspector machinery works on them with no
 * second engine (targets are namespaced `source.<id>`, see modulation).
 */

export type GeneratorKind =
  | 'noise'
  | 'waves'
  | 'voronoi'
  | 'grid'
  | 'chladni'
  | 'reaction-diffusion'
  | 'cellular';

export interface GeneratorDefinition {
  id: GeneratorKind;
  name: string;
  description: string;
  /** stateless = pure f(time, params, seed); simulation = CE1E stepping. */
  mode: 'stateless' | 'simulation';
  params: ParamDef[];
}

const num = (
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  modulatable = true,
  explore?: { min: number; max: number },
): NumberParamDef =>
  ({
    type: 'number',
    id,
    label,
    min,
    max,
    step,
    default: def,
    modulatable,
    explore: explore ? { randomizable: true, ...explore } : { randomizable: false },
  }) as NumberParamDef;

export const GENERATORS: GeneratorDefinition[] = [
  {
    id: 'noise',
    name: 'Noise Field',
    description: 'Layered value noise with optional domain warp — clouds, grain, marble, storms.',
    mode: 'stateless',
    params: [
      num('scale', 'Scale', 0.5, 24, 0.1, 4, true, { min: 1, max: 12 }),
      num('speed', 'Speed', 0, 2, 0.01, 0.2, true, { min: 0, max: 1 }),
      num('detail', 'Detail', 1, 6, 1, 3, true, { min: 1, max: 5 }),
      num('warp', 'Warp', 0, 2, 0.01, 0, true, { min: 0, max: 1.2 }),
      num('contrast', 'Contrast', 0.2, 4, 0.01, 1, true, { min: 0.6, max: 2.5 }),
    ],
  },
  {
    id: 'waves',
    name: 'Wave Interference',
    description: 'Overlapping circular waves — ripples, standing patterns, moiré fields.',
    mode: 'stateless',
    params: [
      num('frequency', 'Frequency', 1, 60, 0.5, 14, true, { min: 4, max: 40 }),
      num('count', 'Sources', 1, 8, 1, 3, true, { min: 2, max: 6 }),
      num('speed', 'Speed', 0, 3, 0.01, 0.6, true, { min: 0, max: 2 }),
      num('spread', 'Spread', 0.05, 1, 0.01, 0.45, true, { min: 0.1, max: 0.8 }),
      num('contrast', 'Contrast', 0.2, 4, 0.01, 1.2, true),
    ],
  },
  {
    id: 'voronoi',
    name: 'Voronoi',
    description: 'Cellular partitions that drift — crystals, networks, microcells.',
    mode: 'stateless',
    params: [
      num('scale', 'Scale', 1, 40, 0.5, 8, true, { min: 3, max: 24 }),
      num('jitter', 'Jitter', 0, 1, 0.01, 0.9, true, { min: 0.3, max: 1 }),
      num('speed', 'Speed', 0, 2, 0.01, 0.25, true, { min: 0, max: 1 }),
      num('edge', 'Edges', 0, 1, 0.01, 0, true, { min: 0, max: 1 }),
      num('contrast', 'Contrast', 0.2, 4, 0.01, 1, true),
    ],
  },
  {
    id: 'grid',
    name: 'Grid',
    description: 'Precise procedural grids — lines, dots, crosses, checkers.',
    mode: 'stateless',
    params: [
      num('scale', 'Scale', 1, 80, 1, 12, true, { min: 4, max: 40 }),
      num('width', 'Line Width', 0.01, 0.5, 0.005, 0.08, true, { min: 0.02, max: 0.3 }),
      num('rotation', 'Rotation', -180, 180, 1, 0, true, { min: -45, max: 45 }),
      num('offsetX', 'Offset X', -1, 1, 0.01, 0, true),
      num('offsetY', 'Offset Y', -1, 1, 0.01, 0, true),
      num('mode', 'Mode', 0, 3, 1, 0, false), // 0 lines 1 dots 2 cross 3 checker
    ],
  },
  {
    id: 'chladni',
    name: 'Chladni Field',
    description:
      'Standing-wave plate patterns from two integer modes — nodal lines, lattices, resonance figures.',
    mode: 'stateless',
    params: [
      num('modeX', 'Mode X', 1, 12, 1, 3, true, { min: 1, max: 9 }),
      num('modeY', 'Mode Y', 1, 12, 1, 5, true, { min: 1, max: 9 }),
      num('threshold', 'Threshold', 0.01, 0.6, 0.005, 0.08, true, { min: 0.02, max: 0.3 }),
      num('softness', 'Softness', 0, 1, 0.01, 0.25, true),
      num('phase', 'Phase', 0, 2, 0.01, 0.15, true, { min: 0, max: 1 }),
    ],
  },
  {
    id: 'reaction-diffusion',
    name: 'Reaction Diffusion',
    description: 'The CE1E chemistry solver as a source — coral, worms, mazes, spores.',
    mode: 'simulation',
    params: [
      num('feed', 'Feed', 0.01, 0.09, 0.0005, 0.055, true, { min: 0.02, max: 0.08 }),
      num('kill', 'Kill', 0.045, 0.07, 0.0002, 0.062, true, { min: 0.05, max: 0.068 }),
      num('speed', 'Speed', 1, 8, 1, 4, true, { min: 2, max: 6 }),
      num('contrast', 'Contrast', 0.5, 6, 0.05, 2.4, true),
      num('grid', 'Scale', 128, 512, 64, 320, false),
      num('density', 'Seed Density', 0.01, 0.4, 0.005, 0.06, false),
    ],
  },
  {
    id: 'cellular',
    name: 'Cellular',
    description: 'The CE1E life-like automaton as a source — colonies, mazes, emergence.',
    mode: 'simulation',
    params: [
      {
        type: 'select',
        id: 'rule',
        label: 'Rule',
        options: [
          { value: 'life', label: 'Life' },
          { value: 'highlife', label: 'HighLife' },
          { value: 'seeds', label: 'Seeds' },
          { value: 'maze', label: 'Maze' },
          { value: 'daynight', label: 'Day & Night' },
        ],
        default: 'life',
        explore: { randomizable: true },
      },
      num('grid', 'Grid', 64, 512, 64, 256, false),
      num('density', 'Density', 0.01, 0.6, 0.01, 0.28, false),
    ],
  },
];

export function getGenerator(id: string): GeneratorDefinition | null {
  return GENERATORS.find((g) => g.id === id) ?? null;
}

/** Defaults for a generator's parameter record. */
export function generatorDefaults(id: string): Record<string, number | string | boolean> {
  const def = getGenerator(id);
  if (!def) return {};
  const out: Record<string, number | string | boolean> = {};
  for (const p of def.params) out[p.id] = p.default;
  return out;
}

/** CE1F: source params share the modulation namespace under `source.`. */
export const SOURCE_PARAM_PREFIX = 'source.';
export const sourceTarget = (paramId: string): string => `${SOURCE_PARAM_PREFIX}${paramId}`;
export const isSourceTarget = (target: string): boolean =>
  target.startsWith(SOURCE_PARAM_PREFIX);
export const sourceParamId = (target: string): string =>
  target.slice(SOURCE_PARAM_PREFIX.length);
