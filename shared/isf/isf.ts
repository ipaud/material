import type { ShaderEntry, ShaderParamDef } from '../schemas/shaderPack';

/**
 * v0.5D — the ISF single-pass image-filter subset.
 *
 * MATERIAL hosts a deliberately narrow slice of ISF: one image input, one
 * pass, and the input types that map cleanly onto controls MATERIAL already
 * has. That is not a stepping stone to "full ISF" — it is the part of ISF that
 * fits this application's architecture without bending it.
 *
 * What is deliberately NOT here, and why:
 *
 *  - **PASSES / multipass.** Multiple render targets, PASSINDEX, per-pass
 *    sizing and a lifecycle of their own. MATERIAL already has primitives for
 *    exactly that shape of problem (FEEDBACK, HISTORY, SIMULATION) with their
 *    own export preroll and VRAM accounting. A second, parallel one imported
 *    from a file format would be two systems disagreeing.
 *  - **PERSISTENT buffers.** Same reason, more sharply: persistent state is
 *    what makes export determinism hard, and MATERIAL's is already solved.
 *  - **Multiple image inputs.** The host contract provides one source texture.
 *  - **Audio / audioFFT inputs.** MATERIAL's audio analysis is a signal that
 *    drives parameters, which is a better fit than a texture of samples.
 *  - **event inputs, color, point2D.** No host control maps to them yet.
 *
 * Every one of those is DETECTED and reported by name. An import that cannot
 * be honoured says which feature stopped it.
 */

export const ISF_SUPPORTED_INPUT_TYPES = ['float', 'bool', 'long', 'image'] as const;

export interface IsfConversion {
  ok: boolean;
  /** Why the file cannot be hosted, named by ISF feature. */
  errors: string[];
  /** Honoured, but worth telling the user about. */
  warnings: string[];
  name: string;
  description: string;
  credit: string;
  params: ShaderParamDef[];
  /** Body ready for the MATERIAL host: prelude + the original source. */
  fragment: string;
}

interface IsfInput {
  NAME?: unknown;
  TYPE?: unknown;
  LABEL?: unknown;
  DEFAULT?: unknown;
  MIN?: unknown;
  MAX?: unknown;
  VALUES?: unknown;
  LABELS?: unknown;
}

interface IsfHeader {
  DESCRIPTION?: unknown;
  CREDIT?: unknown;
  ISFVSN?: unknown;
  INPUTS?: unknown;
  PASSES?: unknown;
  IMPORTED?: unknown;
  PERSISTENT_BUFFERS?: unknown;
}

/**
 * The ISF compatibility prelude.
 *
 * A translation layer, not a compiler. ISF's automatic variables and IMG_*
 * helpers become `#define`s over uniforms the MATERIAL host already provides,
 * which is why an ISF file's own source text is passed through untouched — the
 * fewer edits made to a shader nobody here wrote, the fewer ways to break it.
 */
export const ISF_PRELUDE = `// ---- ISF compatibility (single-pass image filter subset) -----------------
#define texture2D texture
#define textureRect texture
#define varying in
// The MATERIAL host already declares the one fragment output. Declaring a
// second here produced 'must explicitly specify all locations when using
// multiple fragment outputs' on every import — ISF's gl_FragColor is simply
// the host's own output under another name.
#define gl_FragColor fragColor

// ISF automatic variables, mapped onto the MATERIAL host contract.
#define TIME uMaterial_time
#define RENDERSIZE uMaterial_resolution
#define isf_FragNormCoord vUv
// Single pass, always: PASSINDEX exists so shaders that branch on it compile,
// and it is always the first and only pass.
const int PASSINDEX = 0;
// The primary ISF image input IS the frame this technique receives.
#define inputImage uMaterial_source

vec4 IMG_NORM_PIXEL(sampler2D img, vec2 nc) { return texture(img, nc); }
vec4 IMG_THIS_NORM_PIXEL(sampler2D img) { return texture(img, vUv); }
vec4 IMG_THIS_PIXEL(sampler2D img) { return texture(img, vUv); }
vec4 IMG_PIXEL(sampler2D img, vec2 px) { return texture(img, px / uMaterial_resolution); }
vec2 IMG_SIZE(sampler2D img) { return uMaterial_resolution; }
// ---- ISF source ----------------------------------------------------------
`;

