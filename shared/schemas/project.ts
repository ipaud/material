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
  /**
   * v0.4C. `add` is the historical behaviour and the default, so every project
   * written before this field loads with identical semantics.
   *
   * `replace` POSITIONS the parameter inside its own range instead of nudging
   * it from wherever it sits. Positional signals need it: a motion centroid
   * driving a feedback centre must map position to position, and "add ±amount
   * to the current centre" throws the meaning away. It also rescues any
   * parameter parked near its ceiling, where an additive mapping has nowhere
   * left to travel.
   */
  mode: z.enum(['add', 'replace']).optional(),
  /**
   * Input window, in SOURCE units. The signal is renormalised from
   * [inMin, inMax] to 0..1 before invert, curve and smoothing. Defaults to the
   * identity, so it cannot change an existing project.
   *
   * This is creative remapping, NOT calibration: calibration adapts a signal
   * to its source, this narrows attention to the part of the signal you care
   * about. Keeping them separate is why one can be automatic and the other
   * cannot.
   */
  inMin: z.number().optional(),
  inMax: z.number().optional(),
  /**
   * v0.6 — which LAYER this mapping drives. Absent means the layer that owns
   * it, which is every mapping written before layers existed.
   */
  targetLayerId: z.string().optional(),
  /**
   * v0.6 — which layer's SIGNALS feed it. Absent means the target layer's own
   * source, which is the intuitive default: `image.luminance` inside a layer
   * means that layer's luminance.
   *
   * Set, it is a cross-layer route: one layer's motion driving another's
   * parameter. Stored as a layer ID and never an index, so reordering the
   * composition cannot silently repoint a route at a different layer.
   */
  sourceLayerId: z.string().optional(),
});
/**
 * The v0.4C fields are OPTIONAL rather than defaulted, so ABSENT and `'add'`
 * mean the same thing everywhere — in a project written before v0.4C, in one
 * written after, and in a mapping constructed in passing by a test or a
 * preset. Defaulting them instead would have rewritten every stored project on
 * first save to say something it already meant, and forced 52 construction
 * sites to spell out three fields they do not care about.
 */
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

export const blendModeSchema = z.enum([
  'normal',
  'add',
  'screen',
  'multiply',
  'difference',
  'lighten',
  'darken',
]);

/**
 * One layer's worth of a Look: everything that makes the layer look the way it
 * does, and nothing about the layer's identity beyond the id used to match it
 * back up. Source is included because a layer without its material is not the
 * same look; runtime state (history, calibration) never is.
 */
export const layerLookSchema = z.object({
  id: z.string(),
  name: z.string().max(48).default(''),
  enabled: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
  blendMode: blendModeSchema.default('normal'),
  sourceId: z.string().nullable().default(null),
  technique: techniqueInstanceSchema.nullable().default(null),
  material: materialStateSchema,
});
export type LayerLook = z.infer<typeof layerLookSchema>;

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
  /**
   * v0.6D — the whole stack, when the Look was pinned from a composition that
   * had one.
   *
   * With layers, "the look" of MATERIAL IS the stack: recalling a slot and
   * getting a hybrid — this Look's technique wearing whatever else happened
   * to be loaded — is not what anyone means by recalling a look. So a Look
   * pinned from v0.6 on captures every layer.
   *
   * It stays OPTIONAL because a Look pinned before v0.6 has no stack to
   * capture, and must keep doing exactly what it always did: apply to the
   * selected layer and leave the rest alone. Absence is the honest record of
   * "this look predates layers", and inventing a single-layer stack for it
   * would silently start wiping layers the performer added later.
   */
  layers: z.array(layerLookSchema).optional(),
  /**
   * Which layer was selected when this Look was pinned.
   *
   * The Look's `techniques`/`material` describe THAT layer, and they are
   * applied on top of the restored stack. Without this the core landed on
   * whatever the fallback picked — measured: recalling a three-layer Look put
   * layer 2's technique onto layer 1 whenever the previously selected layer
   * no longer existed.
   */
  selectedLayerId: z.string().nullable().optional(),
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
/**
 * CE1G — the pixel transition a morph was performed with. Recorded on the
 * EVENT because export replays events, not runtime state: without it an
 * exported morph would fall back to the hard switch the user did not see.
 * Fully defaulted, so projects written before CE1G parse unchanged and
 * replay exactly as they did (style 'smooth' = v0.3 behaviour).
 * The style list is mirrored in TRANSITION_STYLES; transitions.test.ts
 * fails if the two ever drift apart.
 */
