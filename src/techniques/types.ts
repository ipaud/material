import type * as THREE from 'three';
import type { MaterialState, ParamRecord } from '@shared/schemas/project';

export interface ParamExploreMeta {
  randomizable: boolean;
  /** Safe range for exploration; defaults to the param's own min/max. */
  min?: number;
  max?: number;
  /** Relative likelihood of being mutated (1 = normal). */
  weight?: number;
  distribution?: 'uniform' | 'exponential';
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

/** Recent-frame ring buffer exposed to techniques that sample time. */
export interface RingBufferContext {
  texture: THREE.Texture;
  head: number;
  filled: number;
  count: number;
  cols: number;
  rows: number;
}

/** Per-frame context handed to technique renderers. */
export interface TechniqueContext {
  sourceTexture: THREE.Texture | null;
  /** Rasterized custom material (SVG/image), when materialId is 'custom'. */
  materialTexture: THREE.Texture | null;
  ring: RingBufferContext | null;
  compWidth: number;
  compHeight: number;
  material: MaterialState;
  timeSec: number;
  seed: number;
}

export interface TechniqueRenderer {
  readonly object3d: THREE.Object3D;
  update(params: ParamRecord, ctx: TechniqueContext): void;
  dispose(): void;
}

export interface TechniqueDefinition {
  id: string;
  name: string;
  category: 'space' | 'time' | 'image' | 'material';
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
