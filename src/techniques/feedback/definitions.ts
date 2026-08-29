import type { TechniqueDefinition } from '../types';
import { FeedbackRenderer } from './FeedbackRenderer';
import type { FeedbackVariant } from '@/rendering/feedback/feedbackStep';

/**
 * CE1B — the feedback family. Seven techniques over ONE primitive; every
 * definition is uniforms over the shared step shader (see FeedbackRenderer).
 *
 * Parameter conventions (identical across the family, §42-43):
 *   Persistence  0..1  how much state survives one step (1 ≈ infinite)
 *   Injection    0..1  how much fresh frame enters the state
 *   Mix          0..1  wet/dry of the visible result
 * Ranges are curated for playability (§41): zoom lives in 0.94–1.10, not
 * 0–10; rotation is degrees per STEP (±10), not absolute angle.
 */

const num = (
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  explore?: { min: number; max: number },
) =>
  ({
    type: 'number',
    id,
    label,
    min,
    max,
    step,
    default: def,
    modulatable: true,
    explore: explore ? { randomizable: true, ...explore } : { randomizable: false },
  }) as const;

const COMMON_STATE = (persistence: number, injection: number) => [
  num('persistence', 'Persistence', 0.5, 0.995, 0.001, persistence, { min: 0.8, max: 0.99 }),
  num('injection', 'Injection', 0, 1, 0.01, injection, { min: 0.2, max: 0.9 }),
  num('mix', 'Mix', 0, 1, 0.01, 1),
];

function def(
  id: string,
  name: string,
  description: string,
  variant: FeedbackVariant,
  bloom: boolean,
  sections: TechniqueDefinition['sections'],
): TechniqueDefinition {
  return {
    id,
    name,
    description,
    category: 'feedback',
    sections,
    createRenderer: () => new FeedbackRenderer(variant, bloom),
  };
}

export const feedbackDefinitions: TechniqueDefinition[] = [
  def(
    'feedback-zoom',
    'Feedback Zoom',
    'The previous frame re-enters the image slightly scaled — tunnels, halls of mirrors, infinite descent.',
    'affine',
    false,
    [
      {
        label: 'Motion',
        params: [
          num('zoom', 'Zoom', 0.94, 1.1, 0.001, 1.02, { min: 0.97, max: 1.06 }),
          num('centerX', 'Center X', -0.5, 0.5, 0.01, 0),
          num('centerY', 'Center Y', -0.5, 0.5, 0.01, 0),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.94, 0.5) },
    ],
  ),
  def(
    'feedback-rotate',
    'Feedback Rotate',
    'The past spirals around a center while new frames burn in — vortices and slow orbital echoes.',
    'affine',
    false,
    [
      {
        label: 'Motion',
        params: [
          num('rotation', 'Rotation', -10, 10, 0.1, 1.5, { min: -5, max: 5 }),
          num('zoom', 'Zoom', 0.96, 1.06, 0.001, 1.005, { min: 0.98, max: 1.03 }),
          num('centerX', 'Center X', -0.5, 0.5, 0.01, 0),
          num('centerY', 'Center Y', -0.5, 0.5, 0.01, 0),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.93, 0.55) },
    ],
  ),
  def(
    'feedback-drift',
    'Feedback Drift',
    'State slides steadily in one direction — signal drift, falling memories, sideways smears.',
    'affine',
    false,
    [
      {
        label: 'Motion',
        params: [
          num('driftX', 'X Drift', -3, 3, 0.02, 0.6, { min: -1.5, max: 1.5 }),
          num('driftY', 'Y Drift', -3, 3, 0.02, 0, { min: -1.5, max: 1.5 }),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.92, 0.6) },
    ],
  ),
  def(
    'feedback-displace',
    'Feedback Displace',
    'A noise field warps the past a little more every step — melting, boiling, organic decay.',
    'displace',
    false,
    [
      {
        label: 'Field',
        params: [
          num('amount', 'Amount', 0, 3, 0.01, 1, { min: 0.3, max: 2 }),
          num('scale', 'Scale', 1, 20, 0.1, 6, { min: 2, max: 12 }),
          num('speed', 'Speed', 0, 5, 0.01, 1, { min: 0.2, max: 3 }),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.9, 0.65) },
    ],
  ),
  def(
    'feedback-kaleido',
    'Feedback Kaleido',
    'Feedback folded through mirror segments — living mandalas that inhale the source.',
    'kaleido',
    false,
    [
      {
        label: 'Symmetry',
        params: [
          num('segments', 'Segments', 2, 16, 1, 6, { min: 3, max: 12 }),
          num('rotation', 'Rotation', -10, 10, 0.1, 1.2, { min: -4, max: 4 }),
          num('zoom', 'Zoom', 0.96, 1.08, 0.001, 1.015, { min: 0.98, max: 1.04 }),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.93, 0.55) },
    ],
  ),
  def(
    'feedback-bloom',
    'Feedback Bloom',
    'Bright regions bleed light into the persistent state — phosphorescent accumulation.',
    'affine',
    true,
    [
      {
        label: 'Bloom',
        params: [
          num('threshold', 'Threshold', 0, 1, 0.01, 0.55, { min: 0.3, max: 0.8 }),
          num('radius', 'Radius', 0.5, 6, 0.1, 2, { min: 1, max: 4 }),
          num('gain', 'Gain', 0, 3, 0.01, 1.2, { min: 0.5, max: 2 }),
          num('zoom', 'Zoom', 0.97, 1.05, 0.001, 1.008),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.9, 0.6) },
    ],
  ),
  def(
    'feedback-rgb',
    'RGB Feedback',
    'Each channel of the past drifts on its own axis — chromatic ghosts and color memory.',
    'rgb',
    false,
    [
      {
        label: 'Channels',
        params: [
          num('redShift', 'Red Shift', 0, 8, 0.05, 2.2, { min: 0, max: 5 }),
          num('greenShift', 'Green Shift', 0, 8, 0.05, 1.2, { min: 0, max: 5 }),
          num('blueShift', 'Blue Shift', 0, 8, 0.05, 3, { min: 0, max: 5 }),
          num('zoom', 'Zoom', 0.97, 1.04, 0.001, 1.004),
        ],
      },
      { label: 'State', params: COMMON_STATE(0.93, 0.55) },
    ],
  ),
];