export const morphTransitionSchema = z.object({
  style: z
    .enum(['smooth', 'cut', 'directional', 'noise', 'pixel', 'radial', 'zoom', 'displace', 'glitch', 'luma'])
    .default('smooth'),
  softness: z.number().min(0).max(1).default(0.15),
  amount: z.number().min(0).max(2).default(1),
  scale: z.number().min(0).max(1).default(0.5),
  centerX: z.number().min(-1).max(1).default(0),
  centerY: z.number().min(-1).max(1).default(0),
  angle: z.number().default(0),
  seed: z.number().int().default(1),
});
export type MorphTransition = z.infer<typeof morphTransitionSchema>;

/** The v0.3 behaviour: no pixel transition. transitions.test.ts asserts
 * this stays equal to the renderer's DEFAULT_TRANSITION. */
export const DEFAULT_MORPH_TRANSITION: MorphTransition = {
  style: 'smooth',
  softness: 0.15,
  amount: 1,
  scale: 0.5,
  centerX: 0,
  centerY: 0,
  angle: 0,
  seed: 1,
};

export const morphEventSchema = z.object({
  id: z.string(),
  startTime: z.number().nonnegative(),
  endTime: z.number().nonnegative(),
  curve: morphCurveSchema,
  sourceSnapshot: lookCoreSchema,
  targetLookId: z.string(),
  transition: morphTransitionSchema.default(DEFAULT_MORPH_TRANSITION),
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

/**
 * v0.6 — how many visual branches may be active at once.
 *
 * A cap, not a limitation waiting to be lifted. Four keeps the GPU budget
 * predictable, the layer strip readable at a glance and the Output mirror
 * honest; past that MATERIAL stops being an instrument you can play and starts
 * being a compositor you operate. The number was chosen from measurement, not
 * from what an array makes easy — see docs/LAYERS.md.
 */
export const MAX_LAYERS = 4;

export type BlendMode = z.infer<typeof blendModeSchema>;

/**
 * One complete visual branch: a source, a technique, and how it sits in the
 * composition. Everything here is CONFIG — no runtime, no textures, no GPU
 * state ever reaches a project file.
 */
export const layerSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(48).default(''),
  enabled: z.boolean().default(true),
  /**
   * Solo is a VIEW over enabled, not a mutation of it: soloing a layer must
   * leave the others' enabled flags alone so un-soloing restores exactly what
   * the performer had. Stored so a soloed state survives a save.
   */
  solo: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  blendMode: blendModeSchema.default('normal'),
  /** Which of `sources[]` this layer draws from. */
  sourceId: z.string().nullable().default(null),
  /** Exactly one technique instance per layer — a layer is a branch, not a
   * stack. Effect chains inside a layer are deliberately out of scope. */
  technique: techniqueInstanceSchema.nullable().default(null),
  material: materialStateSchema,
});
export type Layer = z.infer<typeof layerSchema>;


// ---------------------------------------------------------------------------
// v0.7 — PERFORMANCE CAPTURE
// ---------------------------------------------------------------------------