/** Lines the prelude adds, so a compile error still points at the ISF file. */
export const ISF_PRELUDE_LINES = ISF_PRELUDE.split('\n').length - 1;

/** Extract the JSON header ISF stores in a leading block comment. */
export function extractIsfHeader(source: string): { json: string; body: string } | null {
  const start = source.indexOf('/*');
  if (start < 0) return null;
  const end = source.indexOf('*/', start + 2);
  if (end < 0) return null;
  const inner = source.slice(start + 2, end).trim();
  if (!inner.startsWith('{')) return null;
  // Keep the body's own line numbering: the comment is replaced by blank lines
  // so an error at ISF line N is still reported at line N.
  const consumed = source.slice(0, end + 2);
  const blanks = '\n'.repeat(consumed.split('\n').length - 1);
  return { json: inner, body: blanks + source.slice(end + 2) };
}

const slug = (text: string, fallback: string): string => {
  const cleaned = text.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[^a-zA-Z]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : fallback;
};

function toParam(input: IsfInput, index: number): { param?: ShaderParamDef; error?: string } {
  const rawName = typeof input.NAME === 'string' ? input.NAME : '';
  const type = typeof input.TYPE === 'string' ? input.TYPE : '';
  const id = slug(rawName, `input${index}`);
  const label = typeof input.LABEL === 'string' && input.LABEL ? input.LABEL : rawName || id;

  if (type === 'image') return {}; // handled by the caller
  if (type === 'float') {
    const min = typeof input.MIN === 'number' ? input.MIN : 0;
    const max = typeof input.MAX === 'number' ? input.MAX : 1;
    const lo = Math.min(min, max);
    const hi = max > min ? max : min + 1;
    const def = typeof input.DEFAULT === 'number' ? input.DEFAULT : (lo + hi) / 2;
    return {
      param: {
        type: 'float',
        id,
        label,
        group: 'Structure',
        modulatable: true,
        explorable: true,
        min: lo,
        max: hi,
        default: Math.min(Math.max(def, lo), hi),
      },
    };
  }
  if (type === 'bool') {
    return {
      param: {
        type: 'bool',
        id,
        label,
        group: 'Structure',
        modulatable: true,
        explorable: true,
        default: input.DEFAULT === true || input.DEFAULT === 1,
      },
    };
  }
  if (type === 'long') {
    const values = Array.isArray(input.VALUES) ? input.VALUES.filter((v) => typeof v === 'number') : [];
    const labels = Array.isArray(input.LABELS) ? input.LABELS : [];
    if (values.length < 2) return { error: `input '${rawName}': long needs at least two VALUES` };
    const options = values.slice(0, 16).map((value, i) => ({
      value: slug(typeof labels[i] === 'string' ? (labels[i] as string) : `option${i}`, `option${i}`),
      label: typeof labels[i] === 'string' ? (labels[i] as string) : String(value),
      // ISF long values are the shader's own numbers, not indices.
      glslValue: value as number,
    }));
    // Slugified labels can collide; make them unique or the option list lies.
    const seen = new Set<string>();
    for (const o of options) {
      let candidate = o.value;
      let n = 2;
      while (seen.has(candidate)) candidate = `${o.value}_${n++}`;
      o.value = candidate;
      seen.add(candidate);
    }
    const defIndex = values.findIndex((v) => v === input.DEFAULT);
    return {
      param: {
        type: 'enum',
        id,
        label,
        group: 'Structure',
        modulatable: true,
        explorable: true,
        options,
        default: (options[defIndex >= 0 ? defIndex : 0] as { value: string }).value,
      },
    };
  }
  return { error: `input '${rawName}': ISF type '${type || 'unknown'}' is not supported` };
}

/**
 * Convert one ISF file into something the MATERIAL host can compile.
 *
 * Refusals are by NAME: an import that cannot be honoured says which ISF
 * feature stopped it, because "this shader did not load" is not a thing anyone
 * can act on.
 */
