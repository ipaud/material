import { z } from 'zod';
import { PROJECT_FORMAT_VERSION } from '../constants/app';
import { mediaMetadataSchema, mediaKindSchema } from './media';

export const paramValueSchema = z.union([z.number(), z.boolean(), z.string()]);
export type ParamValue = z.infer<typeof paramValueSchema>;

export const paramRecordSchema = z.record(z.string(), paramValueSchema);
export type ParamRecord = z.infer<typeof paramRecordSchema>;

/**
 * v3 — sources split into FILE media (path on disk) and LIVE devices
 * (camera; screen/window follow in 18E). This split is the whole reason the
 * format moved to v3: a live source has no path and carries device
 * preferences instead. Nothing runtime-ish is ever persisted — no stream
 * ids, no permission state, no resolution, no labels-as-identity.
 */
export const fileSourceRefSchema = z.object({
  id: z.string(),
  kind: mediaKindSchema,
  path: z.string(),
  metadata: mediaMetadataSchema.nullable(),
});
export type FileSourceRef = z.infer<typeof fileSourceRefSchema>;

export const cameraSourceRefSchema = z.object({
  id: z.string(),
  kind: z.literal('camera'),
  /** Best-effort device preference — ids are not stable across profiles. */
  deviceId: z.string().nullable().default(null),
});
export type CameraSourceRef = z.infer<typeof cameraSourceRefSchema>;

/** 18E: capture a physical display. Electron display ids are stable enough
 * for a best-effort preference; never coupled to the OUTPUT target display. */
export const screenSourceRefSchema = z.object({
  id: z.string(),
  kind: z.literal('screen'),
  displayId: z.number().nullable().default(null),
});
export type ScreenSourceRef = z.infer<typeof screenSourceRefSchema>;

/** 18E: capture one application window. OS window capture ids are ephemeral
 * (ADR — window identity), so only a human-readable hint persists; reopening
 * a project always requires an explicit re-selection. */
export const windowSourceRefSchema = z.object({
  id: z.string(),
  kind: z.literal('window'),
  titleHint: z.string().nullable().default(null),
});
export type WindowSourceRef = z.infer<typeof windowSourceRefSchema>;

/** CE1F: procedural generator source. Params use the shared param record;
 * `seed` keeps generated content stable across save/reload. Additive inside
 * v3 — no existing field changed shape (docs/PROJECT_FORMAT.md). */
export const generatorSourceRefSchema = z.object({
  id: z.string(),
  kind: z.literal('generator'),
  generator: z.string(),
  params: paramRecordSchema.default({}),
  seed: z.number().int().nonnegative().default(1),
});
export type GeneratorSourceRef = z.infer<typeof generatorSourceRefSchema>;

export const sourceRefSchema = z.union([
  fileSourceRefSchema,
  cameraSourceRefSchema,
  screenSourceRefSchema,
  windowSourceRefSchema,
  generatorSourceRefSchema,
]);
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** Live (non-seekable, non-exportable) source kinds — 18D camera, 18E capture. */
export function isLiveSource(
  source: SourceRef,
): source is CameraSourceRef | ScreenSourceRef | WindowSourceRef {
  return source.kind === 'camera' || source.kind === 'screen' || source.kind === 'window';
}

export function isGeneratorSource(source: SourceRef): source is GeneratorSourceRef {
  return source.kind === 'generator';
}

export function isFileSource(source: SourceRef): source is FileSourceRef {
  return !isLiveSource(source) && source.kind !== 'generator';
}

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
  frozenValue: z.number().nullable().default(null),
});
export type ModulationMapping = z.infer<typeof modulationMappingSchema>;

// ---- Pattern sources (P4) ----------------------------------------------
// Serialized mirror of src/pattern/patternTypes.ts. The zod layer keeps the
// STRUCTURE honest; compilePattern remains the semantic authority (ranges,
// pulses≤steps, nesting) — a definition that parses but fails compile yields
// a neutral source, never a crash.

/** `null` is a REST step (v1.5): present in the grid, contributes nothing. */
export const patternValueSchema = z.union([z.number().finite(), z.boolean(), z.null()]);

