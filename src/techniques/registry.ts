import type { TechniqueDefinition } from './types';
import { mosaicDefinition } from './mosaic/definition';

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
