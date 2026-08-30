import type { ShaderParamDef } from '@shared/schemas/shaderPack';

/**
 * SHADER CONTRACT v1 — everything an external fragment shader may rely on.
 *
 * The rule the whole design serves: a shader receives a BOUNDED visual
 * contract. It gets a source image, where it is on screen, what time it is and
 * its own declared parameters. It does not get the filesystem, Electron, Node,
 * the DOM, app state, IPC, other shaders, or any renderer internal — because
 * none of those are reachable from GLSL and nothing here adds a bridge.
 *
 * MATERIAL owns the vertex shader. A custom shader is fragment-only, which
 * keeps the surface small enough to reason about and to keep compatible.
 */

/** Uniforms the host provides. Reserved prefix: a pack cannot declare these. */
export const HOST_UNIFORM_PREFIX = 'uMaterial_';
/** Uniforms generated from a pack's own parameters. */
export const PARAM_UNIFORM_PREFIX = 'uParam_';

export const HOST_UNIFORMS = [
  'uMaterial_source',
  'uMaterial_resolution',
  'uMaterial_time',
  'uMaterial_seed',
  'uMaterial_aspect',
] as const;

/** The uniform a declared parameter becomes. Ids are schema-validated as GLSL
 * identifiers, so this cannot produce anything but a legal name. */
export function paramUniformName(id: string): string {
  return `${PARAM_UNIFORM_PREFIX}${id}`;
}

const GLSL_TYPE: Record<ShaderParamDef['type'], string> = {
  float: 'float',
  int: 'int',
  bool: 'bool',
  // An enum is an ordinal: the project stores the option VALUE, the shader
  // receives its index. Labels never reach GLSL and never reach a save file.
  enum: 'int',
};

/**
 * MATERIAL's vertex shader. Not overridable in v0.5.
 *
 * It scales the unit quad to composition dimensions exactly as every native
 * technique does, so a custom shader sits in the same space as the rest of the
 * pipeline rather than in a parallel one.
 */
export const HOST_VERTEX = /* glsl */ `
uniform float uMaterial_compW;
uniform float uMaterial_compH;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix
    * vec4(position.xy * vec2(uMaterial_compW, uMaterial_compH), 0.0, 1.0);
}
`;

/**
 * The prelude prepended to every custom fragment shader.
 *
 * The host owns these declarations rather than asking the pack to repeat them.
 * Two reasons: a pack cannot get them subtly wrong, and because the host knows
 * exactly how many lines it added, a compiler error can be reported at the
 * line the AUTHOR wrote rather than at some offset into a generated string.
 */
export function fragmentPrelude(params: readonly ShaderParamDef[]): string {
  const declarations = params
    .map((p) => `uniform ${GLSL_TYPE[p.type]} ${paramUniformName(p.id)};`)
    .join('\n');
  return `precision highp float;
precision highp int;

// ---- MATERIAL Shader Contract v1 -----------------------------------------
uniform sampler2D uMaterial_source;   // the frame this technique receives
uniform vec2  uMaterial_resolution;   // render size in pixels
uniform float uMaterial_time;         // COMPOSITION time in seconds
uniform float uMaterial_seed;         // deterministic, from the project
uniform float uMaterial_aspect;       // resolution.x / resolution.y

in vec2 vUv;                          // 0..1, (0,0) is the BOTTOM-LEFT
out vec4 fragColor;
${declarations ? `\n// ---- parameters ----------------------------------------------------------\n${declarations}\n` : ''}
// ---- pack source ---------------------------------------------------------
`;
}

/** How many lines the prelude occupies, so compiler errors can be reported
 * against the author's own line numbering. */
export function preludeLineCount(params: readonly ShaderParamDef[]): number {
  return fragmentPrelude(params).split('\n').length - 1;
}

/** Assemble what actually gets compiled. */
export function composeFragment(
  params: readonly ShaderParamDef[],
  userSource: string,
): string {
  return `${fragmentPrelude(params)}${userSource}`;
}

/** Names a pack may not declare, because the host already owns them. */
export const RESERVED_IDENTIFIERS = [
  ...HOST_UNIFORMS,
  'uMaterial_compW',
  'uMaterial_compH',
  'vUv',
  'fragColor',
] as const;

/**
 * Static checks applied before a pack's source is ever compiled.
 *
 * This is NOT a sandbox and does not pretend to be one — see docs/SHADERS.md.
 * GLSL that compiles can still be expensive, and no host-side text check can
 * change that. What these rules do is catch the accidental cases (a redeclared
 * host uniform, a `while (true)`) with a clear message instead of a driver log.
 */
export function staticShaderIssues(source: string): string[] {
  const issues: string[] = [];
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  for (const name of RESERVED_IDENTIFIERS) {
    // A redeclaration would shadow or clash with the host's own declaration
    // and produce a confusing compiler error far from the real cause.
    if (new RegExp(`\\b(uniform|in|out|varying)\\s[^;]*\\b${name}\\b`).test(stripped)) {
      issues.push(`redeclares the host identifier '${name}' — the contract already provides it`);
    }
  }
  if (/#version/.test(stripped)) {
    issues.push('declares #version — the host owns the GLSL version (ES 3.00)');
  }
  if (/\bwhile\s*\(\s*(true|1)\s*\)/.test(stripped)) {
    issues.push('contains while(true) — an unbounded loop can hang the GPU');
  }
  if (/\bfor\s*\(\s*;\s*;/.test(stripped)) {
    issues.push('contains for(;;) — an unbounded loop can hang the GPU');
  }
  if (!/\bvoid\s+main\s*\(/.test(stripped)) {
    issues.push('has no void main()');
  }
  return issues;
}
