import type { TechniqueDefinition } from './types';
import { mosaicDefinition } from './mosaic/definition';
import { echoDefinition } from './echo/definition';
import { slitScanDefinition } from './slit-scan/definition';
import { stepPrintDefinition } from './step-print/definition';
import { feedbackDefinitions } from './feedback/definitions';
import { timeFieldDefinition } from './time-field/definition';
import { motionDefinitions } from './motion/definitions';

const registry = new Map<string, TechniqueDefinition>();

export function registerTechnique(definition: TechniqueDefinition): void {
  registry.set(definition.id, definition);
}

export function getTechnique(id: string): TechniqueDefinition | null {
  return registry.get(id) ?? null;
}

export function listTechniques(): TechniqueDefinition[] {
  return [...registry.values()];
}

registerTechnique(mosaicDefinition);
registerTechnique(echoDefinition);
registerTechnique(stepPrintDefinition);
for (const d of feedbackDefinitions) registerTechnique(d);
registerTechnique(timeFieldDefinition);
// CE1D-2: primitive ACCEPTED — GPU harness self-tests pass and the
// synthetic goldens are green (cardinal signs, ±3% velocity at 2px,
// LSB-level noise floor). See docs/GPU_TESTING.md + DECISIONS ADR.
for (const d of motionDefinitions) registerTechnique(d);
registerTechnique(slitScanDefinition);

/** Techniques that need composition-time frame history. */
const TEMPORAL_TECHNIQUES = new Set(['echo', 'step-print', 'slit-scan', 'time-field']);

export function techniqueNeedsTemporal(id: string | null, params: { tileMode?: unknown }): boolean {
  if (!id) return false;
  if (TEMPORAL_TECHNIQUES.has(id)) return true;
  // Mosaic only needs history in Video Tile mode.
  return id === 'mosaic' && params.tileMode === 'tile';
}
