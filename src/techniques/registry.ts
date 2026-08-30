import type { TechniqueDefinition } from './types';
import { parseCustomTechniqueId } from '@shared/schemas/shaderPack';
import { missingShaderDefinition } from '@/shaders/customTechnique';
import { mosaicDefinition } from './mosaic/definition';
import { echoDefinition } from './echo/definition';
import { slitScanDefinition } from './slit-scan/definition';
import { stepPrintDefinition } from './step-print/definition';
import { feedbackDefinitions } from './feedback/definitions';
import { timeFieldDefinition } from './time-field/definition';
import { motionDefinitions } from './motion/definitions';
import { simulationDefinitions } from './simulation/definitions';

const registry = new Map<string, TechniqueDefinition>();
/** Placeholders are cached so a project's technique identity stays stable
 * across frames while a pack is missing. */
const missing = new Map<string, TechniqueDefinition>();

export function registerTechnique(definition: TechniqueDefinition): void {
  registry.set(definition.id, definition);
}

export function unregisterTechnique(id: string): void {
  registry.delete(id);
}

/**
 * v0.5: a project may name a shader whose pack is not installed — moved to
 * another machine, removed, not yet imported. Rather than returning null and
 * leaving every caller to invent its own behaviour, the registry answers with
 * a placeholder that passes the frame through and says what is missing. The
 * project's own parameter values are untouched and come back when the pack
 * does.
 */
export function getTechnique(id: string): TechniqueDefinition | null {
  const found = registry.get(id);
  if (found) return found;
  if (parseCustomTechniqueId(id)) {
    let placeholder = missing.get(id);
    if (!placeholder) {
      placeholder = missingShaderDefinition(id);
      missing.set(id, placeholder);
    }
    return placeholder;
  }
  return null;
}

/** True when this id resolves only to the missing-pack placeholder. */
export function isMissingTechnique(id: string | null): boolean {
  if (!id) return false;
  return parseCustomTechniqueId(id) !== null && !registry.has(id);
}

/** Built-in techniques plus every installed pack shader. */
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
for (const d of simulationDefinitions) registerTechnique(d);
registerTechnique(slitScanDefinition);

/** Techniques that need composition-time frame history. */
const TEMPORAL_TECHNIQUES = new Set(['echo', 'step-print', 'slit-scan', 'time-field']);

export function techniqueNeedsTemporal(id: string | null, params: { tileMode?: unknown }): boolean {
  if (!id) return false;
  if (TEMPORAL_TECHNIQUES.has(id)) return true;
  // Mosaic only needs history in Video Tile mode.
  return id === 'mosaic' && params.tileMode === 'tile';
}
