import type { Preset } from '@shared/schemas/preset';
import type { ModulationMapping } from '@shared/schemas/project';

/**
 * v0.4D — the reason image and motion signals exist.
 *
 * These are ordinary technique presets. No new content system was invented:
 * a preset already carries a technique, its params, a material and its
 * modulations, so a signal-driven Look is a preset whose modulations happen to
 * come from the picture rather than from the music.
 *
 * Three rules every entry here follows.
 *
 * **Ranges are hand-curated, never 0..1 → full travel.** A centroid mapped to
 * the whole width of a feedback centre spends its life at the edges of the
 * frame; mapped to 0.15..0.85 it moves where a viewer can follow it. Every
 * window below was chosen against the measured span of the signal it carries.
 *
 * **Source-agnostic.** No preset references an asset, a pattern or a project
 * global. Calibration is what makes them portable: the same Look has to stay
 * playable on a dark clip, a bright generator and a camera.
 *
 * **Positions map with `mode: 'replace'`.** A centroid added to wherever a
 * parameter happens to sit is not a position. Amplitudes mostly stay additive,
 * so the slider still sets the resting point.
 */

const SMOOTH_SLOW = 0.45;
const SMOOTH_MID = 0.25;
const SMOOTH_FAST = 0.08;

const SQUARE = {
  materialId: 'square',
  colorMode: 'source' as const,
  params: { aspect: 1 },
  assetPath: null,
};

interface MapSpec {
  source: string;
  target: string;
  min: number;
  max: number;
  amount?: number;
  mode?: 'add' | 'replace';
  smoothing?: number;
  invert?: boolean;
  curve?: 'linear' | 'exponential' | 'logarithmic';
  inMin?: number;
  inMax?: number;
}

const mapping = (id: string, spec: MapSpec): ModulationMapping => ({
  id,
  enabled: true,
  source: spec.source,
  target: spec.target,
  amount: spec.amount ?? 1,
  min: spec.min,
  max: spec.max,
  invert: spec.invert ?? false,
  smoothing: spec.smoothing ?? SMOOTH_MID,
  curve: spec.curve ?? 'linear',
  frozenValue: null,
  ...(spec.mode ? { mode: spec.mode } : {}),
  ...(spec.inMin !== undefined ? { inMin: spec.inMin } : {}),
  ...(spec.inMax !== undefined ? { inMax: spec.inMax } : {}),
});

interface PresetSpec {
  slug: string;
  name: string;
  techniqueId: string;
  params: Record<string, number | string | boolean>;
  category: string;
  description: string;
  tags: string[];
  mappings: MapSpec[];
}

