import type { TechniqueDefinition } from '../types';
import { TimeFieldRenderer } from './TimeFieldRenderer';

/**
 * CE1C — TIME FIELD. A field over image space chooses how far into the
 * temporal atlas each pixel reads. Depth/Offset are seconds within the
 * atlas span (2.29s); history is present→past only.
 */
export const timeFieldDefinition: TechniqueDefinition = {
  id: 'time-field',
  name: 'Time Field',
  description:
    'A spatial field decides which moment each pixel is made of — the generalized slit scan. Luminance mode lets the image sculpt its own time.',
  category: 'time',
  sections: [
    {
      label: 'Field',
      params: [
        {
          type: 'select',
          id: 'field',
          label: 'Field',
          options: [
            { value: 'horizontal', label: 'Horizontal' },
            { value: 'vertical', label: 'Vertical' },
            { value: 'radial', label: 'Radial' },
            { value: 'spiral', label: 'Spiral' },
            { value: 'noise', label: 'Noise' },
            { value: 'luminance', label: 'Luminance' },
            { value: 'edges', label: 'Edges' },
          ],
          default: 'radial',
          explore: { randomizable: true },
        },
        { type: 'boolean', id: 'invert', label: 'Invert', default: false, explore: { randomizable: true, weight: 0.4 } },
        { type: 'number', id: 'centerX', label: 'Center X', min: -0.5, max: 0.5, step: 0.01, default: 0, modulatable: true, explore: { randomizable: false } },
        { type: 'number', id: 'centerY', label: 'Center Y', min: -0.5, max: 0.5, step: 0.01, default: 0, modulatable: true, explore: { randomizable: false } },
        { type: 'number', id: 'scale', label: 'Scale', min: 0.2, max: 6, step: 0.05, default: 1, modulatable: true, explore: { randomizable: true, min: 0.5, max: 3 } },
        { type: 'number', id: 'speed', label: 'Speed', min: 0, max: 2, step: 0.01, default: 0.4, modulatable: true, explore: { randomizable: true, min: 0, max: 1 } },
      ],
    },
    {
      label: 'Time',
      params: [
        { type: 'number', id: 'depth', label: 'Depth', min: 0, max: 2.29, step: 0.01, default: 1.2, unit: 's', modulatable: true, explore: { randomizable: true, min: 0.3, max: 2.29 } },
        { type: 'number', id: 'offset', label: 'Offset', min: 0, max: 2.29, step: 0.01, default: 0, unit: 's', modulatable: true, explore: { randomizable: false } },
      ],
    },
  ],
  createRenderer: () => new TimeFieldRenderer(),
};
