import type { LoadedPack } from '@shared/schemas/shaderPack';
import { reportError } from '@/state/uiStore';
import { listPacks, registerPack, removePack } from './packRegistry';
import { loadBuiltinPacks } from './builtinPack';

/**
 * v0.5B — installed packs, from disk into the technique registry.
 *
 * Loading is lazy in the sense that matters: reading a manifest and holding
 * GLSL text is cheap and happens at startup, but nothing is COMPILED until a
 * shader is actually selected. A machine with fifty installed shaders pays for
 * fifty strings, not fifty GPU programs.
 */

const BUILTIN_IDS = new Set(loadBuiltinPacks().map((p) => p.id));

/** True for packs that ship inside the app and cannot be removed. */
export function isBuiltinPack(packId: string): boolean {
  return BUILTIN_IDS.has(packId);
}

export async function refreshInstalledPacks(): Promise<LoadedPack[]> {
  let installed: LoadedPack[] = [];
  try {
    installed = await window.material.listShaderPacks();
  } catch (err) {
    // A pack folder that cannot be read must never stop the app: the built-in
    // pack is already registered and the rest of MATERIAL does not care.
    reportError('Shader packs', err);
    return listPacks();
  }
  for (const pack of installed) {
    if (isBuiltinPack(pack.id)) {
      // An installed pack must not shadow one that ships with the app —
      // otherwise a project could silently render a different shader.
      pack.warnings.push('ignored: this id belongs to a pack that ships with MATERIAL');
      continue;
    }
    registerPack(pack);
  }
  return listPacks();
}

export async function importPack(): Promise<{ ok: boolean; error?: string }> {
  const result = await window.material.importShaderPack();
  if (!result.ok) return { ok: false, ...(result.error ? { error: result.error } : {}) };
  if (result.pack) {
    if (isBuiltinPack(result.pack.id)) {
      return { ok: false, error: 'that pack id belongs to a pack that ships with MATERIAL' };
    }
    registerPack(result.pack);
  }
  return { ok: true };
}

export async function uninstallPack(packId: string): Promise<void> {
  if (isBuiltinPack(packId)) return;
  const result = await window.material.removeShaderPack(packId);
  if (!result.ok) {
    reportError('Shader packs', new Error(result.error ?? 'could not remove the pack'));
    return;
  }
  // A project still using it keeps its settings and shows the missing-pack
  // placeholder — removing a pack must never damage a document.
  removePack(packId);
}

export async function reloadPack(packId: string): Promise<void> {
  if (isBuiltinPack(packId)) return;
  const installed = await window.material.listShaderPacks().catch(() => []);
  const found = installed.find((p) => p.id === packId);
  if (found) registerPack(found);
}