/**
 * A Take records what the performer PLAYED, not what the engine resolved.
 *
 * Two data shapes, because human control has two shapes:
 *
 *   CONTINUOUS  a hand on a fader  → a lane of (t, v) samples, interpolated
 *   DISCRETE    a hand on a button → an event at an instant, stepped
 *
 * What is deliberately NOT here: Signals, Audio analysis, Pattern output,
 * calibration, and every resolved parameter. Those are GENERATED control —
 * they re-evaluate during replay and export, so a Take stays a performance
 * rather than a 200-parameters-per-frame recording of one. See
 * docs/AUTOMATION.md and the ADR in docs/DECISIONS.md.
 */

/**
 * Scoped control target. Layered projects make an unscoped param id
 * meaningless, and an index would break the moment a layer is reordered.
 *
 *   layer:<layerId>:opacity     0..1
 *   macro:<macroId>             0..1
 *   param:<layerId>:<paramId>   the parameter's own domain
 *
 * Parsed by `parseControlTarget` in src/performance/take/model.ts; the schema
 * keeps it a string so an unknown target from a newer build loads as an
 * unresolved lane instead of failing the whole project.
 */
export const takeLaneSchema = z.object({
  target: z.string(),
  /** Strictly increasing in `t`; `t` is seconds RELATIVE to the Take start. */
  samples: z
    .array(z.object({ t: z.number().nonnegative(), v: z.number() }))
    .default([]),
});
export type TakeLane = z.infer<typeof takeLaneSchema>;

export const takeEventKindSchema = z.enum([
  'look.recall',
  'morph.start',
  'freeze.set',
  'layer.enable',
]);
export type TakeEventKind = z.infer<typeof takeEventKindSchema>;

/**
 * Discrete performance intent.
 *
 * `order` breaks ties at an identical `t`: two events recorded in the same
 * frame must replay in the order they were played, and JS sort stability is
 * not a contract worth betting determinism on. It is monotonic within a Take,
 * never an array index — editing must not renumber what came before.
 *
 * Freeze and layer-enable store an explicit BOOLEAN STATE, never a toggle:
 * a toggle replayed from a different starting state inverts the whole
 * performance from that point on.
 */
export const takeEventSchema = z.object({
  id: z.string(),
  /** Seconds relative to the Take start. */
  t: z.number().nonnegative(),
  order: z.number().int().nonnegative(),
  kind: takeEventKindSchema,
  /** look.recall / morph.start */
  lookId: z.string().nullable().default(null),
  /** morph.start — the invocation, not the interpolated result. */
  morph: z
    .object({
      durationMode: z.enum(['seconds', 'beats', 'bars']),
      durationValue: z.number().positive(),
      curve: morphCurveSchema,
    })
    .nullable()
    .default(null),
  /** freeze.set / layer.enable */
  on: z.boolean().nullable().default(null),
  /** layer.enable */
  layerId: z.string().nullable().default(null),
  /** Diagnostics only: which hand played it. Never a replay input. */
  origin: z.enum(['user', 'midi']).default('user'),
});
export type TakeEvent = z.infer<typeof takeEventSchema>;

/**
 * The state a Take starts from.
 *
 * Without it, replay means "whatever the project happens to be right now
 * plus these gestures" — the same Take would render differently after any
 * edit, and a subrange export starting mid-Take could not reconstruct the
 * frames before it. Only what the Take actually touches is stored, so a
 * baseline is a handful of numbers rather than a second copy of the project.
 */
export const takeBaselineSchema = z.object({
  /** Control target → its value the instant before the Take first moved it. */
  lanes: z.record(z.string(), z.number()).default({}),
  /** Layer id → enabled state at Take start (only layers the Take toggles). */
  layerEnabled: z.record(z.string(), z.boolean()).default({}),
  /**
   * Mapping id → frozen value at Take start (null = not frozen). Stored for
   * EVERY mapping, not just frozen ones: restoring "unfrozen" is as much a
   * restoration as restoring a held value, and the record is one number per
   * mapping.
   */
  frozen: z.record(z.string(), z.number().nullable()).default({}),
});
export type TakeBaseline = z.infer<typeof takeBaselineSchema>;

