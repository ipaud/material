import { z } from 'zod';

/**
 * v0.5A — the data model for externally authored shaders.
 *
 * A shader pack is DATA + GLSL + METADATA. There is deliberately no place in
 * this schema for executable code: no JavaScript, no HTML, no React, no entry
 * point. Everything a pack can do, it does by declaring parameters that
 * MATERIAL renders and drives itself. That is what keeps the extension
 * surface bounded — a pack extends the visual vocabulary without being handed
 * the application.
 */

/** The host contract a pack is written against. Bumped only on a breaking
 * change to uniforms, UV orientation, GLSL version or parameter semantics. */
export const SHADER_CONTRACT_VERSION = 1;

/** Identifiers must be usable as GLSL identifier fragments, so the generated
 * uniform name is predictable and cannot inject anything. */
const identifier = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'must start with a letter and contain only letters, digits, _');

/** Reverse-domain or slug, stable across versions. */
const packId = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, 'lowercase slug or reverse-domain, no spaces');

const groupSchema = z.enum(['Structure', 'Time', 'Motion', 'Color', 'Mix']);

const commonParam = {
  id: identifier,
  label: z.string().min(1).max(48),
  /** Which inspector section it lands in. Pack authors pick from the product's
   * own list; arbitrary section names would fragment the UI. */
  group: groupSchema.default('Structure'),
  /** Host policy still applies: a pack cannot mark something modulatable that
   * the host does not know how to modulate. */
  modulatable: z.boolean().default(true),
  explorable: z.boolean().default(true),
};

/** Numeric ranges are mandatory. An unbounded float slider is not a control. */
const shaderParamUnion = z.discriminatedUnion('type', [
  z.object({
    ...commonParam,
    type: z.literal('float'),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive().optional(),
    default: z.number().finite(),
  }),
  z.object({
    ...commonParam,
    type: z.literal('int'),
    min: z.number().int(),
    max: z.number().int(),
    default: z.number().int(),
  }),
  z.object({
    ...commonParam,
    type: z.literal('bool'),
    default: z.boolean(),
  }),
  z.object({
    ...commonParam,
    type: z.literal('enum'),
    /** Stored as the option VALUE, never the label — a pack may rename a label
     * without silently changing what every saved project means. */
    options: z
      .array(z.object({ value: identifier, label: z.string().min(1).max(48) }))
      .min(2)
      .max(16),
    default: identifier,
  }),
]);

/**
 * Field-by-field validation is not enough: a parameter can be individually
 * well-formed and still be nonsense as a whole. `min: 1, max: 0` produces a
 * control with no valid position, and a default outside its own range makes
 * every project that stores it disagree with the pack that declared it.
 *
 * v0.5B found the first of these by trying it, which is why the check is here
 * — in the contract — rather than in the loader that noticed.
 */
export const shaderParamSchema = shaderParamUnion.superRefine((param, ctx) => {
  if (param.type === 'float' || param.type === 'int') {
    if (param.min > param.max) {
      ctx.addIssue({ code: 'custom', message: `min (${param.min}) is greater than max (${param.max})` });
    }
    if (param.default < param.min || param.default > param.max) {
      ctx.addIssue({
        code: 'custom',
        message: `default (${param.default}) is outside [${param.min}, ${param.max}]`,
      });
    }
  }
  if (param.type === 'enum' && !param.options.some((o) => o.value === param.default)) {
    ctx.addIssue({ code: 'custom', message: `default '${param.default}' is not one of the options` });
  }
});
export type ShaderParamDef = z.infer<typeof shaderParamSchema>;

export const shaderPresetSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(48),
  /** Params only. A pack preset cannot carry modulation mappings: those name
   * signals and targets that belong to the host, and a pack that shipped them
   * would break the moment either changed. */
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
});
export type ShaderPreset = z.infer<typeof shaderPresetSchema>;

export const shaderEntrySchema = z.object({
  id: identifier,
  name: z.string().min(1).max(64),
  description: z.string().max(280).default(''),
  /** Path RELATIVE to the pack root. Validated again at read time; a manifest
   * cannot reach outside its own directory. */
  file: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/, 'relative path, no .. and no leading /')
    .refine((p) => !p.split('/').includes('..'), 'path must not contain ..'),
  params: z.array(shaderParamSchema).max(32).default([]),
  presets: z.array(shaderPresetSchema).max(16).default([]),
});
export type ShaderEntry = z.infer<typeof shaderEntrySchema>;

export const shaderPackManifestSchema = z.object({
  /** Manifest format, separate from the shader contract version. */
  format: z.literal(1),
  materialShaderVersion: z.literal(SHADER_CONTRACT_VERSION),
  id: packId,
  name: z.string().min(1).max(64),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'semantic version, e.g. 1.0.0'),
  author: z.string().max(96).default(''),
  description: z.string().max(280).default(''),
  shaders: z.array(shaderEntrySchema).min(1).max(64),
});
export type ShaderPackManifest = z.infer<typeof shaderPackManifestSchema>;

/** A pack as the renderer sees it: manifest plus the GLSL already read. */
export interface LoadedShader {
  packId: string;
  packName: string;
  packVersion: string;
  entry: ShaderEntry;
  fragment: string;
  /** Content hash of the fragment source plus its parameter contract. */
  hash: string;
}

export interface LoadedPack {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  dir: string;
  shaders: LoadedShader[];
  /** Non-fatal problems: a shader that failed to read, an entry rejected. */
  warnings: string[];
}

/** The technique id a custom shader occupies in the existing registry. */
export function customTechniqueId(packId: string, shaderId: string): string {
  return `custom:${packId}:${shaderId}`;
}

export function parseCustomTechniqueId(
  id: string,
): { packId: string; shaderId: string } | null {
  if (!id.startsWith('custom:')) return null;
  const rest = id.slice('custom:'.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { packId: rest.slice(0, sep), shaderId: rest.slice(sep + 1) };
}

/** Bounds that keep a pack from being a denial-of-service by accident. */
export const PACK_LIMITS = {
  /** One shader's GLSL. Large enough for anything hand-written. */
  maxShaderBytes: 256 * 1024,
  maxManifestBytes: 256 * 1024,
  maxShadersPerPack: 64,
  maxParamsPerShader: 32,
  maxFilesScanned: 512,
} as const;
