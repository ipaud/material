import type { TechniqueDefinition } from '../types';
import { SimulationTechniqueRenderer } from './SimulationTechniqueRenderer';

/**
 * CE1E — the two simulation techniques. Parameter ranges are CURATED for
 * the visually useful regions (§41): Gray-Scott's interesting behaviour
 * lives in feed 0.01–0.09 / kill 0.045–0.07 — exposing 0..1 would be
 * exposing mostly dead worlds.
 *
 * Reset-only params (grid, seedOffset, density, rule) are NOT modulatable:
 * modulating them would restart the world every frame (§87).
 */

const num = (
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  modulatable = true,
  explore?: { min: number; max: number },
) =>
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
  }) as const;

export const simulationDefinitions: TechniqueDefinition[] = [
  {
    id: 'reaction-diffusion',
    name: 'Reaction Diffusion',
    description:
      'Two chemicals feed and consume each other on a grid — coral, worms, mazes and spots emerge from two numbers.',
    category: 'image',
    chainBehavior: 'simulation',
    sections: [
      {
        label: 'Chemistry',
        params: [
          // Curated Gray-Scott window: outside this box the world dies or floods.
          num('feed', 'Feed', 0.01, 0.09, 0.0005, 0.055, true, { min: 0.02, max: 0.08 }),
          num('kill', 'Kill', 0.045, 0.07, 0.0002, 0.062, true, { min: 0.05, max: 0.068 }),
          num('speed', 'Speed', 1, 8, 1, 4, true, { min: 2, max: 6 }),
        ],
      },
      {
        label: 'World',
        params: [
          num('grid', 'Scale', 128, 512, 64, 320, false),
          num('density', 'Seed Density', 0.01, 0.4, 0.005, 0.06, false),
          num('seedOffset', 'Variation', 0, 64, 1, 0, false),
          num('contrast', 'Contrast', 0.5, 6, 0.05, 2.2, true),
          num('sourceInfluence', 'Source Influence', 0, 1, 0.01, 0, true, { min: 0, max: 0.8 }),
          num('sourceTint', 'Source Tint', 0, 1, 0.01, 0, true),
        ],
      },
    ],
    createRenderer: () => new SimulationTechniqueRenderer('reaction-diffusion'),
  },
  {
    id: 'cellular',
    name: 'Cellular',
    description:
      'Life-like cellular automata: a few birth/survival rules produce colonies, mazes and endless emergence.',
    category: 'image',
    chainBehavior: 'simulation',
    sections: [
      {
        label: 'Rule',
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
          { type: 'boolean', id: 'wrap', label: 'Wrap', default: true, explore: { randomizable: false } },
        ],
      },
      {
        label: 'World',
        params: [
          num('grid', 'Grid', 64, 512, 64, 256, false),
          num('density', 'Density', 0.01, 0.6, 0.01, 0.28, false),
          num('seedOffset', 'Variation', 0, 64, 1, 0, false),
          num('sourceTint', 'Source Tint', 0, 1, 0.01, 0, true),
        ],
      },
    ],
    createRenderer: () => new SimulationTechniqueRenderer('cellular'),
  },
];
