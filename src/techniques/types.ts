import type * as THREE from 'three';
import type { MaterialState, ParamRecord } from '@shared/schemas/project';
import type { TemporalUniforms } from '@/rendering/temporal/TemporalFrameProvider';

export interface ParamExploreMeta {
  randomizable: boolean;
  /** Safe range for exploration; defaults to the param's own min/max. */
  min?: number;
  max?: number;
  /** Relative likelihood of being mutated (1 = normal). */
  weight?: number;
  distribution?: 'uniform' | 'exponential';
  /**
   * Which way this parameter moves VISIBLE COVERAGE — how much of the frame
   * ends up carrying image. 'up' = raising it shows more, 'down' = raising it
   * shows less. Candidate mutation uses this to stop several parameters from
   * shrinking the image at once, which is what produces near-black results.
   */
  coverage?: 'up' | 'down';
}

export interface NumberParamDef {
  type: 'number';
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  modulatable?: boolean;
  explore?: ParamExploreMeta;
}

export interface BooleanParamDef {
  type: 'boolean';
  id: string;
  label: string;
  default: boolean;
  explore?: ParamExploreMeta;
}

export interface SelectParamDef {
  type: 'select';
  id: string;
  label: string;
  options: { value: string; label: string }[];
  default: string;
  explore?: ParamExploreMeta;
}

export type ParamDef = NumberParamDef | BooleanParamDef | SelectParamDef;

export interface ParamSection {
  label: string;
  params: ParamDef[];
}

/** Per-frame context handed to technique renderers. */
export interface TechniqueContext {
  sourceTexture: THREE.Texture | null;
  /** Rasterized custom material (SVG/image), when materialId is 'custom'. */
  materialTexture: THREE.Texture | null;
  /** Composition-time addressable frame history (null when unused). */
  temporal: TemporalUniforms | null;
  /** CE1D: shared optical-flow texture (signed RG, uv/frame) — null unless
   * the active technique declared it needs flow. */
  flow: THREE.Texture | null;
  compWidth: number;
  compHeight: number;
  material: MaterialState;
  timeSec: number;
  seed: number;
  /**
   * v0.5: the live WebGL renderer, for techniques that must compile GLSL they
   * did not author. Native techniques build their shaders at construction and
   * ignore this; a pack-hosted shader has to validate source against a real
   * context before it is allowed anywhere near a frame.
   */
  renderer: THREE.WebGLRenderer | null;
}

export interface TechniqueRenderer {
  readonly object3d: THREE.Object3D;
  update(params: ParamRecord, ctx: TechniqueContext): void;
  dispose(): void;
}

export interface TechniqueDefinition {
  id: string;
  name: string;
  category: 'space' | 'time' | 'image' | 'material' | 'feedback';
  description: string;
  sections: ParamSection[];
  createRenderer(): TechniqueRenderer;
}

export function defaultParams(definition: TechniqueDefinition): ParamRecord {
  const params: Record<string, number | boolean | string> = {};
  for (const section of definition.sections) {
    for (const param of section.params) {
      params[param.id] = param.default;
    }
  }
  return params;
}

export function allParams(definition: TechniqueDefinition): ParamDef[] {
  return definition.sections.flatMap((s) => s.params);
}