const SPECS: PresetSpec[] = [
  {
    slug: 'body-follow',
    name: 'Body Follow',
    techniqueId: 'feedback-zoom',
    params: { zoom: 1.03, persistence: 0.955, injection: 0.5, mix: 1 },
    category: 'Reactive',
    description: 'The tunnel opens wherever you move. Movement is the camera.',
    tags: ['reactive', 'motion', 'camera', 'performance'],
    mappings: [
      // The flagship. 0.15..0.85 of a -0.5..0.5 parameter keeps the centre
      // inside the frame at the extremes, where the effect still reads.
      { source: 'motion.centroidX', target: 'centerX', mode: 'replace', min: 0.15, max: 0.85, smoothing: SMOOTH_MID },
      // Y is INVERTED on purpose, and the two conventions it reconciles are
      // both deliberate: `motion.centroidY` reads 0 at the TOP of the image,
      // the way a person describes a position, while the feedback centre is
      // in render space where +Y is up. Without the flip, movement at the top
      // of the frame would open the tunnel at the bottom.
      { source: 'motion.centroidY', target: 'centerY', mode: 'replace', min: 0.85, max: 0.15, smoothing: SMOOTH_MID },
      // Faster movement pulls harder, but only over the top third of the
      // zoom range — the bottom is where the image sits still.
      { source: 'motion.amount', target: 'zoom', mode: 'replace', min: 0.5, max: 0.72, amount: 0.7, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'movement-memory',
    name: 'Movement Memory',
    techniqueId: 'time-field',
    params: { scale: 1.4, speed: 0.35, depth: 1.2, offset: 0 },
    category: 'Reactive',
    description: 'Move more and the image remembers further back.',
    tags: ['reactive', 'motion', 'temporal'],
    mappings: [
      // 0.3..0.95 of 0..2.29s = 0.69..2.18s. Below 0.3 the temporal window is
      // too short to read as memory at all.
      { source: 'motion.amount', target: 'depth', mode: 'replace', min: 0.3, max: 0.95, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'directional-drag',
    name: 'Directional Drag',
    techniqueId: 'feedback-drift',
    params: { driftX: 0, driftY: 0, persistence: 0.94, injection: 0.6, mix: 1 },
    category: 'Reactive',
    description: 'The image drags its own trail in the direction things move.',
    tags: ['reactive', 'motion', 'performance'],
    mappings: [
      // Bipolar windows: still (0.5) contributes exactly nothing, so the
      // trail is straight until something actually moves.
      //
      // NOT inverted, unlike Body Follow's centroidY. `motion.y` keeps the
      // render convention (1 = up) and the feedback shader samples the past at
      // `uv - drift`, so +driftY drags the trail upward too. Inverting here
      // made upward movement smear downward.
      { source: 'motion.x', target: 'driftX', min: -0.6, max: 0.6, smoothing: SMOOTH_MID },
      { source: 'motion.y', target: 'driftY', min: -0.6, max: 0.6, smoothing: SMOOTH_MID },
    ],
  },
  {
    slug: 'structure-react',
    name: 'Structure React',
    techniqueId: 'mosaic',
    params: { scale: 1, spacing: 0.12, opacity: 1, threshold: 0 },
    category: 'Reactive',
    description: 'Detailed frames break into fine tiles; soft ones stay whole.',
    tags: ['reactive', 'image', 'grid'],
    mappings: [
      // Edge energy is small in absolute terms (0.03-0.16 measured across
      // generators), which is exactly what calibration is for — the window
      // here is in CALIBRATED units.
      { source: 'image.edgeEnergy', target: 'scale', mode: 'replace', min: 0.18, max: 0.55, smoothing: SMOOTH_SLOW },
      { source: 'image.edgeEnergy', target: 'spacing', min: 0, max: 0.35, amount: 0.5, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'light-breath',
    name: 'Light Breath',
    techniqueId: 'feedback-zoom',
    params: { zoom: 1.01, persistence: 0.95, injection: 0.5, mix: 1 },
    category: 'Reactive',
    description: 'Bright material breathes outward, dark material draws in.',
    tags: ['reactive', 'image'],
    mappings: [
      // 0.35..0.72 of 0.94..1.1 is 0.996..1.055: through unity, so the image
      // genuinely reverses direction rather than merely slowing down.
      { source: 'image.luminance', target: 'zoom', mode: 'replace', min: 0.35, max: 0.72, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'activity-mosh',
    name: 'Activity Mosh',
    techniqueId: 'motion-mosh',
    params: { flow: 1.2, threshold: 0.12, blockiness: 3, chromaDrift: 0.15, persistence: 0.985, injection: 0.5, mix: 1 },
    category: 'Reactive',
    description: 'A whole body moving tears the frame; a hand does not.',
    tags: ['reactive', 'motion', 'glitch'],
    mappings: [
      // Activity, not amount: this is the preset that has to tell a large
      // slow gesture from a small fast one, and only activity can.
      { source: 'motion.activity', target: 'injection', mode: 'replace', min: 0.25, max: 0.9, smoothing: SMOOTH_FAST },
      { source: 'motion.activity', target: 'blockiness', min: 0, max: 0.55, amount: 0.8, smoothing: SMOOTH_MID },
    ],
  },
  {
    slug: 'edge-memory',
    name: 'Edge Memory',
    techniqueId: 'feedback-bloom',
    params: { threshold: 0.5, radius: 2.2, gain: 1.2, zoom: 1.008, persistence: 0.9, injection: 0.6, mix: 1 },
    category: 'Reactive',
    description: 'Graphic frames hold on; soft frames let go.',
    tags: ['reactive', 'image', 'feedback'],
    mappings: [
      { source: 'image.edgeEnergy', target: 'persistence', mode: 'replace', min: 0.45, max: 0.92, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'motion-zoom',
    name: 'Motion Zoom',
    techniqueId: 'feedback-zoom',
    params: { zoom: 1.0, persistence: 0.96, injection: 0.45, mix: 1 },
    category: 'Reactive',
    description: 'Stillness holds the frame; movement pushes it forward.',
    tags: ['reactive', 'motion', 'feedback'],
    mappings: [
      { source: 'motion.amount', target: 'zoom', mode: 'replace', min: 0.42, max: 0.82, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'luma-pulse',
    name: 'Luma Pulse',
    techniqueId: 'mosaic',
    params: { scale: 1, spacing: 0.1, opacity: 1, rotation: 0 },
    category: 'Reactive',
    description: 'Tiles swell with the light in the frame.',
    tags: ['reactive', 'image', 'grid'],
    mappings: [
      { source: 'image.luminance', target: 'scale', mode: 'replace', min: 0.22, max: 0.78, smoothing: SMOOTH_MID },
    ],
  },
  {
    slug: 'vector-drift',
    name: 'Vector Drift',
    techniqueId: 'feedback-drift',
    params: { driftX: 0.4, driftY: 0, persistence: 0.93, injection: 0.6, mix: 1 },
    category: 'Reactive',
    description: 'Busy frames smear further, quiet ones settle.',
    tags: ['reactive', 'motion'],
    mappings: [
      { source: 'motion.activity', target: 'persistence', mode: 'replace', min: 0.35, max: 0.9, smoothing: SMOOTH_SLOW },
      { source: 'motion.x', target: 'driftX', min: -0.45, max: 0.45, smoothing: SMOOTH_MID },
    ],
  },
  {
    slug: 'contrast-bloom',
    name: 'Contrast Bloom',
    techniqueId: 'feedback-bloom',
    params: { threshold: 0.55, radius: 2.4, gain: 1.1, zoom: 1.006, persistence: 0.92, injection: 0.55, mix: 1 },
    category: 'Reactive',
    description: 'Flat frames glow soft; punchy ones blow out.',
    tags: ['reactive', 'image', 'feedback'],
    mappings: [
      { source: 'image.contrast', target: 'gain', mode: 'replace', min: 0.2, max: 0.72, smoothing: SMOOTH_SLOW },
      // Inverted: as contrast rises the bloom threshold drops, so the effect
      // compounds instead of cancelling itself out.
      { source: 'image.contrast', target: 'threshold', min: 0, max: 0.4, amount: 0.6, invert: true, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'follow-kaleido',
    name: 'Follow Kaleido',
    techniqueId: 'feedback-kaleido',
    params: { segments: 6, rotation: 0.8, zoom: 1.012, persistence: 0.93, injection: 0.55, mix: 1 },
    category: 'Reactive',
    description: 'The mirror turns toward whatever side of the frame is alive.',
    tags: ['reactive', 'motion', 'camera'],
    mappings: [
      { source: 'motion.centroidX', target: 'rotation', mode: 'replace', min: 0.3, max: 0.7, smoothing: SMOOTH_MID },
      { source: 'motion.activity', target: 'segments', min: 0, max: 0.5, amount: 0.7, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'slit-follow',
    name: 'Slit Follow',
    techniqueId: 'slit-scan',
    params: { strips: 128, spanSec: 1.2, offsetSec: 0, interpolate: 1 },
    category: 'Reactive',
    description: 'Where you move decides which slice of the past you see.',
    tags: ['reactive', 'motion', 'temporal'],
    mappings: [
      { source: 'motion.centroidX', target: 'offsetSec', mode: 'replace', min: 0, max: 0.45, smoothing: SMOOTH_MID },
      { source: 'motion.amount', target: 'spanSec', mode: 'replace', min: 0.25, max: 0.75, amount: 0.8, smoothing: SMOOTH_SLOW },
    ],
  },
  {
    slug: 'chroma-motion',
    name: 'Chroma Motion',
    techniqueId: 'feedback-rgb',
    params: { redShift: 2, greenShift: 1.2, blueShift: 2.6, zoom: 1.004, persistence: 0.93, injection: 0.55, mix: 1 },
    category: 'Reactive',
    description: 'Direction of movement splits the colour channels apart.',
    tags: ['reactive', 'motion', 'colour'],
    mappings: [
      { source: 'motion.x', target: 'redShift', min: -0.5, max: 0.5, smoothing: SMOOTH_MID },
      { source: 'motion.y', target: 'blueShift', min: -0.5, max: 0.5, smoothing: SMOOTH_MID },
    ],
  },
  {
    slug: 'edge-grid',
    name: 'Edge Grid',
    techniqueId: 'mosaic',
    params: { scale: 0.9, spacing: 0.25, opacity: 0.72, threshold: 0.05 },
    category: 'Reactive',
    description: 'The grid tightens around detail and opens over flat areas.',
    tags: ['reactive', 'image', 'grid'],
    mappings: [
      // Measured: 0.55..0.15 of the -0.5..0.95 spacing range drove it
      // NEGATIVE at high edge energy, which overlaps the tiles instead of
      // tightening them. 0.60..0.38 keeps the whole travel positive.
      { source: 'image.edgeEnergy', target: 'spacing', mode: 'replace', min: 0.6, max: 0.38, smoothing: SMOOTH_SLOW },
      // Base opacity was 1, so an additive mapping had nowhere to go and sat
      // clamped at the ceiling for every sample. The resting point has to
      // leave room for the modulation it is paired with.
      { source: 'image.luminance', target: 'opacity', min: 0, max: 0.35, amount: 0.8, smoothing: SMOOTH_MID },
    ],
  },
  {
    slug: 'still-life',
    name: 'Still Life',
    techniqueId: 'time-field',
    params: { scale: 1.1, speed: 0.2, depth: 0.8, offset: 0 },
    category: 'Reactive',
    description: 'Hold still and the past floods in. Move and it clears.',
    tags: ['reactive', 'motion', 'temporal'],
    mappings: [
      // Inverted on purpose: this is the counterpart to Movement Memory, and
      // having both proves the vocabulary reads in either direction.
      { source: 'motion.activity', target: 'depth', mode: 'replace', min: 0.85, max: 0.2, smoothing: SMOOTH_SLOW },
    ],
  },
];

export const SIGNAL_PRESETS: Preset[] = SPECS.map((spec) => ({
  id: `builtin-${spec.slug}`,
  name: spec.name,
  techniqueId: spec.techniqueId,
  params: spec.params,
  material: SQUARE,
  modulations: spec.mappings.map((m, i) => mapping(`${spec.slug}-${i}`, m)),
  triggers: [],
  builtin: true,
  category: spec.category,
  description: spec.description,
  tags: spec.tags,
}));
