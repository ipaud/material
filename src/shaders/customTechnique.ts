import type { LoadedShader, ShaderParamDef } from '@shared/schemas/shaderPack';
import { customTechniqueId } from '@shared/schemas/shaderPack';
import type { ParamDef, ParamSection, TechniqueDefinition } from '@/techniques/types';
import { CustomShaderRenderer, type ShaderCompileState } from './CustomShaderRenderer';

/**
 * v0.5A — a pack shader becomes an ordinary TechniqueDefinition.
 *
 * This is the whole integration. Once a shader is a TechniqueDefinition, the
 * inspector renders its parameters, the modulation registry accepts them as
 * targets, Explore mutates them, Looks capture them, Morph interpolates them
 * and Output instantiates it — all without one line of shader-specific code in
 * any of those systems. If that stops being true, the abstraction is wrong and
 * the fix belongs here, not in the feature that noticed.
 */

/** Host policy on parameter metadata. A pack declares intent; the host decides
 * what is safe to put on a slider. */
const MAX_ABS = 1e6;

function toParamDef(p: ShaderParamDef): ParamDef {
  const explore = { randomizable: p.explorable };
  if (p.type === 'bool') {
    return { type: 'boolean', id: p.id, label: p.label, default: p.default, explore };
  }
  if (p.type === 'enum') {
    return {
      type: 'select',
      id: p.id,
      label: p.label,
      options: p.options.map((o) => ({ value: o.value, label: o.label })),
      default: p.default,
      explore,
    };
  }
  // Clamp a declared range into something a control can express. A pack asking
  // for ±1e20 gets a usable slider rather than a broken one.
  const min = Math.max(p.min, -MAX_ABS);
  const max = Math.min(p.max, MAX_ABS);
  const step = p.type === 'int' ? 1 : (p.step ?? Math.max((max - min) / 200, 1e-4));
  return {
    type: 'number',
    id: p.id,
    label: p.label,
    min,
    max,
    step,
    default: Math.min(Math.max(p.default, min), max),
    modulatable: p.modulatable,
    explore,
  };
}

/** Params are grouped by their declared group, in the product's own order. */
const GROUP_ORDER = ['Structure', 'Time', 'Motion', 'Color', 'Mix'] as const;

function toSections(params: readonly ShaderParamDef[]): ParamSection[] {
  const sections: ParamSection[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = params.filter((p) => p.group === group);
    if (inGroup.length > 0) sections.push({ label: group, params: inGroup.map(toParamDef) });
  }
  return sections.length > 0 ? sections : [{ label: 'Structure', params: [] }];
}

export interface CustomTechnique extends TechniqueDefinition {
  readonly custom: true;
  readonly shader: LoadedShader;
}

export function customTechniqueDefinition(
  shader: LoadedShader,
  onState?: (state: ShaderCompileState) => void,
): CustomTechnique {
  return {
    id: customTechniqueId(shader.packId, shader.entry.id),
    name: shader.entry.name,
    category: 'image',
    description: shader.entry.description || `${shader.packName} — custom shader`,
    sections: toSections(shader.entry.params),
    createRenderer: () => new CustomShaderRenderer(shader, onState),
    custom: true,
    shader,
  };
}

/**
 * The technique a project gets when it names a shader that is not installed.
 *
 * It passes the frame through and says so. Substituting a DIFFERENT shader
 * would be worse than showing nothing: the project would look wrong while
 * appearing to work, and the user's own parameter values would be silently
 * reinterpreted against a contract that is not theirs.
 */
export function missingShaderDefinition(techniqueId: string): TechniqueDefinition & {
  readonly missing: true;
} {
  return {
    id: techniqueId,
    name: 'Missing Shader Pack',
    category: 'image',
    description:
      'This project uses a shader from a pack that is not installed. Install or reload the pack to restore it — the settings are preserved in the meantime.',
    sections: [{ label: 'Structure', params: [] }],
    createRenderer: () => new CustomShaderRenderer(MISSING_SHADER),
    missing: true,
  };
}

/** A pass-through, so a missing pack shows the source rather than black. */
const MISSING_SHADER: LoadedShader = {
  packId: 'material.missing',
  packName: 'Missing',
  packVersion: '0.0.0',
  entry: {
    id: 'passthrough',
    name: 'Missing Shader',
    description: '',
    file: 'missing.frag',
    params: [],
    presets: [],
  },
  fragment: 'void main() { fragColor = texture(uMaterial_source, vUv); }',
  hash: 'missing',
};
