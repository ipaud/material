import type { TechniqueDefinition } from '../types';
import { SlitScanRenderer } from './SlitScanRenderer';

export const slitScanDefinition: TechniqueDefinition = {
  id: 'slit-scan',
  name: 'Slit Scan',
  category: 'time',
  chainBehavior: 'temporal',
  description: 'Maps image position to different moments in time.',
  sections: [
    {
      label: 'Scan',
      params: [
        {
          type: 'select',
          id: 'axis',
          label: 'Axis',
          options: [
            { value: 'horizontal', label: 'Horizontal' },
            { value: 'vertical', label: 'Vertical' },
          ],
          default: 'horizontal',
          explore: { randomizable: true, weight: 0.5 },
        },
        { type: 'number', id: 'strips', label: 'Strips', min: 2, max: 512, step: 1, default: 96, modulatable: true, explore: { randomizable: true, min: 8, max: 300 } },
        { type: 'number', id: 'spanSec', label: 'Time Span', min: 0, max: 2.29, step: 0.01, default: 1.2, unit: 's', modulatable: true, explore: { randomizable: true, min: 0.2, max: 2 } },
        { type: 'number', id: 'offsetSec', label: 'Offset', min: 0, max: 2.29, step: 0.01, default: 0, unit: 's', modulatable: true, explore: { randomizable: false } },
        {
          type: 'select',
          id: 'direction',
          label: 'Direction',
          options: [
            { value: 'forward', label: 'Forward' },
            { value: 'reverse', label: 'Reverse' },
          ],
          default: 'forward',
          explore: { randomizable: true, weight: 0.4 },
        },
        { type: 'number', id: 'interpolate', label: 'Smooth', min: 0, max: 1, step: 0.01, default: 0, modulatable: true, explore: { randomizable: true, weight: 0.5 } },
      ],
    },
  ],
  createRenderer: () => new SlitScanRenderer(),
};
