import type { Preset } from '@shared/schemas/preset';
import { customTechniqueId } from '@shared/schemas/shaderPack';
import { listPacks } from './packRegistry';

/**
 * v0.5C — a pack's presets, as ordinary presets.
 *
 * The manifest may declare presets, and they are PARAMS ONLY by design. A pack
 * preset that carried modulation mappings would name signals and targets that
 * belong to the host, and would break the moment either changed; worse, it
 * would let a pack write into a part of the project it has no business
 * touching. Params travel; opinions about the rest of the document do not.
 *
 * Values are validated against the shader's own declared parameters, so a
 * preset cannot introduce a key the shader does not have or a value its type
 * does not allow.
 */
export function packPresets(): Preset[] {
  const out: Preset[] = [];
  for (const pack of listPacks()) {
    for (const shader of pack.shaders) {
      const declared = new Map(shader.entry.params.map((p) => [p.id, p]));
      for (const preset of shader.entry.presets) {
        const params: Record<string, number | boolean | string> = {};
        for (const [key, value] of Object.entries(preset.params)) {
          const def = declared.get(key);
          if (!def) continue;
          if (def.type === 'bool' && typeof value === 'boolean') params[key] = value;
          else if (def.type === 'enum' && def.options.some((o) => o.value === value)) params[key] = value;
          else if ((def.type === 'float' || def.type === 'int') && typeof value === 'number') {
            params[key] = Math.min(Math.max(value, def.min), def.max);
          }
        }
        out.push({
          id: `pack:${pack.id}:${shader.entry.id}:${preset.id}`,
          name: `${shader.entry.name} — ${preset.name}`,
          techniqueId: customTechniqueId(pack.id, shader.entry.id),
          params,
          material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
          modulations: [],
          triggers: [],
          builtin: true,
          category: 'Reactive',
          description: shader.entry.description || `${pack.name} preset`,
          tags: ['shader-pack', pack.id],
        });
      }
    }
  }
  return out;
}
