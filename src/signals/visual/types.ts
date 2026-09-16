/**
 * v0.4A — the image itself as a modulation signal.
 *
 * Two layers, deliberately separate:
 *   RAW         a physically meaningful measurement in stated units
 *   CALIBRATED  a performatively useful 0..1 for the CURRENT source
 *
 * The split exists because CE1H proved "numerically correct" and "playable"
 * are different properties: on the reference track the `mids` band never
 * exceeds 0.181 and `highs` 0.058 across a whole song. Both numbers are right.
 * Both knobs are dead.
 *
 * A signal is only useful if a Look mapping `Luminance → Depth` keeps working
 * when the source changes from a dark clip to a bright generator.
 */

export type VisualSignalId =
  | 'image.luminance'
  | 'image.contrast'
  | 'image.edgeEnergy'
  | 'motion.amount'
  | 'motion.activity'
  | 'motion.x'
  | 'motion.y'
  | 'motion.centroidX'
  | 'motion.centroidY';

export type SignalFamily = 'image' | 'motion';

/**
 * `centred` signals carry direction: 0.5 is the rest position, not zero.
 * `position` signals are already a coordinate in the source's own frame, and
 * stretching them per source would move things to the wrong place.
 */
export type SignalDomain = 'unipolar' | 'centred' | 'position';

/**
 * `inactive` MUST be expressed as absence from the source-value record, never
 * as 0 — absence is the evaluator's established neutral (evaluator.ts:120),
 * whereas 0 combined with `invert` or a non-zero `min` manufactures a
 * contribution out of silence.
 */
export type SignalValidity = 'valid' | 'warming' | 'inactive';

export interface VisualSignalDef {
  id: VisualSignalId;
  label: string;
  family: SignalFamily;
  domain: SignalDomain;
  /** RAW unit, for docs and the scope — never left as "amount". */
  unit: string;
  /**
   * False when the raw value is ALREADY intrinsically normalised and
   * per-source calibration would only add lag or destroy meaning. Three
   * reasons occur here, and they are different:
   *
   *  - `motion.x`/`motion.y` are magnitude-weighted means of the unit
   *    direction, so the weight cancels analytically and the result is bounded
   *    to ±1 by construction;
   *  - `motion.centroidX`/`Y` are POSITIONS. Rescaling a position to "usable
   *    travel" would put the effect somewhere the motion is not, which is the
   *    one thing a positional signal must never do;
   *  - `motion.activity` is already a physical fraction of the frame. "Half
   *    the frame is moving" is a statement a performer can reason about, and
   *    calibration would turn it into "more than usual for this source".
   */
  calibrated: boolean;
  /** Mapping range the UI offers by default. A centred signal needs -1..1 so
   * that "still" contributes nothing. */
  defaultMapping: { min: number; max: number };
}