export const performanceTakeSchema = z.object({
  id: z.string(),
  name: z.string().max(40),
  createdAt: z.string(),
  /** Composition time the recording began — where the Take sits on the song. */
  startSec: z.number().nonnegative().default(0),
  /**
   * Recorded length, from the actual STOP — not derived from the last event.
   * A performer who holds still for the last eight bars recorded that.
   */
  durationSec: z.number().nonnegative().default(0),
  lanes: z.array(takeLaneSchema).default([]),
  events: z.array(takeEventSchema).default([]),
  baseline: takeBaselineSchema,
});
export type PerformanceTake = z.infer<typeof performanceTakeSchema>;

export const projectSchema = z.object({
  version: z.literal(PROJECT_FORMAT_VERSION),
  name: z.string(),
  sources: z.array(sourceRefSchema),
  composition: compositionSchema,
  /**
   * v0.6 — the composition, bottom first. `layers[0]` is the background and
   * each later layer composites over the result so far.
   *
   * v3's single `techniques[]` / `material` / `composition.sourceId` became
   * exactly one layer during migration, which is why a v3 project renders
   * identically after loading.
   */
  layers: z.array(layerSchema).min(1).max(MAX_LAYERS),
  /** The layer the inspector, Explore and presets act on. */
  selectedLayerId: z.string().nullable().default(null),
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
  /**
   * v0.7 — recorded performances. Additive and defaulted, so the shape alone
   * would have loaded inside v4; the version still moved to 5, because a v0.7
   * project saved with Takes and reopened in v0.6.1 would have had them
   * silently stripped by the schema. A refused version is a fixable message;
   * a dropped performance is not.
   */
  takes: z.array(performanceTakeSchema).default([]),
  /** Take the transport replays / the panel shows. Not playback position. */
  activeTakeId: z.string().nullable().default(null),
  /** Global quantization for performance actions (look apply, morph, pads). */
  performanceQuantize: quantizeModeSchema.default('bar'),
  explore: z.object({
    lockedParams: z.array(z.string()),
    lastSeed: z.number().int().nonnegative().nullable(),
  }),
});
export type Project = z.infer<typeof projectSchema>;

/** The id every migrated v3 project's single layer receives. Deterministic on
 * purpose: two machines migrating the same file must agree, or a route stored
 * against that id would resolve differently. */
export const MIGRATED_LAYER_ID = 'layer_1';

/**
 * The technique of the layer being edited.
 *
 * v0.6 made `layers[].technique` the ONLY source of truth for what renders.
 * `techniques[]` still exists on the schema because Looks, presets and morph
 * snapshots written before v0.6 carry that shape and must keep parsing — but
 * nothing reads it to render, and nothing should write it expecting an effect.
 */
export function selectedTechniqueOf(project: Project): TechniqueInstance | null {
  return selectedLayerOf(project).technique;
}

export function selectedLayerOf(project: Project): Layer {
  return project.layers.find((l) => l.id === project.selectedLayerId) ?? (project.layers[0] as Layer);
}

/** Apply a change to the SELECTED layer's technique, leaving others alone. */
export function withSelectedTechnique(
  project: Project,
  fn: (technique: TechniqueInstance | null) => TechniqueInstance | null,
): Project {
  const target = selectedLayerOf(project);
  return {
    ...project,
    layers: project.layers.map((l) => (l.id === target.id ? { ...l, technique: fn(l.technique) } : l)),
  };
}

/**
 * Point the SELECTED layer at a source.
 *
 * v0.6 moved source ownership onto the layer, but `composition.sourceId` is
 * still the project-wide anchor migration reads and the frame size derives
 * from, so both move together. A layer with `sourceId: null` renders nothing —
 * it does not silently fall back to the composition.
 */
export function withSelectedSource(project: Project, sourceId: string): Project {
  const target = selectedLayerOf(project);
  return {
    ...project,
    layers: project.layers.map((l) => (l.id === target.id ? { ...l, sourceId } : l)),
    composition: { ...project.composition, sourceId },
  };
}

