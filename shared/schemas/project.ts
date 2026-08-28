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

export const triggerActionSchema = z.enum([
  'pulse',
  'freeze',
  'unfreeze',
  'toggleFreeze',
  'pinLook',
  'applyLook',
  'nextLook',
  'prevLook',
  'resetParam',
  'toggleMapping',
  'morphToLook',
  'applyCandidate',
]);
export type TriggerAction = z.infer<typeof triggerActionSchema>;

export const quantizeModeSchema = z.enum(['off', 'beat', 'bar', '2bars', '4bars']);
export type QuantizeMode = z.infer<typeof quantizeModeSchema>;

/**
 * An event-driven mapping: TRIGGER SOURCE → ACTION.
 * Sources: 'beat' | 'bar' | 'div:1/2..1/16' | 'onset' | 'marker:<id>' | 'manual'.
 * 'manual' is the live class (UI button, future keyboard/MIDI) — everything
 * else is deterministic and reproduced in export.
 */
export const triggerMappingSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  action: triggerActionSchema,
  /** Pulse / resetParam: technique parameter id. */
  targetParam: z.string().nullable().default(null),
  /** Freeze / toggleMapping: modulation mapping id, or '*' for all. */
  targetMappingId: z.string().nullable().default(null),
  /** applyLook: pinned-look slot (1-based). */
  lookSlot: z.number().int().min(1).max(9).nullable().default(null),
  quantize: quantizeModeSchema.default('off'),
  /** Minimum seconds between firings (0 = every event). */
  cooldownSec: z.number().min(0).default(0),
  // Pulse envelope (used when action === 'pulse'):
  attackSec: z.number().min(0).default(0),
  holdSec: z.number().min(0).default(0),
  decaySec: z.number().min(0).default(0.18),
  /** Signed: negative amount pulses the parameter downward (polarity). */
  amount: z.number().min(-1).max(1).default(0.35),
  curve: z.enum(['linear', 'exponential', 'easeOut']).default('easeOut'),
});
export type TriggerMapping = z.infer<typeof triggerMappingSchema>;

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
  note: z.string().max(200).default(''),
  /** Keyboard slot 1–9, or null when unassigned. */
  slot: z.number().int().min(1).max(9).nullable().default(null),
  seed: z.number().int().nonnegative().default(1),
  /** Small JPEG data URL rendered at pin time; null when unavailable. */
  thumbnail: z.string().nullable().default(null),
  techniques: z.array(techniqueInstanceSchema),
  material: materialStateSchema,
  modulations: z.array(modulationMappingSchema),
  triggers: z.array(triggerMappingSchema).default([]),
});
export type PinnedLook = z.infer<typeof pinnedLookSchema>;

export const morphCurveSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'exponential']);
export type MorphCurve = z.infer<typeof morphCurveSchema>;

/** The morphable core of a look — no identity, no thumbnail. */
export const lookCoreSchema = z.object({
  techniqueId: z.string(),
  params: paramRecordSchema,
  material: materialStateSchema,
  modulations: z.array(modulationMappingSchema),
  triggers: z.array(triggerMappingSchema),
  seed: z.number().int().nonnegative(),
});
export type LookCore = z.infer<typeof lookCoreSchema>;

/**
 * A completed (or truncated-by-cancel) morph, recorded as timeline state so
 * export can replay it deterministically. Start/end are exact composition
 * times — musical durations were resolved when the morph launched.
 */
export const morphEventSchema = z.object({
  id: z.string(),
  startTime: z.number().nonnegative(),
  endTime: z.number().nonnegative(),
  curve: morphCurveSchema,
  sourceSnapshot: lookCoreSchema,
  targetLookId: z.string(),
});
export type MorphEvent = z.infer<typeof morphEventSchema>;

/**
 * Performance macro (Phase 15): one 0–1 control fanned out to several
 * parameters. Contributions are additive through the shared evaluation
 * pipeline (base → macros → modulation → pulses → clamp) — a macro never
 * writes into stored params or Looks; its value is live performance state
 * persisted at the project level.
 */