export const VISUAL_SIGNALS: readonly VisualSignalDef[] = [
  {
    id: 'image.luminance',
    label: 'Luminance',
    family: 'image',
    unit: 'Rec.709 luma, 0..1, display-referred',
    domain: 'unipolar',
    calibrated: true,
    defaultMapping: { min: 0, max: 1 },
  },
  {
    id: 'image.contrast',
    label: 'Contrast',
    family: 'image',
    // A standard deviation, not an ad-hoc spread: sqrt(E[L^2] - E[L]^2), which
    // the ladder gets for one extra accumulator. A flat frame of ANY
    // brightness reads 0, which is what makes it independent of luminance.
    unit: 'luma standard deviation, 0..0.5',
    domain: 'unipolar',
    calibrated: true,
    defaultMapping: { min: 0, max: 1 },
  },
  {
    id: 'image.edgeEnergy',
    label: 'Edge Energy',
    family: 'image',
    // Mean |grad L| over the analysis grid. Distinct from contrast because it
    // is LOCAL: a smooth black-to-white ramp has high contrast and almost no
    // edge energy, and that pair is the fixture that proves they differ.
    unit: 'luma per analysis texel',
    domain: 'unipolar',
    calibrated: true,
    defaultMapping: { min: 0, max: 1 },
  },
  {
    id: 'motion.amount',
    label: 'Motion Amount',
    family: 'motion',
    unit: 'analysis texels / frame',
    domain: 'unipolar',
    calibrated: true,
    defaultMapping: { min: 0, max: 1 },
  },
  {
    id: 'motion.activity',
    label: 'Motion Activity',
    family: 'motion',
    // How MUCH of the frame is moving, against how FAST it moves. A small fast
    // patch and a large slow field can produce the same `amount`; they never
    // produce the same `activity`.
    unit: 'fraction of frame moving, 0..1',
    domain: 'unipolar',
    calibrated: false,
    defaultMapping: { min: 0, max: 1 },
  },
  {
    id: 'motion.x',
    label: 'Motion X',
    family: 'motion',
    unit: 'unit direction, 0.5 = still',
    domain: 'centred',
    calibrated: false,
    defaultMapping: { min: -1, max: 1 },
  },
  {
    id: 'motion.y',
    label: 'Motion Y',
    family: 'motion',
    unit: 'unit direction, 0.5 = still, 1 = up',
    domain: 'centred',
    calibrated: false,
    defaultMapping: { min: -1, max: 1 },
  },
  {
    id: 'motion.centroidX',
    label: 'Motion Centre X',
    family: 'motion',
    unit: 'normalised position, 0 = left, 1 = right',
    domain: 'position',
    calibrated: false,
    defaultMapping: { min: 0, max: 1 },
  },
  {
    id: 'motion.centroidY',
    label: 'Motion Centre Y',
    family: 'motion',
    unit: 'normalised position, 0 = top, 1 = bottom',
    domain: 'position',
    calibrated: false,
    defaultMapping: { min: 0, max: 1 },
  },
] as const;

export const VISUAL_SIGNAL_IDS: readonly VisualSignalId[] = VISUAL_SIGNALS.map((s) => s.id);

export function visualSignalDef(id: string): VisualSignalDef | null {
  return VISUAL_SIGNALS.find((s) => s.id === id) ?? null;
}

export function isVisualSignalId(id: string): id is VisualSignalId {
  return VISUAL_SIGNALS.some((s) => s.id === id);
}

/** One analysis result. RAW units throughout — calibration happens later. */
export interface RawVisualStats {
  /** Covered texel count. Equals gridWidth*gridHeight exactly, always. */
  n: number;
  /** Mean Rec.709 luma, 0..1. */
  luminance: number;
  /** Standard deviation of luma over the frame. Flat frame = 0, at any
   * brightness. Maximum 0.5, reached by an ideal black/white split. */
  contrast: number;
  /** Mean gradient magnitude in luma per analysis texel — structure, measured
   * at the analysis grid rather than at source resolution. */
  edgeEnergy: number;
  /** Mean flow magnitude in ANALYSIS TEXELS per REFERENCE FRAME (1/30 s) —
   * grid-, resolution- and frame-rate-independent, so preview and export
   * agree even when their analysis grids or cadences differ. The reducer
   * emits texels per measured frame; the layer runtime rescales by the flow
   * pair's spacing (`referenceMotionScale`) before publishing. */
  motionAmount: number;
  /** 0.5 + 0.5 * (weighted mean unit direction x), so 0.5 is exactly still. */
  motionX: number;
  /** Same for y. 1 is up the screen. */
  motionY: number;
  /** Fraction of analysis texels displaced past ACTIVITY_TEXELS. */
  motionActivity: number;
  /** Magnitude-weighted mean position of motion, 0 = left. 0.5 when invalid. */
  centroidX: number;
  /** Magnitude-weighted mean position of motion, 0 = top. 0.5 when invalid. */
  centroidY: number;
  /** False when the frame's displacement exceeded what Lucas-Kanade can
   * resolve (a seek, a source switch, a camera waking up). Diagnostic only:
   * the value is still published and still calibrated. */
  motionValid: boolean;
  /** False when there is too little motion for a first moment to mean
   * anything. Dividing noise by noise gives a position that jitters across the
   * whole frame, which looks exactly like tracking and is not. */
  centroidValid: boolean;
  /** False when no flow field was available; motion.* keys are then omitted
   * from publication rather than published as zero. */
  hasFlow: boolean;
}
