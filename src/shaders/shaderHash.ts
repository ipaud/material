import type { ShaderEntry } from '@shared/schemas/shaderPack';

/**
 * v0.5A — a stable content hash over a shader's source AND its parameter
 * contract.
 *
 * Both halves matter. Source alone would miss a pack that renamed a parameter
 * or moved a range, which changes what a saved project's stored values mean.
 * The hash is machinery, never a human identifier: it drives recompilation,
 * the Output's cache, and the version-mismatch warning a project shows when
 * the installed pack is no longer the one it was authored against.
 *
 * FNV-1a: not cryptographic, and not used for anything that needs to be. Pack
 * content is never trusted on the strength of a hash — it is validated.
 */
export function shaderHash(entry: ShaderEntry, fragment: string): string {
  const contract = JSON.stringify({
    id: entry.id,
    params: entry.params.map((p) =>
      p.type === 'enum'
        ? { i: p.id, t: p.type, o: p.options.map((o) => o.value), d: p.default }
        : p.type === 'bool'
          ? { i: p.id, t: p.type, d: p.default }
          : { i: p.id, t: p.type, min: p.min, max: p.max, d: p.default },
    ),
  });
  return `${fnv1a(fragment)}-${fnv1a(contract)}`;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
