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
// CE1D status: the optical-flow primitive is proven live on GPU consumers
// (camera hue-view QA), but the numeric golden harness (CPU readback of
// class-owned render targets) produced contradictory measurements and the
// synthetic-fixture acceptance gates (§92-93) could not be closed. The
// Motion Pack therefore stays UNREGISTERED — experimental, compiled and
// unit-covered, shipped to users only after CE1D-2 lands a GPU-verified
// golden harness. See docs/DECISIONS.md (CE1D forensic note).
// for (const d of motionDefinitions) registerTechnique(d);
void motionDefinitions;
registerTechnique(slitScanDefinition);

/** Techniques that need composition-time frame history. */
const TEMPORAL_TECHNIQUES = new Set(['echo', 'step-print', 'slit-scan', 'time-field']);

export function techniqueNeedsTemporal(id: string | null, params: { tileMode?: unknown }): boolean {
  if (!id) return false;
  if (TEMPORAL_TECHNIQUES.has(id)) return true;
  // Mosaic only needs history in Video Tile mode.
  return id === 'mosaic' && params.tileMode === 'tile';
}
