import type { TechniqueDefinition } from '../types';
import { EchoRenderer } from './EchoRenderer';

export const echoDefinition: TechniqueDefinition = {
  id: 'echo',
  name: 'Echo',
  category: 'time',
  description: 'Repeats the image across time — each copy samples an older frame.',
  sections: [
    {
      label: 'Copies',
      params: [
        { type: 'number', id: 'copies', label: 'Copies', min: 1, max: 64, step: 1, default: 8, modulatable: true, explore: { randomizable: true, min: 2, max: 24 } },
        { type: 'number', id: 'delaySec', label: 'Delay', min: 0, max: 0.5, step: 0.005, default: 0.12, unit: 's', modulatable: true, explore: { randomizable: true, min: 0.02, max: 0.3 } },
        { type: 'number', id: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, default: 0.78, modulatable: true, explore: { randomizable: true, min: 0.4, max: 0.95 } },
      ],
    },
    {
      label: 'Transform',
      params: [
        { type: 'number', id: 'offsetX', label: 'Offset X', min: -20, max: 20, step: 0.1, default: 1.5, unit: '%', modulatable: true, explore: { randomizable: true, min: -8, max: 8 } },
        { type: 'number', id: 'offsetY', label: 'Offset Y', min: -20, max: 20, step: 0.1, default: 0, unit: '%', modulatable: true, explore: { randomizable: true, min: -8, max: 8 } },
        { type: 'number', id: 'copyScale', label: 'Scale', min: 0.8, max: 1.2, step: 0.001, default: 1.01, modulatable: true, explore: { randomizable: true, min: 0.94, max: 1.06 } },
        { type: 'number', id: 'copyRotation', label: 'Rotation', min: -30, max: 30, step: 0.1, default: 0, unit: '°', modulatable: true, explore: { randomizable: true, min: -8, max: 8 } },
        { type: 'number', id: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 1, modulatable: true, explore: { randomizable: false } },
      ],
    },
    {
      label: 'Distribution',
      params: [
        {
          type: 'select',
          id: 'distribution',
          label: 'Spread',
          options: [
            { value: 'linear', label: 'Linear' },
            { value: 'radial', label: 'Radial' },
            { value: 'random', label: 'Random (seeded)' },
          ],
          default: 'linear',
          explore: { randomizable: true, weight: 0.5 },
        },
        {
          type: 'select',
          id: 'blend',
          label: 'Blend',
          options: [
            { value: 'normal', label: 'Normal' },
            { value: 'add', label: 'Add' },
            { value: 'screen', label: 'Screen' },
          ],
          default: 'normal',
          explore: { randomizable: true, weight: 0.4 },
        },
      ],
    },
  ],
  createRenderer: () => new EchoRenderer(),
};
