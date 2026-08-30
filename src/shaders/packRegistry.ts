import type { LoadedPack, LoadedShader } from '@shared/schemas/shaderPack';
import { customTechniqueId } from '@shared/schemas/shaderPack';
import { registerTechnique, unregisterTechnique } from '@/techniques/registry';
import { customTechniqueDefinition } from './customTechnique';

/**
 * v0.5A — installed packs, and the techniques they contribute.
 *
 * One place decides what exists. Registering a pack turns each of its shaders
 * into a TechniqueDefinition; removing one takes those definitions back out.
 * Nothing else in the app needs to know a technique came from a pack — that is
 * the whole point of routing through the existing registry.
 */

const packs = new Map<string, LoadedPack>();
const listeners = new Set<() => void>();
/** Last compile state per technique id, for the inspector's error surface. */
const compileErrors = new Map<string, string>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribePacks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerPack(pack: LoadedPack): void {
  // Replacing a pack must take its OLD techniques out first, or a shader
  // deleted between versions would linger as a phantom entry.
  const previous = packs.get(pack.id);
  if (previous) for (const s of previous.shaders) unregisterTechnique(idOf(s));
  packs.set(pack.id, pack);
  for (const shader of pack.shaders) {
    const techniqueId = idOf(shader);
    compileErrors.delete(techniqueId);
    registerTechnique(
      customTechniqueDefinition(shader, (state) => {
        if (state.status === 'error' && state.message) compileErrors.set(techniqueId, state.message);
        else compileErrors.delete(techniqueId);
        notify();
      }),
    );
  }
  notify();
}

export function removePack(packId: string): void {
  const pack = packs.get(packId);
  if (!pack) return;
  for (const s of pack.shaders) {
    unregisterTechnique(idOf(s));
    compileErrors.delete(idOf(s));
  }
  packs.delete(packId);
  notify();
}

export function listPacks(): LoadedPack[] {
  return [...packs.values()];
}

export function getPack(packId: string): LoadedPack | null {
  return packs.get(packId) ?? null;
}

export function findShader(packId: string, shaderId: string): LoadedShader | null {
  return packs.get(packId)?.shaders.find((s) => s.entry.id === shaderId) ?? null;
}

export function compileErrorFor(techniqueId: string | null): string | null {
  return techniqueId ? (compileErrors.get(techniqueId) ?? null) : null;
}

/** Every installed shader, flattened — what the Output needs to mirror. */
export function allShaders(): LoadedShader[] {
  return [...packs.values()].flatMap((p) => p.shaders);
}

function idOf(shader: LoadedShader): string {
  return customTechniqueId(shader.packId, shader.entry.id);
}
