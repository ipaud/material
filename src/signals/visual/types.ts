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

export type VisualSignalId = 'image.luminance' | 'motion.amount' | 'motion.x';

export type SignalFamily = 'image' | 'motion';

/** `centred` signals carry direction: 0.5 is the rest position, not zero. */
export type SignalDomain = 'unipolar' | 'centred';

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
   * per-source calibration would only add lag. `motion.x` is the case: it is
   * a magnitude-weighted mean of the unit direction, so the weight cancels
   * analytically and the result is bounded to ±1 by construction.
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
    id: 'motion.amount',
    label: 'Motion Amount',
    family: 'motion',
    unit: 'analysis texels / frame',
    domain: 'unipolar',
    calibrated: true,
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
  /** Mean flow magnitude in ANALYSIS TEXELS per frame — grid- and
   * resolution-independent, so preview and export agree even when their
   * analysis grids differ. */
  motionAmount: number;
  /** 0.5 + 0.5 * (weighted mean unit direction x), so 0.5 is exactly still. */
  motionX: number;
  /** False when the frame's displacement exceeded what Lucas-Kanade can
   * resolve (a seek, a source switch, a camera waking up). The field is then
   * saturated garbage, not a big number, so motion.* is omitted exactly as it
   * is when there is no field at all. */
  motionValid: boolean;
  /** False when no flow field was available; motion.* keys are then omitted
   * from publication rather than published as zero. */
  hasFlow: boolean;
}
