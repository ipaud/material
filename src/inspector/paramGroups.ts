import type { ParamDef, TechniqueDefinition } from '@/techniques/types';

/**
 * UI v2 regroups technique parameters under conceptual headings so the
 * Inspector reads as one system rather than a per-technique parameter dump.
 *
 * Techniques keep owning their own sections (that is where a parameter's real
 * semantics live); this table only decides which conceptual group each
 * parameter is shown under. A parameter the table does not know keeps its
 * technique's own section label as its group, so nothing is ever lost or
 * silently mislabelled when a new technique lands.
 */
export const CONCEPTUAL_GROUPS = ['STRUCTURE', 'SAMPLING', 'TIME', 'BEHAVIOR'] as const;

// CE1B/CE1C vocabulary (feedback + fields) — meaning-first grouping (§45).
export type ConceptualGroup = (typeof CONCEPTUAL_GROUPS)[number];

/** Parameter id → conceptual group. Ids repeat across techniques by meaning. */
const PARAM_GROUP: Record<string, ConceptualGroup> = {
  // Structure — the grid, the element count, the depth of field
  columns: 'STRUCTURE',
  rows: 'STRUCTURE',
  spacing: 'STRUCTURE',
  scale: 'STRUCTURE',
  minScale: 'STRUCTURE',
  maxScale: 'STRUCTURE',
  depth: 'STRUCTURE',
  perspective: 'STRUCTURE',
  strips: 'STRUCTURE',
  axis: 'STRUCTURE',
  copies: 'STRUCTURE',

  // Sampling — how the source image is read
  threshold: 'SAMPLING',
  contrast: 'SAMPLING',
  gamma: 'SAMPLING',
  invert: 'SAMPLING',
  lumToScale: 'SAMPLING',
  lumToRotation: 'SAMPLING',
  lumToOpacity: 'SAMPLING',
  lumToDepth: 'SAMPLING',

  // Time — frame history, delay, span, stepping
  tileMode: 'TIME',
  offsetMode: 'TIME',
  maxOffsetSec: 'TIME',
  falloff: 'TIME',
  temporalDirection: 'TIME',
  centerX: 'STRUCTURE',
  centerY: 'STRUCTURE',
  delaySec: 'TIME',
  decay: 'TIME',
  stepSec: 'TIME',
  persistence: 'TIME',
  injection: 'SAMPLING',
  mix: 'SAMPLING',
  zoom: 'BEHAVIOR',
  driftX: 'BEHAVIOR',
  driftY: 'BEHAVIOR',
  segments: 'STRUCTURE',
  field: 'STRUCTURE',
  offset: 'TIME',
  hold: 'TIME',
  spanSec: 'TIME',
  offsetSec: 'TIME',
  direction: 'TIME',
  interpolate: 'TIME',

  // Behavior — how elements move, scatter and blend
  rotation: 'BEHAVIOR',
  randomRotation: 'BEHAVIOR',
  opacity: 'BEHAVIOR',
  jitterX: 'BEHAVIOR',
  jitterY: 'BEHAVIOR',
  offsetX: 'BEHAVIOR',
  offsetY: 'BEHAVIOR',
  copyScale: 'BEHAVIOR',
  copyRotation: 'BEHAVIOR',
  distribution: 'BEHAVIOR',
  blend: 'BEHAVIOR',
  mode: 'BEHAVIOR',
};

export interface InspectorGroup {
  /** Group heading, uppercase. */
  label: string;
  params: ParamDef[];
}

/**
 * Group a technique's parameters for display. Every parameter appears exactly
 * once, in technique-declaration order within its group.
 */
export function groupParams(definition: TechniqueDefinition): InspectorGroup[] {
  const byLabel = new Map<string, ParamDef[]>();
  const push = (label: string, param: ParamDef) => {
    const existing = byLabel.get(label);
    if (existing) existing.push(param);
    else byLabel.set(label, [param]);
  };

  for (const section of definition.sections) {
    for (const param of section.params) {
      push(PARAM_GROUP[param.id] ?? section.label.toUpperCase(), param);
    }
  }

  const known = CONCEPTUAL_GROUPS.filter((g) => byLabel.has(g)).map((g) => ({
    label: g,
    params: byLabel.get(g) as ParamDef[],
  }));
  const extra = [...byLabel.keys()]
    .filter((label) => !(CONCEPTUAL_GROUPS as readonly string[]).includes(label))
    .map((label) => ({ label, params: byLabel.get(label) as ParamDef[] }));

  return [...known, ...extra];
}