/**
 * Which layers actually render.
 *
 * Solo wins over enabled while any layer is soloed, and it is a VIEW: nothing
 * about the other layers' `enabled` flags changes, so releasing solo restores
 * precisely the state the performer had built.
 *
 * `enabled: false` and `opacity: 0` are deliberately NOT the same thing. A
 * disabled layer is not rendered at all — no branch draw, no analysis, no
 * compositor pass — so it costs nothing and its feedback or simulation history
 * stops advancing. A layer at zero opacity is rendered and composited to
 * nothing: it still costs, and its history keeps evolving, so fading it back
 * up resumes where the material would have been rather than where it was
 * abandoned. One is a mute, the other is a fader, and an instrument needs both.
 */
export function renderedLayers(layers: readonly Layer[]): Layer[] {
  const soloed = layers.filter((l) => l.solo);
  const visible = soloed.length > 0 ? soloed : layers;
  return visible.filter((l) => l.enabled);
}

export function emptyLayer(id: string, name = ''): Layer {
  return {
    id,
    name,
    enabled: true,
    solo: false,
    opacity: 1,
    blendMode: 'normal',
    sourceId: null,
    technique: null,
    material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
  };
}

export function createEmptyProject(name = 'Untitled'): Project {
  return {
    version: PROJECT_FORMAT_VERSION,
    name,
    layers: [emptyLayer(MIGRATED_LAYER_ID)],
    selectedLayerId: MIGRATED_LAYER_ID,
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
    takes: [],
    activeTakeId: null,
    performanceQuantize: 'bar' as const,
    explore: { lockedParams: [], lastSeed: null },
  };
}

/**
 * v3 → v4: a single creative branch becomes `layers[]`.
 *
 * The first genuinely structural change to the project model since v1. It
 * cannot be additive: v3 stores ONE source id, ONE technique array and ONE
 * material at the top level, and there is no way to express a second branch
 * without moving them. Keeping v3 by bolting a parallel `layers` field beside
 * the old one would have left two sources of truth for what renders — the
 * exact ambiguity a version number exists to prevent.
 *
 * The migration is mechanical and lossless: everything that described the one
 * branch becomes layer 1, at full opacity in Normal blend, so a v3 project
 * renders exactly as it did. The top-level fields are LEFT IN PLACE and still
 * parse, because Looks, presets and morph snapshots taken before v0.6 carry
 * the same shape and must keep loading.
 */
function migrateV3toV4(raw: Record<string, unknown>): Record<string, unknown> {
  const composition = (raw.composition ?? {}) as Record<string, unknown>;
  const techniques = Array.isArray(raw.techniques) ? raw.techniques : [];
  const layer = {
    id: MIGRATED_LAYER_ID,
    name: '',
    enabled: true,
    opacity: 1,
    blendMode: 'normal',
    sourceId: composition.sourceId ?? null,
    technique: techniques[0] ?? null,
    material: raw.material ?? {
      materialId: 'square',
      colorMode: 'source',
      params: {},
      assetPath: null,
    },
  };
  return { ...raw, version: 4, layers: [layer], selectedLayerId: MIGRATED_LAYER_ID };
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

/**
 * v4 → v5: Takes.
 *
 * A stamp, like v2 → v3, and for a mirror-image reason. `takes` and
 * `activeTakeId` are defaulted, so a v4 document already satisfies the v5
 * shape and nothing needs moving. The number exists to make the reverse
 * direction fail loudly: without it, v0.6.1 would open a v0.7 project,
 * strip the recorded performance as an unknown key, and save that back.
 */
function migrateV4toV5(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, version: 5 };
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
  if (candidate.version === 3) {
    candidate = migrateV3toV4(candidate);
  }
  if (candidate.version === 4) {
    candidate = migrateV4toV5(candidate);
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