export const macroMappingSchema = z.object({
  targetParam: z.string(),
  /** Signed fraction of the target's span added at macro value 1. */
  amount: z.number().min(-1).max(1),
  min: z.number().min(0).max(1).default(0),
  max: z.number().min(0).max(1).default(1),
  invert: z.boolean().default(false),
  curve: z.enum(['linear', 'exponential', 'logarithmic']).default('linear'),
  enabled: z.boolean().default(true),
});
export type MacroMapping = z.infer<typeof macroMappingSchema>;

export const macroSchema = z.object({
  id: z.string(),
  name: z.string().max(24),
  value: z.number().min(0).max(1).default(0),
  mappings: z.array(macroMappingSchema).default([]),
});
export type Macro = z.infer<typeof macroSchema>;

/**
 * Performance trigger pad: a large button firing a trigger action through
 * the existing scheduler (live-class). The pad EMBEDS its trigger payload —
 * project.triggers is look-core state and gets replaced on every look
 * apply/morph, so pads must not reference into it. `velocityScale` reserves
 * MIDI-velocity scaling of pulse amounts (§19 — wiring is future work).
 */
export const performancePadSchema = z.object({
  id: z.string(),
  label: z.string().max(16),
  trigger: triggerMappingSchema.nullable().default(null),
  velocityScale: z.boolean().default(false),
});
export type PerformancePad = z.infer<typeof performancePadSchema>;

/**
 * MIDI mapping (Phase 14). Live-class input: never part of export.
 *
 * CC mappings drive a parameter in ABSOLUTE mode (the knob IS the base
 * value, with pickup/soft-takeover); `mode` reserves the future MODULATE
 * option (CC as a Signal-system source). Note mappings fire trigger actions
 * through the existing scheduler — quantization included, no second
 * quantizer.
 *
 * `deviceId` is the platform id (may change across reconnects);
 * `deviceLabel` = "manufacturer · name" is the fallback matcher. Mappings
 * persist offline and re-attach on hot-plug.
 */
export const midiMappingSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  deviceId: z.string(),
  deviceLabel: z.string(),
  /** 0–15; null = omni (any channel). */
  channel: z.number().int().min(0).max(15).nullable().default(null),
  messageType: z.enum(['cc', 'note']),
  /** CC number or note number, 0–127. */
  control: z.number().int().min(0).max(127),
  targetType: z.enum(['param', 'triggerAction', 'macro']),
  /** param target: technique parameter id. */
  targetParam: z.string().nullable().default(null),
  /** triggerAction target: reuses the trigger-engine action vocabulary. */
  action: triggerActionSchema.nullable().default(null),
  lookSlot: z.number().int().min(1).max(9).nullable().default(null),
  targetMappingId: z.string().nullable().default(null),
  quantize: quantizeModeSchema.default('off'),
  /** CC shaping — same vocabulary as modulation mappings. */
  min: z.number().min(0).max(1).default(0),
  max: z.number().min(0).max(1).default(1),
  invert: z.boolean().default(false),
  smoothing: z.number().min(0).max(1).default(0),
  curve: z.enum(['linear', 'exponential', 'logarithmic']).default('linear'),
  pickupMode: z.enum(['pickup', 'jump']).default('pickup'),
  /** ABSOLUTE now; 'modulate' reserved for the Signal-system mode. */
  mode: z.enum(['absolute', 'modulate']).default('absolute'),
});
export type MidiMapping = z.infer<typeof midiMappingSchema>;

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
  triggers: z.array(triggerMappingSchema).default([]),
  timeline: timelineStateSchema,
  pinnedLooks: z.array(pinnedLookSchema),
  /** Look whose state was last applied; dirty when current state diverges. */
  activeLookId: z.string().nullable().default(null),
  morphEvents: z.array(morphEventSchema).default([]),
  /** Optional (defaulted) — v2 projects without it stay valid. */
  midiMappings: z.array(midiMappingSchema).default([]),
  macros: z.array(macroSchema).default([]),
  performancePads: z.array(performancePadSchema).default([]),
  /** Global quantization for performance actions (look apply, morph, pads). */
  performanceQuantize: quantizeModeSchema.default('bar'),
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
    triggers: [],
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
    activeLookId: null,
    morphEvents: [],
    midiMappings: [],
    macros: [],
    performancePads: [],
    performanceQuantize: 'bar' as const,
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
