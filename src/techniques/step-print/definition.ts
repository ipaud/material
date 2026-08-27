import type { TechniqueDefinition } from '../types';
import { StepPrintRenderer } from './StepPrintRenderer';

export const stepPrintDefinition: TechniqueDefinition = {
  id: 'step-print',
  name: 'Step Print',
  category: 'time',
  description: 'Holds and repeats stepped frames — stutter and trail.',
  sections: [
    {
      label: 'Step',
      params: [
        { type: 'number', id: 'stepSec', label: 'Frame Step', min: 0.01, max: 0.5, step: 0.005, default: 0.125, unit: 's', modulatable: true, explore: { randomizable: true, min: 0.04, max: 0.3 } },
        { type: 'number', id: 'copies', label: 'Copies', min: 1, max: 32, step: 1, default: 4, modulatable: true, explore: { randomizable: true, min: 2, max: 12 } },
        { type: 'number', id: 'hold', label: 'Hold', min: 1, max: 8, step: 1, default: 2, modulatable: true, explore: { randomizable: true, min: 1, max: 5 } },
        { type: 'number', id: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, default: 0.8, modulatable: true, explore: { randomizable: true, min: 0.4, max: 0.95 } },
      ],
    },
    {
      label: 'Offset',
      params: [
        { type: 'number', id: 'offsetX', label: 'Offset X', min: -20, max: 20, step: 0.1, default: 0, unit: '%', modulatable: true, explore: { randomizable: true, min: -6, max: 6 } },
        { type: 'number', id: 'offsetY', label: 'Offset Y', min: -20, max: 20, step: 0.1, default: 0, unit: '%', modulatable: true, explore: { randomizable: true, min: -6, max: 6 } },
      ],
    },
    {
      label: 'Mode',
      params: [
        {
          type: 'select',
          id: 'mode',
          label: 'Mode',
          options: [
            { value: 'accumulate', label: 'Accumulate' },
            { value: 'replace', label: 'Replace' },
            { value: 'pingpong', label: 'Ping Pong' },
            { value: 'random', label: 'Random (seeded)' },
          ],
          default: 'accumulate',
          explore: { randomizable: true, weight: 0.6 },
        },
        {
          type: 'select',
          id: 'blend',
          label: 'Blend',
          options: [
            { value: 'normal', label: 'Normal' },
            { value: 'add', label: 'Add' },
          ],
          default: 'normal',
          explore: { randomizable: true, weight: 0.4 },
        },
      ],
    },
  ],
  createRenderer: () => new StepPrintRenderer(),
};