export const patternDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('constant'), value: patternValueSchema }),
  z.object({ type: z.literal('sequence'), values: z.array(patternValueSchema) }),
  z.object({ type: z.literal('alternate'), values: z.array(patternValueSchema) }),
  z.object({
    type: z.literal('euclidean'),
    pulses: z.number(),
    steps: z.number(),
    rotation: z.number(),
    activeValue: patternValueSchema,
    inactiveValue: patternValueSchema,
  }),
]);
export type PatternDefinitionJson = z.infer<typeof patternDefinitionSchema>;

const simplePatternTransformSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fast'), factor: z.number() }),
  z.object({ type: z.literal('slow'), factor: z.number() }),
  z.object({ type: z.literal('reverse') }),
  z.object({ type: z.literal('rotate'), steps: z.number() }),
  z.object({ type: z.literal('iter'), steps: z.number() }),
]);

export const patternTransformSchema = z.union([
  simplePatternTransformSchema,
  z.object({
    type: z.literal('every'),
    cycles: z.number(),
    transform: simplePatternTransformSchema,
  }),
  z.object({
    type: z.literal('maybe'),
    probability: z.number(),
    transform: simplePatternTransformSchema,
  }),
  z.object({ type: z.literal('shuffle') }),
  z.object({ type: z.literal('smooth') }),
  z.object({ type: z.literal('degrade'), probability: z.number() }),
]);
export type PatternTransformJson = z.infer<typeof patternTransformSchema>;

/**
 * A pattern modulation source. Mapping-owned fields (amount/range/curve/
 * invert/smoothing) deliberately do NOT exist here — mappings reference the
 * source as `pattern:<id>` like any other source id.
 */
export const patternSourceSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  pattern: patternDefinitionSchema,
  transforms: z.array(patternTransformSchema).default([]),
  /** Cycle length in beats — independent from beatsPerBar (P1 contract). */
  beatsPerCycle: z.number().positive().default(4),
});
export type PatternSource = z.infer<typeof patternSourceSchema>;

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
  /**
   * Optional (defaulted) — additive inside v2 like `macros` and
   * `performancePads`. Pattern ids are creative identity (they seed
   * deterministic probability), so duplicates are REFUSED rather than
   * silently renamed: renaming would change what a saved project renders.
   */
  patternSources: z
    .array(patternSourceSchema)
    .default([])
    .superRefine((sources, ctx) => {
      const seen = new Set<string>();
      for (const [index, source] of sources.entries()) {
        if (seen.has(source.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: `Duplicate Pattern source id: ${source.id}`,
          });
        }
        seen.add(source.id);
      }
    }),
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
    patternSources: [],
    macros: [],
    performancePads: [],
    performanceQuantize: 'bar' as const,
    explore: { lockedParams: [], lastSeed: null },
  };
}

/**
 * v2 → v3: LIVE source configuration. File sources are untouched; the only
 * change is that `sources[]` may now also hold live device refs. Every v2
 * project is therefore already a valid v3 project — the migration is a
 * version stamp, deliberately.
 */
function migrateV2toV3(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, version: 3 };
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
  if (candidate.version === 2) {
    candidate = migrateV2toV3(candidate);
  }
  if (candidate.version !== PROJECT_FORMAT_VERSION) {
    throw new Error(`Unsupported project version: ${String(candidate.version)}`);
  }
  const result = projectSchema.safeParse(candidate);
  if (!result.success) throw new Error(formatProjectIssues(result.error));
  return result.data;
}

/**
 * Zod's default message is a multi-KB JSON dump — useless in a toast. Report
 * the first few issues as `path: message` lines instead, so a bad file names
 * the field that broke it (e.g. `patternSources.0.id: Duplicate Pattern
 * source id: pat-a`).
 */
function formatProjectIssues(error: z.ZodError): string {
  const MAX_SHOWN = 4;
  const lines = error.issues
    .slice(0, MAX_SHOWN)
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
  const extra = error.issues.length - lines.length;
  if (extra > 0) lines.push(`…and ${extra} more problem${extra === 1 ? '' : 's'}`);
  return `Invalid project file — ${lines.join('; ')}`;
}
