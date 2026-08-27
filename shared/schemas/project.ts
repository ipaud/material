import { z } from 'zod';
import { PROJECT_FORMAT_VERSION } from '../constants/app';
import { mediaMetadataSchema, mediaKindSchema } from './media';

export const paramValueSchema = z.union([z.number(), z.boolean(), z.string()]);
export type ParamValue = z.infer<typeof paramValueSchema>;

export const paramRecordSchema = z.record(z.string(), paramValueSchema);
export type ParamRecord = z.infer<typeof paramRecordSchema>;

export const sourceRefSchema = z.object({
  id: z.string(),
  kind: mediaKindSchema,
  path: z.string(),
  metadata: mediaMetadataSchema.nullable(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const techniqueInstanceSchema = z.object({
  id: z.string(),
  techniqueId: z.string(),
  enabled: z.boolean(),
  params: paramRecordSchema,
});
export type TechniqueInstance = z.infer<typeof techniqueInstanceSchema>;

export const materialStateSchema = z.object({
  materialId: z.string(),
  colorMode: z.enum(['source', 'original', 'mono', 'sourceColor']),
  params: paramRecordSchema,
  /** For custom SVG / image materials: source asset path. */
  assetPath: z.string().nullable(),
});
export type MaterialState = z.infer<typeof materialStateSchema>;

export const modulationMappingSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  /** "<techniqueInstanceId>.<paramId>" */
  target: z.string(),
  amount: z.number(),
  min: z.number(),
  max: z.number(),
  invert: z.boolean(),
  smoothing: z.number().min(0).max(1),
  curve: z.enum(['linear', 'exponential', 'logarithmic']),
  /** FREEZE: when non-null, evaluator holds this captured value. */
  frozenValue: z.number().nullable(),
});
export type ModulationMapping = z.infer<typeof modulationMappingSchema>;

export const timelineMarkerSchema = z.object({
  id: z.string(),
  timeSec: z.number().nonnegative(),
  label: z.string().max(40),
});
export type TimelineMarker = z.infer<typeof timelineMarkerSchema>;

export const timelineStateSchema = z.object({
  inSec: z.number().nonnegative().nullable(),
  outSec: z.number().nonnegative().nullable(),
  loop: z.boolean(),
  bpm: z.number().positive().nullable(),
  beatOffsetSec: z.number(),
  /** Time signature numerator (4/4 → 4). Defaults keep v2 additive. */
  beatsPerBar: z.number().int().min(1).max(12).default(4),
  markers: z.array(timelineMarkerSchema).default([]),
});
export type TimelineState = z.infer<typeof timelineStateSchema>;

export const pinnedLookSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  label: z.string(),
  techniques: z.array(techniqueInstanceSchema),
  material: materialStateSchema,
  modulations: z.array(modulationMappingSchema),
});
export type PinnedLook = z.infer<typeof pinnedLookSchema>;

export const compositionSchema = z.object({
  sourceId: z.string().nullable(),
  audioSourceId: z.string().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  background: z.string(),
});
export type Composition = z.infer<typeof compositionSchema>;

export const projectSchema = z.object({
  version: z.literal(PROJECT_FORMAT_VERSION),
  name: z.string(),
  sources: z.array(sourceRefSchema),
  composition: compositionSchema,
  techniques: z.array(techniqueInstanceSchema),
  material: materialStateSchema,
  modulations: z.array(modulationMappingSchema),
  timeline: timelineStateSchema,
  pinnedLooks: z.array(pinnedLookSchema),
  explore: z.object({
    lockedParams: z.array(z.string()),
    lastSeed: z.number().int().nonnegative().nullable(),
  }),
});
export type Project = z.infer<typeof projectSchema>;

export function createEmptyProject(name = 'Untitled'): Project {
  return {
    version: PROJECT_FORMAT_VERSION,
    name,
    sources: [],
    composition: {
      sourceId: null,
      audioSourceId: null,
      width: 1920,
      height: 1080,
      background: '#000000',
    },
    techniques: [],
    material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    modulations: [],
    timeline: {
      inSec: null,
      outSec: null,
      loop: true,
      bpm: null,
      beatOffsetSec: 0,
      beatsPerBar: 4,
      markers: [],
    },
    pinnedLooks: [],
    explore: { lockedParams: [], lastSeed: null },
  };
}

/** v1 → v2: musical-clock fields appear, everything else is unchanged. */
function migrateV1toV2(raw: Record<string, unknown>): Record<string, unknown> {
  const timeline = (raw.timeline ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    version: 2,
    timeline: {
      ...timeline,
      beatsPerBar: timeline.beatsPerBar ?? 4,
      markers: timeline.markers ?? [],
    },
  };
}

/**
 * Parse + migrate a raw project JSON object to the current version.
 * Older versions are upgraded in memory; the file on disk is only rewritten
 * when the user saves. Unknown (newer) versions are refused, never guessed.
 */
export function parseProject(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Project file is not a JSON object');
  }
  let candidate = raw as Record<string, unknown>;
  if (candidate.version === 1) {
    candidate = migrateV1toV2(candidate);
  }
  if (candidate.version !== PROJECT_FORMAT_VERSION) {
    throw new Error(`Unsupported project version: ${String(candidate.version)}`);
  }
  return projectSchema.parse(candidate);
}
