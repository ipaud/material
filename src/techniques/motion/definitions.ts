import type { TechniqueDefinition } from '../types';
import { FlowPassRenderer } from './FlowPassRenderer';
import { FeedbackRenderer } from '../feedback/FeedbackRenderer';

/**
 * CE1D — the Motion Pack. Every technique consumes the SHARED optical-flow
 * service (ctx.flow); none runs its own analysis. Stateless passes use
 * FlowPassRenderer; stateful ones reuse the CE1B feedback primitive with
 * flow-driven variants (advect/mosh/trails) — no new state architecture.
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

export const motionDefinitions: TechniqueDefinition[] = [
  {
    id: 'flow-displace',
    name: 'Flow Displace',
    description: 'Pixels drag along their own estimated motion — or pull against it.',
    category: 'image',
    sections: [
      {
        label: 'Motion',
        params: [
          num('amount', 'Amount', 0, 4, 0.01, 1.2, { min: 0.3, max: 2.5 }),
          num('threshold', 'Threshold', 0, 0.5, 0.005, 0.04, { min: 0, max: 0.2 }),
          { type: 'boolean', id: 'against', label: 'Against Motion', default: false, explore: { randomizable: true, weight: 0.4 } },
        ],
      },
    ],
    createRenderer: () => new FlowPassRenderer('displace'),
  },
  {
    id: 'motion-rgb',
    name: 'Motion RGB',
    description: 'Motion splits the channels: red rides ahead, blue lags behind.',
    category: 'image',
    sections: [
      {
        label: 'Motion',
        params: [
          num('amount', 'Amount', 0, 3, 0.01, 1, { min: 0.3, max: 2 }),
          num('threshold', 'Threshold', 0, 0.5, 0.005, 0.03, { min: 0, max: 0.15 }),
        ],
      },
    ],
    createRenderer: () => new FlowPassRenderer('rgb'),
  },
  {
    id: 'directional-smear',
    name: 'Directional Smear',
    description: 'Each pixel smears along its motion vector — painterly speed lines.',
    category: 'image',
    sections: [
      {
        label: 'Motion',
        params: [
          num('amount', 'Length', 0, 4, 0.01, 1.6, { min: 0.4, max: 3 }),
          num('samples', 'Samples', 2, 16, 1, 8, { min: 4, max: 12 }),
          num('threshold', 'Threshold', 0, 0.5, 0.005, 0.05, { min: 0, max: 0.2 }),
        ],
      },
    ],
    createRenderer: () => new FlowPassRenderer('smear'),
  },
  {
    id: 'flow-feedback',
    name: 'Flow Feedback',
    description: 'The persistent state is carried by the image’s own motion — wakes, currents, liquid smear.',
    category: 'feedback',
    sections: [
      {
        label: 'Motion',
        params: [
          num('flow', 'Flow', 0, 3, 0.01, 1, { min: 0.3, max: 2 }),
        ],
      },
      {
        label: 'State',
        params: [
          num('persistence', 'Persistence', 0.5, 0.995, 0.001, 0.94, { min: 0.85, max: 0.99 }),
          num('injection', 'Injection', 0, 1, 0.01, 0.5, { min: 0.2, max: 0.8 }),
          num('mix', 'Mix', 0, 1, 0.01, 1),
        ],
      },
    ],
    createRenderer: () => new FeedbackRenderer('flow'),
  },
  {
    id: 'motion-mosh',
    name: 'Motion Mosh',
    description: 'Moving regions drag old pixels with them; still regions refresh — datamosh grammar, honestly procedural (no codec involved).',
    category: 'feedback',
    sections: [
      {
        label: 'Motion',
        params: [
          num('flow', 'Motion', 0, 3, 0.01, 1.2, { min: 0.4, max: 2.2 }),
          num('threshold', 'Threshold', 0, 1, 0.01, 0.12, { min: 0.05, max: 0.4 }),
          num('blockiness', 'Blockiness', 0, 10, 0.1, 3, { min: 0, max: 8 }),
          num('chromaDrift', 'Chroma Drift', 0, 1, 0.01, 0.15, { min: 0, max: 0.5 }),
        ],
      },
      {
        label: 'State',
        params: [
          num('persistence', 'Persistence', 0.5, 0.995, 0.001, 0.985, { min: 0.9, max: 0.995 }),
          num('injection', 'Injection', 0, 1, 0.01, 0.65, { min: 0.3, max: 0.9 }),
          num('mix', 'Mix', 0, 1, 0.01, 1),
        ],
      },
    ],
    createRenderer: () => new FeedbackRenderer('mosh'),
  },
  {
    id: 'motion-trails',
    name: 'Motion Trails',
    description: 'Whatever moves leaves a wake; whatever is still stays clean.',
    category: 'feedback',
    sections: [
      {
        label: 'Motion',
        params: [
          num('flow', 'Flow', 0, 2, 0.01, 0.6, { min: 0.2, max: 1.5 }),
          num('threshold', 'Threshold', 0, 1, 0.01, 0.08, { min: 0.02, max: 0.3 }),
        ],
      },
      {
        label: 'State',
        params: [
          num('persistence', 'Persistence', 0.5, 0.995, 0.001, 0.95, { min: 0.88, max: 0.99 }),
          num('injection', 'Injection', 0, 1, 0.01, 0.85, { min: 0.5, max: 1 }),
          num('mix', 'Mix', 0, 1, 0.01, 1),
        ],
      },
    ],
    createRenderer: () => new FeedbackRenderer('trails'),
  },
];
