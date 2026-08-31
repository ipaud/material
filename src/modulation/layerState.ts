import type { ModulationMapping } from '@shared/schemas/project';
import type { TechniqueDefinition } from '@/techniques/types';
import { applyModulations, type SmoothingState } from './evaluator';

/**
 * v0.6C — modulating the LAYER rather than the technique inside it.
 *
 * `motion.amount → this video's opacity` is one of the two things layers exist
 * for, and opacity belongs to the layer, not to any technique. So the target
 * vocabulary grows one namespace:
 *
 *     layer.opacity        the layer's own opacity, 0..1
 *
 * Deliberately just the one. Blend mode is a choice from a list, not a
 * continuum, and `enabled` is a switch whose whole point is that it is not a
 * dimmer — see the note on the two of them in docs/LAYERS.md.
 *
 * The evaluation itself is NOT reimplemented here. A synthetic one-parameter
 * definition runs through `applyModulations`, so layer opacity gets Add/Set
 * composition, the single-Set rule, freeze, input windows, curves and
 * smoothing with exactly the semantics every other target has, and cannot
 * drift from them.
 */
export const LAYER_TARGET_PREFIX = 'layer.';
export const LAYER_OPACITY_TARGET = 'layer.opacity';

const LAYER_DEFINITION: TechniqueDefinition = {
  id: '__layer__',
  label: 'Layer',
  sections: [
    {
      id: 'layer',
      label: 'Layer',
      params: [
        {
          type: 'number',
          id: LAYER_OPACITY_TARGET,
          label: 'Opacity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1,
          modulatable: true,
        },
      ],
    },
  ],
} as unknown as TechniqueDefinition;

export function isLayerTarget(target: string): boolean {
  return target.startsWith(LAYER_TARGET_PREFIX);
}

/** Resolved per-frame layer state. Only what a signal is allowed to move. */
export interface LayerDynamicState {
  readonly opacity: number;
}

export function applyLayerModulations(
  stored: LayerDynamicState,
  mappings: readonly ModulationMapping[],
  sourceValues: Record<string, number>,
  smoothing: SmoothingState,
  dtSec: number,
): LayerDynamicState {
  const layerMappings = mappings.filter((m) => isLayerTarget(m.target));
  if (layerMappings.length === 0) return stored;
  const out = applyModulations(
    { [LAYER_OPACITY_TARGET]: stored.opacity },
    [...layerMappings],
    sourceValues,
    LAYER_DEFINITION,
    smoothing,
    dtSec,
  );
  const opacity = out[LAYER_OPACITY_TARGET];
  return {
    opacity: typeof opacity === 'number' ? Math.min(Math.max(opacity, 0), 1) : stored.opacity,
  };
}