export function convertIsf(source: string, fallbackName: string): IsfConversion {
  const errors: string[] = [];
  const warnings: string[] = [];
  const extracted = extractIsfHeader(source);
  if (!extracted) {
    return {
      ok: false,
      errors: ['no ISF metadata: expected a JSON header in a leading /* ... */ comment'],
      warnings,
      name: fallbackName,
      description: '',
      credit: '',
      params: [],
      fragment: '',
    };
  }

  let header: IsfHeader;
  try {
    header = JSON.parse(extracted.json) as IsfHeader;
  } catch (err) {
    return {
      ok: false,
      errors: [`ISF metadata is not valid JSON: ${(err as Error).message}`],
      warnings,
      name: fallbackName,
      description: '',
      credit: '',
      params: [],
      fragment: '',
    };
  }

  // Unsupported ISF features, named rather than hinted at.
  if (Array.isArray(header.PASSES) && header.PASSES.length > 1) {
    errors.push(`unsupported ISF feature: MULTIPASS (${header.PASSES.length} PASSES)`);
  }
  if (Array.isArray(header.PASSES)) {
    const persistent = header.PASSES.some(
      (p) => typeof p === 'object' && p !== null && (p as { PERSISTENT?: unknown }).PERSISTENT,
    );
    if (persistent) errors.push('unsupported ISF feature: PERSISTENT_BUFFER');
  }
  if (header.PERSISTENT_BUFFERS) errors.push('unsupported ISF feature: PERSISTENT_BUFFERS');
  if (Array.isArray(header.IMPORTED) ? header.IMPORTED.length > 0 : Boolean(header.IMPORTED)) {
    errors.push('unsupported ISF feature: IMPORTED media');
  }

  const inputs: IsfInput[] = Array.isArray(header.INPUTS) ? (header.INPUTS as IsfInput[]) : [];
  const imageInputs = inputs.filter((i) => i.TYPE === 'image');
  if (imageInputs.length > 1) {
    errors.push(`unsupported ISF feature: MULTIPLE_IMAGE_INPUTS (${imageInputs.length})`);
  }
  if (imageInputs.length === 0) {
    // A generator has no image input. MATERIAL already has generator SOURCES,
    // and a technique that ignores its input is a different product shape.
    errors.push('unsupported ISF feature: GENERATOR (no image input) — v0.5 hosts image filters');
  }

  const params: ShaderParamDef[] = [];
  for (const [index, input] of inputs.entries()) {
    if (input.TYPE === 'image') continue;
    const { param, error } = toParam(input, index);
    if (error) errors.push(error);
    else if (param) params.push(param);
  }
  if (params.length > 32) {
    warnings.push(`only the first 32 inputs are exposed (${params.length} declared)`);
    params.length = 32;
  }

  // A non-primary image input name would silently sample the source; say so.
  const primary = imageInputs[0];
  const primaryName = typeof primary?.NAME === 'string' ? primary.NAME : 'inputImage';
  const alias =
    primaryName === 'inputImage' ? '' : `#define ${slug(primaryName, 'inputImage')} uMaterial_source\n`;

  // An ISF shader references its inputs by their declared NAME; the host
  // generates `uParam_<id>` from a slugified id. Bind one to the other, or
  // every input reads as an undeclared identifier.
  const bindings = inputs
    .filter((i) => i.TYPE !== 'image' && typeof i.NAME === 'string')
    .map((i, index) => {
      const name = i.NAME as string;
      const id = slug(name, `input${index}`);
      return name === `uParam_${id}` ? '' : `#define ${name} uParam_${id}\n`;
    })
    .join('');

  const version = typeof header.ISFVSN === 'string' ? header.ISFVSN : '';
  if (version.startsWith('1')) warnings.push('ISFVSN 1 metadata: treated as version 2');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    name: fallbackName,
    description: typeof header.DESCRIPTION === 'string' ? header.DESCRIPTION.slice(0, 280) : '',
    credit: typeof header.CREDIT === 'string' ? header.CREDIT.slice(0, 96) : '',
    params,
    // `#line 1` after the adapter's own prelude, so a compiler error still
    // lands on the line of the .fs file the author wrote.
    fragment: `${ISF_PRELUDE}${alias}${bindings}#line 1\n${extracted.body}`,
  };
}

/** Build the pack entry an accepted ISF file becomes. */
export function isfShaderEntry(conversion: IsfConversion, id: string, file: string): ShaderEntry {
  return {
    id,
    name: conversion.name,
    description: conversion.credit
      ? `${conversion.description}${conversion.description ? ' — ' : ''}${conversion.credit}`.slice(0, 280)
      : conversion.description,
    file,
    params: conversion.params,
    presets: [],
  };
}
