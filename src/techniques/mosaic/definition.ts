import type { TechniqueDefinition } from '../types';
import { TEMPORAL_MODE_OPTIONS } from '@/rendering/shaders/temporal';
import { MosaicRenderer } from './MosaicRenderer';

export const mosaicDefinition: TechniqueDefinition = {
  id: 'mosaic',
  name: 'Mosaic',
  category: 'space',
  description: 'Reconstructs the source from a grid of repeated elements.',
  sections: [
    {
      label: 'Grid',
      params: [
        { type: 'number', id: 'columns', label: 'Columns', min: 2, max: 250, step: 1, default: 48, explore: { randomizable: true, min: 8, max: 160 } },
        { type: 'number', id: 'rows', label: 'Rows', min: 2, max: 250, step: 1, default: 27, explore: { randomizable: true, min: 8, max: 160 } },
      ],
    },
    {
      label: 'Element',
      params: [
        { type: 'number', id: 'scale', label: 'Scale', min: 0, max: 3, step: 0.01, default: 1, modulatable: true, explore: { randomizable: true, min: 0.4, max: 1.8 } },
        { type: 'number', id: 'minScale', label: 'Min Scale', min: 0, max: 1, step: 0.01, default: 0, explore: { randomizable: false } },
        { type: 'number', id: 'maxScale', label: 'Max Scale', min: 0, max: 4, step: 0.01, default: 2, explore: { randomizable: false } },
        { type: 'number', id: 'spacing', label: 'Spacing', min: -0.5, max: 0.95, step: 0.01, default: 0.1, modulatable: true, explore: { randomizable: true, min: -0.2, max: 0.6 } },
        { type: 'number', id: 'rotation', label: 'Rotation', min: -180, max: 180, step: 1, default: 0, unit: '°', modulatable: true, explore: { randomizable: true, weight: 0.6 } },
        { type: 'number', id: 'randomRotation', label: 'Random Rot', min: 0, max: 1, step: 0.01, default: 0, modulatable: true, explore: { randomizable: true, weight: 0.8 } },
        { type: 'number', id: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 1, modulatable: true, explore: { randomizable: false } },
      ],
    },
    {
      label: 'Sampling',
      params: [
        { type: 'number', id: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01, default: 0, modulatable: true, explore: { randomizable: true, min: 0, max: 0.5, weight: 0.7 } },
        { type: 'number', id: 'contrast', label: 'Contrast', min: 0, max: 4, step: 0.01, default: 1, explore: { randomizable: true, min: 0.5, max: 2.5 } },
        { type: 'number', id: 'gamma', label: 'Gamma', min: 0.2, max: 4, step: 0.01, default: 1, explore: { randomizable: true, min: 0.5, max: 2.2 } },
        { type: 'boolean', id: 'invert', label: 'Invert', default: false, explore: { randomizable: true, weight: 0.3 } },
      ],
    },
    {
      label: 'Mapping',
      params: [
        { type: 'number', id: 'lumToScale', label: 'Lum → Scale', min: -1, max: 1, step: 0.01, default: 0.85, explore: { randomizable: true } },
        { type: 'number', id: 'lumToRotation', label: 'Lum → Rotation', min: -1, max: 1, step: 0.01, default: 0, explore: { randomizable: true, weight: 0.5 } },
        { type: 'number', id: 'lumToOpacity', label: 'Lum → Opacity', min: -1, max: 1, step: 0.01, default: 0, explore: { randomizable: true, weight: 0.5 } },
        { type: 'number', id: 'lumToDepth', label: 'Lum → Depth', min: -1, max: 1, step: 0.01, default: 0, explore: { randomizable: true, weight: 0.5 } },
      ],
    },
    {
      label: 'Scatter',
      params: [
        { type: 'number', id: 'jitterX', label: 'Jitter X', min: 0, max: 2, step: 0.01, default: 0, modulatable: true, explore: { randomizable: true, min: 0, max: 1 } },
        { type: 'number', id: 'jitterY', label: 'Jitter Y', min: 0, max: 2, step: 0.01, default: 0, modulatable: true, explore: { randomizable: true, min: 0, max: 1 } },
      ],
    },
    {
      label: 'Temporal',
      params: [
        {
          type: 'select',
          id: 'tileMode',
          label: 'Tile Mode',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'tile', label: 'Video Tile' },
          ],
          default: 'off',
          explore: { randomizable: false },
        },
        {
          type: 'select',
          id: 'offsetMode',
          label: 'Distribution',
          options: TEMPORAL_MODE_OPTIONS,
          default: 'radial',
          explore: { randomizable: false },
        },
        {
          type: 'number',
          id: 'maxOffsetSec',
          label: 'Max Offset',
          min: 0,
          max: 2.29, // (56 - 1) / 24 — one full temporal buffer span
          step: 0.01,
          default: 1,
          unit: 's',
          modulatable: true,
          explore: { randomizable: false },
        },
        { type: 'number', id: 'falloff', label: 'Falloff', min: 0.2, max: 4, step: 0.01, default: 1, modulatable: true, explore: { randomizable: true, min: 0.4, max: 2.5, weight: 0.5 } },
        {
          type: 'select',
          id: 'temporalDirection',
          label: 'Direction',
          options: [
            { value: 'outward', label: 'Outward (center = now)' },
            { value: 'inward', label: 'Inward (center = past)' },
          ],
          default: 'outward',
          explore: { randomizable: false },
        },
        { type: 'number', id: 'centerX', label: 'Center X', min: -0.5, max: 0.5, step: 0.01, default: 0, modulatable: true, explore: { randomizable: false } },
        { type: 'number', id: 'centerY', label: 'Center Y', min: -0.5, max: 0.5, step: 0.01, default: 0, modulatable: true, explore: { randomizable: false } },
      ],
    },
    {
      label: 'Depth',
      params: [
        { type: 'number', id: 'depth', label: 'Depth', min: 0, max: 1200, step: 1, default: 0, unit: 'px', modulatable: true, explore: { randomizable: true, min: 0, max: 600 } },
        { type: 'number', id: 'perspective', label: 'Perspective', min: 0, max: 1, step: 0.01, default: 0.35, explore: { randomizable: false } },
      ],
    },
  ],
  createRenderer: () => new MosaicRenderer(),
};
