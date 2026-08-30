import {
  PACK_LIMITS,
  shaderPackManifestSchema,
  type LoadedPack,
  type LoadedShader,
} from '@shared/schemas/shaderPack';
import { shaderHash } from './shaderHash';

/**
 * v0.5A — the starter pack ships INSIDE the app, in the same on-disk format an
 * author would write by hand.
 *
 * That is deliberate dogfooding: the built-in shaders go through the same
 * manifest schema, the same parameter validation and the same host contract as
 * anything imported later. If the format is awkward to author, it is awkward
 * here first.
 */

// The renderer root is `src/`, so the bundled packs are addressed relatively.
const manifestModules = import.meta.glob('../../resources/shader-packs/*/material-pack.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const fragmentModules = import.meta.glob('../../resources/shader-packs/*/shaders/*.frag', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export function loadBuiltinPacks(): LoadedPack[] {
  const out: LoadedPack[] = [];
  for (const [manifestPath, raw] of Object.entries(manifestModules)) {
    const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
    const parsed = shaderPackManifestSchema.safeParse(raw);
    if (!parsed.success) {
      // A built-in pack that does not validate is a build error, not a runtime
      // surprise — but it must never take the app down with it.
      console.error(`[shader-pack] built-in pack ${dir} is invalid`, parsed.error.issues);
      continue;
    }
    const manifest = parsed.data;
    const warnings: string[] = [];
    const shaders: LoadedShader[] = [];
    for (const entry of manifest.shaders) {
      const fragment = fragmentModules[`${dir}/${entry.file}`];
      if (fragment === undefined) {
        warnings.push(`${entry.id}: missing ${entry.file}`);
        continue;
      }
      if (fragment.length > PACK_LIMITS.maxShaderBytes) {
        warnings.push(`${entry.id}: source exceeds ${PACK_LIMITS.maxShaderBytes} bytes`);
        continue;
      }
      shaders.push({
        packId: manifest.id,
        packName: manifest.name,
        packVersion: manifest.version,
        entry,
        fragment,
        hash: shaderHash(entry, fragment),
      });
    }
    out.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      dir,
      shaders,
      warnings,
    });
  }
  return out;
}
