import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { withTechniqueEnsured } from '@/projects/projectActions';
import { uid } from '@/utils/id';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import type { Preset } from '@shared/schemas/preset';

/** Built-in starting points. Source media is never part of a preset. */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-clean-mosaic',
    category: 'Minimal',
    description: 'The neutral starting grid — the image, politely tiled.',
    tags: ['clean'],
    name: 'Clean Mosaic',
    techniqueId: 'mosaic',
    params: { columns: 64, rows: 36, scale: 1, spacing: 0.15, lumToScale: 0.9 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [],
    builtin: true,
  },
  {
    id: 'builtin-dense-grid',
    category: 'Geometry',
    description: 'A tight uniform grid with punchy contrast.',
    tags: ['grid'],
    name: 'Dense Grid',
    techniqueId: 'mosaic',
    params: { columns: 160, rows: 90, scale: 1.1, spacing: 0, lumToScale: 1, contrast: 1.3 },
    material: { materialId: 'circle', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [],
    builtin: true,
  },
  {
    id: 'builtin-broken-portrait',
    category: 'Digital Damage',
    description: 'Scattered, thresholded cells fracture the face.',
    tags: ['glitch'],
    name: 'Broken Portrait',
    techniqueId: 'mosaic',
    params: {
      columns: 72,
      rows: 96,
      scale: 1.2,
      spacing: 0.05,
      lumToScale: 1,
      randomRotation: 0.12,
      jitterX: 0.35,
      jitterY: 0.2,
      threshold: 0.08,
    },
    material: { materialId: 'rectangle', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [],
    builtin: true,
  },
  {
    id: 'builtin-halftone',
    category: 'Optical',
    description: 'Classic halftone: luminance becomes dot size.',
    tags: ['halftone', 'dots'],
    name: 'Halftone',
    techniqueId: 'mosaic',
    params: { columns: 96, rows: 54, scale: 1.3, spacing: 0.1, lumToScale: 1, gamma: 1.4 },
    material: { materialId: 'dot', colorMode: 'mono', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [],
    builtin: true,
  },
  {
    // Official system preset (Phase 5 creative review): the past reaches
    // further from center when the low end hits. Needs a video source.
    id: 'builtin-echo-chamber',
    category: 'Temporal',
    description: 'Video tiles reach further into the past away from center; bass extends recall.',
    tags: ['time', 'audio'],
    name: 'Echo Chamber',
    techniqueId: 'mosaic',
    params: {
      columns: 18,
      rows: 11,
      scale: 1,
      spacing: 0.08,
      lumToScale: 0.4,
      tileMode: 'tile',
      offsetMode: 'radial',
      temporalDirection: 'outward', // center = now, outer = progressively older
      maxOffsetSec: 0.9,
      falloff: 1,
      centerX: 0,
      centerY: 0,
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'echo-bass-offset',
        enabled: true,
        source: 'bass',
        target: 'maxOffsetSec',
        amount: 0.6,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.3,
        curve: 'linear',
        frozenValue: null,
      },
    ],
    triggers: [],
    builtin: true,
  },
  {
    // System preset: every tile holds a different, seeded moment — a broken
    // mirror in time. Bass widens the spread. Needs a video source.
    id: 'builtin-time-fracture',
    category: 'Temporal',
    description: 'Every tile holds a different seeded moment — a broken mirror in time.',
    tags: ['time', 'random'],
    name: 'Time Fracture',
    techniqueId: 'mosaic',
    params: {
      columns: 24,
      rows: 14,
      scale: 1,
      spacing: 0.02,
      lumToScale: 0,
      tileMode: 'tile',
      offsetMode: 'random',
      maxOffsetSec: 2,
      falloff: 1,
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'fracture-bass-offset',
        enabled: true,
        source: 'bass',
        target: 'maxOffsetSec',
        amount: 0.5,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null,
      },
    ],
    triggers: [],
    builtin: true,
  },
  {
    // System preset (spec §50): the image loses modules as energy rises —
    // disintegration by threshold and scatter, not a fire simulation.
    id: 'builtin-slow-burn',
    category: 'Performance',
    description: 'The image disintegrates as energy rises — threshold and scatter, driven by audio.',
    tags: ['audio', 'decay'],
    name: 'Slow Burn',
    techniqueId: 'mosaic',
    params: {
      columns: 96,
      rows: 54,
      scale: 1.15,
      spacing: 0.08,
      lumToScale: 0.9,
      threshold: 0.05,
      contrast: 1.2,
      randomRotation: 0.08,
      tileMode: 'off',
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'burn-time-threshold',
        enabled: true,
        source: 'time',
        target: 'threshold',
        amount: 0.55,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.15,
        curve: 'linear',
        frozenValue: null,
      },
      {
        id: 'burn-master-scatter',
        enabled: true,
        source: 'master',
        target: 'jitterX',
        amount: 0.35,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.3,
        curve: 'linear',
        frozenValue: null,
      },
      {
        id: 'burn-transient-scatter',
        enabled: true,
        source: 'transients',
        target: 'jitterY',
        amount: 0.3,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.1,
        curve: 'exponential',
        frozenValue: null,
      },
    ],
    triggers: [],
    builtin: true,
  },
  {
    // Official system preset — the pump as a beat-triggered pulse envelope.
    // Replaced the Phase 5 continuous-phase version after a measured
    // comparison (Phase 12): pulse holds a stable base and snaps on the hit;
    // the continuous version smeared 0.58-0.88 with no resting state.
    id: 'builtin-pump',
    category: 'Performance',
    description: 'Cells inflate on the low end. The room breathes.',
    tags: ['bass', 'beat'],
    name: 'Pump',
    techniqueId: 'mosaic',
    params: { columns: 64, rows: 36, scale: 0.85, spacing: 0.12, lumToScale: 0.9 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [
      {
        id: 'pump2-beat-scale',
        enabled: true,
        source: 'beat',
        action: 'pulse',
        targetParam: 'scale',
        targetMappingId: null,
        lookSlot: null,
        quantize: 'off',
        cooldownSec: 0,
        attackSec: 0,
        holdSec: 0.02,
        decaySec: 0.22,
        amount: 0.28,
        curve: 'exponential',
      },
    ],
    builtin: true,
  },
  {
    // HIT (§25): reacts to discrete musical attacks, not continuous loudness.
    id: 'builtin-hit',
    category: 'Performance',
    description: 'Transient-triggered scatter pulses.',
    tags: ['transients'],
    name: 'Hit',
    techniqueId: 'mosaic',
    params: { columns: 72, rows: 40, scale: 1, spacing: 0.1, lumToScale: 0.9 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [
      {
        id: 'hit-onset-jx',
        enabled: true,
        source: 'onset',
        action: 'pulse',
        targetParam: 'jitterX',
        targetMappingId: null,
        lookSlot: null,
        quantize: 'off',
        cooldownSec: 0,
        attackSec: 0,
        holdSec: 0.02,
        decaySec: 0.18,
        amount: 0.4,
        curve: 'easeOut',
      },
      {
        id: 'hit-onset-jy',
        enabled: true,
        source: 'onset',
        action: 'pulse',
        targetParam: 'jitterY',
        targetMappingId: null,
        lookSlot: null,
        quantize: 'off',
        cooldownSec: 0,
        attackSec: 0,
        holdSec: 0.02,
        decaySec: 0.18,
        amount: 0.3,
        curve: 'easeOut',
      },
    ],
    builtin: true,
  },
  {
    // MEMORY HIT (§19C): every musical attack throws the tiles into the past.
    id: 'builtin-memory-hit',
    category: 'Performance',
    description: 'Onsets kick tiles into the past for a moment.',
    tags: ['time', 'transients'],
    name: 'Memory Hit',
    techniqueId: 'mosaic',
    params: {
      columns: 16,
      rows: 10,
      scale: 1,
      spacing: 0.06,
      lumToScale: 0.3,
      tileMode: 'tile',
      offsetMode: 'radial',
      temporalDirection: 'outward',
      maxOffsetSec: 0.15,
      falloff: 1,
    },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [
      {
        id: 'memory-onset-offset',
        enabled: true,
        source: 'onset',
        action: 'pulse',
        targetParam: 'maxOffsetSec',
        targetMappingId: null,
        lookSlot: null,
        quantize: 'off',
        cooldownSec: 0.15,
        attackSec: 0,
        holdSec: 0.05,
        decaySec: 0.45,
        amount: 0.5,
        curve: 'easeOut',
      },
    ],
    builtin: true,
  },
  {
    // BAR SHIFT (§19D): once per bar the whole system leans and deepens.
    id: 'builtin-bar-shift',
    category: 'Performance',
    description: 'The composition re-seats itself every bar.',
    tags: ['beat'],
    name: 'Bar Shift',
    techniqueId: 'mosaic',
    params: { columns: 56, rows: 32, scale: 1, spacing: 0.1, lumToScale: 0.8, perspective: 0.5 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    triggers: [
      {
        id: 'barshift-rotation',
        enabled: true,
        source: 'bar',
        action: 'pulse',
        targetParam: 'rotation',
        targetMappingId: null,
        lookSlot: null,
        quantize: 'off',
        cooldownSec: 0,
        attackSec: 0.03,
        holdSec: 0.1,
        decaySec: 0.6,
        amount: 0.08,
        curve: 'easeOut',
      },
      {
        id: 'barshift-depth',
        enabled: true,
        source: 'bar',
        action: 'pulse',
        targetParam: 'depth',
        targetMappingId: null,
        lookSlot: null,
        quantize: 'off',
        cooldownSec: 0,
        attackSec: 0.03,
        holdSec: 0.1,
        decaySec: 0.6,
        amount: 0.3,
        curve: 'exponential',
      },
    ],
    builtin: true,
  },
  {
    id: 'builtin-time-curtain',
    name: 'Time Curtain',
    techniqueId: 'slit-scan',
    params: {
      axis: 'horizontal',
      strips: 220,
      spanSec: 2.29,
      interpolate: 0.6
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'The full temporal buffer stretched into one flowing curtain.',
    tags: [
      'time',
      'slit',
      'live'
    ]
  },
  {
    id: 'builtin-time-rings',
    name: 'Time Rings',
    techniqueId: 'mosaic',
    params: {
      tileMode: 'tile',
      offsetMode: 'radial',
      temporalDirection: 'inward',
      maxOffsetSec: 2.0,
      columns: 64,
      rows: 36,
      spacing: 0,
      lumToScale: 0,
      falloff: 1.4
    },
    material: {
      materialId: 'circle',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Concentric rings of past frames \u2014 the center is the oldest moment.',
    tags: [
      'time',
      'rings'
    ]
  },
  {
    id: 'builtin-frame-cascade',
    name: 'Frame Cascade',
    techniqueId: 'step-print',
    params: {
      stepSec: 0.09,
      copies: 10,
      hold: 1,
      decay: 0.92,
      offsetX: 2.4,
      offsetY: 1.6,
      mode: 'accumulate'
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Held frames stack diagonally like prints sliding off a pile.',
    tags: [
      'step',
      'stack'
    ]
  },
  {
    id: 'builtin-long-exposure',
    name: 'Long Exposure',
    techniqueId: 'echo',
    params: {
      copies: 48,
      delaySec: 0.045,
      decay: 0.97,
      offsetX: 0,
      offsetY: 0,
      copyScale: 1,
      opacity: 0.9
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Dozens of aligned echoes fuse motion into a single luminous smear.',
    tags: [
      'exposure',
      'blur',
      'live'
    ]
  },
  {
    id: 'builtin-ghost-frame',
    name: 'Ghost Frame',
    techniqueId: 'echo',
    params: {
      copies: 2,
      delaySec: 0.5,
      decay: 1,
      opacity: 0.55,
      blend: 'screen'
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'One translucent frame from half a second ago haunts the present.',
    tags: [
      'ghost',
      'minimal'
    ]
  },
  {
    id: 'builtin-contact-sheet',
    name: 'Contact Sheet',
    techniqueId: 'mosaic',
    params: {
      tileMode: 'tile',
      offsetMode: 'linearX',
      maxOffsetSec: 2.29,
      columns: 6,
      rows: 4,
      spacing: 0.06,
      lumToScale: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'A film contact sheet: each cell is a successive moment, left to right.',
    tags: [
      'grid',
      'film'
    ]
  },
  {
    id: 'builtin-past-windows',
    name: 'Past Windows',
    techniqueId: 'mosaic',
    params: {
      tileMode: 'tile',
      offsetMode: 'linearY',
      maxOffsetSec: 1.6,
      columns: 10,
      rows: 6,
      spacing: 0.12,
      lumToScale: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Rows of windows looking progressively further into the past.',
    tags: [
      'grid',
      'time'
    ]
  },
  {
    id: 'builtin-time-slice',
    name: 'Time Slice',
    techniqueId: 'slit-scan',
    params: {
      axis: 'vertical',
      strips: 512,
      spanSec: 0.35,
      interpolate: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Hundreds of hairline slices over a short span \u2014 liquid geometry.',
    tags: [
      'slit',
      'fine'
    ]
  },
  {
    id: 'builtin-memory',
    name: 'Memory',
    techniqueId: 'echo',
    params: {
      copies: 24,
      delaySec: 0.09,
      decay: 0.93,
      distribution: 'radial',
      copyScale: 0.995,
      opacity: 0.85
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'memory-centroid',
        enabled: true,
        source: 'centroid',
        target: 'delaySec',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.35,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Radial echoes recede into the frame; brightness of the sound stretches recall.',
    tags: [
      'radial',
      'audio'
    ]
  },
  {
    id: 'builtin-broken-codec',
    name: 'Broken Codec',
    techniqueId: 'mosaic',
    params: {
      tileMode: 'tile',
      offsetMode: 'random',
      maxOffsetSec: 1.2,
      columns: 32,
      rows: 18,
      jitterX: 0.15,
      jitterY: 0.1,
      threshold: 0.12,
      spacing: 0,
      lumToScale: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'Blocks decode from the wrong moments \u2014 procedural, not a real codec.',
    tags: [
      'glitch',
      'blocks',
      'live'
    ]
  },
  {
    id: 'builtin-block-loss',
    name: 'Block Loss',
    techniqueId: 'mosaic',
    params: {
      columns: 26,
      rows: 15,
      threshold: 0.55,
      invert: true,
      lumToScale: 0,
      spacing: 0,
      contrast: 1.6
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'Dark regions drop out entirely, like lost macroblocks.',
    tags: [
      'dropout'
    ]
  },
  {
    id: 'builtin-signal-tear',
    name: 'Signal Tear',
    techniqueId: 'slit-scan',
    params: {
      axis: 'horizontal',
      strips: 4,
      spanSec: 1.8,
      interpolate: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'tear-flux',
        enabled: true,
        source: 'flux',
        target: 'offsetSec',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.1,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'Four huge bands ripped from different seconds; audio flux shifts the tear.',
    tags: [
      'tear',
      'audio'
    ]
  },
  {
    id: 'builtin-packet-loss',
    name: 'Packet Loss',
    techniqueId: 'step-print',
    params: {
      mode: 'random',
      stepSec: 0.22,
      copies: 8,
      hold: 6,
      decay: 0.9
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'Random held frames arrive late and out of order.',
    tags: [
      'stutter'
    ]
  },
  {
    id: 'builtin-frame-hold',
    name: 'Frame Hold',
    techniqueId: 'step-print',
    params: {
      mode: 'replace',
      stepSec: 0.42,
      copies: 1,
      hold: 8,
      decay: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'The feed freezes in long stubborn holds, then snaps forward.',
    tags: [
      'freeze',
      'stutter'
    ]
  },
  {
    id: 'builtin-scan-error',
    name: 'Scan Error',
    techniqueId: 'slit-scan',
    params: {
      axis: 'vertical',
      strips: 36,
      spanSec: 0.9,
      direction: 'reverse'
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'scan-beat',
        enabled: true,
        source: 'beat:1/8',
        target: 'offsetSec',
        amount: 0.35,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.05,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'A reversed scan that ticks against the beat grid.',
    tags: [
      'scan',
      'beat'
    ]
  },
  {
    id: 'builtin-digital-snow',
    name: 'Digital Snow',
    techniqueId: 'mosaic',
    params: {
      columns: 160,
      rows: 90,
      randomRotation: 1,
      jitterX: 0.5,
      jitterY: 0.5,
      threshold: 0.3,
      lumToScale: 0.6
    },
    material: {
      materialId: 'dot',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'The image dissolves into shivering broadcast dust.',
    tags: [
      'noise',
      'dots'
    ]
  },
  {
    id: 'builtin-memory-leak',
    name: 'Memory Leak',
    techniqueId: 'echo',
    params: {
      copies: 36,
      delaySec: 0.05,
      decay: 0.985,
      copyScale: 1.045,
      copyRotation: 0.6,
      blend: 'add',
      opacity: 0.5
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'Additive echoes grow until brightness overflows the frame.',
    tags: [
      'overflow',
      'bloom'
    ]
  },
  {
    id: 'builtin-data-collapse',
    name: 'Data Collapse',
    techniqueId: 'mosaic',
    params: {
      spacing: -0.4,
      columns: 56,
      rows: 32,
      lumToScale: -0.7,
      threshold: 0.2,
      contrast: 1.8
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'collapse-bass',
        enabled: true,
        source: 'bass',
        target: 'spacing',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Digital Damage',
    description: 'Cells overlap and implode; bass pressure crushes the grid.',
    tags: [
      'collapse',
      'audio'
    ]
  },
  {
    id: 'builtin-consumer-tv',
    name: 'Consumer TV',
    techniqueId: 'mosaic',
    params: {
      columns: 2,
      rows: 220,
      lumToScale: 0.5,
      spacing: -0.1,
      contrast: 1.25,
      gamma: 1.1
    },
    material: {
      materialId: 'line',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Analog',
    description: 'Fat scanlines and soft contrast, like a tube TV across the room.',
    tags: [
      'scanlines',
      'crt'
    ]
  },
  {
    id: 'builtin-bad-antenna',
    name: 'Bad Antenna',
    techniqueId: 'slit-scan',
    params: {
      axis: 'horizontal',
      strips: 130,
      spanSec: 0.12,
      interpolate: 0.25
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'antenna-flux',
        enabled: true,
        source: 'flux',
        target: 'spanSec',
        amount: 0.6,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.08,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Analog',
    description: 'Short unstable smears that shudder when the signal gets loud.',
    tags: [
      'unstable',
      'audio',
      'live'
    ]
  },
  {
    id: 'builtin-vhs-tracking',
    name: 'VHS Tracking',
    techniqueId: 'slit-scan',
    params: {
      axis: 'vertical',
      strips: 60,
      spanSec: 0.5,
      offsetSec: 0.4
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'vhs-bar',
        enabled: true,
        source: 'beat:bar',
        target: 'offsetSec',
        amount: 0.6,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.5,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Analog',
    description: 'Tape tracking drifts once per bar and settles again.',
    tags: [
      'tape',
      'beat'
    ]
  },
  {
    id: 'builtin-phosphor-grid',
    name: 'Phosphor Grid',
    techniqueId: 'mosaic',
    params: {
      columns: 120,
      rows: 68,
      lumToScale: 0.9,
      threshold: 0.06,
      gamma: 0.85
    },
    material: {
      materialId: 'dot',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Analog',
    description: 'A monochrome dot matrix glowing like a phosphor display.',
    tags: [
      'crt',
      'mono'
    ]
  },
  {
    id: 'builtin-phosphor-memory',
    name: 'Phosphor Memory',
    techniqueId: 'step-print',
    params: {
      mode: 'accumulate',
      stepSec: 0.11,
      copies: 12,
      decay: 0.94
    },
    material: {
      materialId: 'square',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Analog',
    description: 'Slow-fading afterimages, the way bright shapes linger on a CRT.',
    tags: [
      'afterglow',
      'mono',
      'live'
    ]
  },
  {
    id: 'builtin-broadcast-noise',
    name: 'Broadcast Noise',
    techniqueId: 'mosaic',
    params: {
      columns: 96,
      rows: 54,
      randomRotation: 0.8,
      jitterX: 0.35,
      jitterY: 0.3,
      lumToScale: 0.4
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'broadcast-flux',
        enabled: true,
        source: 'flux',
        target: 'jitterX',
        amount: 0.7,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.1,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Analog',
    description: 'The grid trembles with the audio like interference on air.',
    tags: [
      'noise',
      'audio'
    ]
  },
  {
    id: 'builtin-lens-array',
    name: 'Lens Array',
    techniqueId: 'mosaic',
    params: {
      columns: 36,
      rows: 20,
      scale: 1.15,
      lumToScale: -0.85,
      spacing: 0.02,
      gamma: 1.3
    },
    material: {
      materialId: 'circle',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Optical',
    description: 'An insect-eye sheet of lenses \u2014 highlights shrink, shadows swell.',
    tags: [
      'lenses',
      'circles'
    ]
  },
  {
    id: 'builtin-prism-row',
    name: 'Prism Row',
    techniqueId: 'echo',
    params: {
      copies: 7,
      delaySec: 0.03,
      distribution: 'linear',
      offsetX: 2.6,
      copyRotation: 4,
      blend: 'screen',
      decay: 0.88,
      opacity: 0.7
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Optical',
    description: 'Screen-blended copies fan out like light through a prism edge.',
    tags: [
      'prism',
      'fan'
    ]
  },
  {
    id: 'builtin-soft-focus',
    name: 'Soft Focus',
    techniqueId: 'echo',
    params: {
      copies: 10,
      delaySec: 0.02,
      decay: 0.9,
      copyScale: 1.018,
      opacity: 0.35,
      blend: 'screen',
      offsetX: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Optical',
    description: 'Stacked halos melt edges into a diffusion-filter glow.',
    tags: [
      'glow',
      'dreamy'
    ]
  },
  {
    id: 'builtin-depth-stack',
    name: 'Depth Stack',
    techniqueId: 'mosaic',
    params: {
      depth: 520,
      perspective: 0.6,
      lumToDepth: 0.8,
      columns: 40,
      rows: 24,
      spacing: 0.15
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Optical',
    description: 'Bright cells float toward the camera in real perspective.',
    tags: [
      '3d',
      'depth'
    ]
  },
  {
    id: 'builtin-triangle-field',
    name: 'Triangle Field',
    techniqueId: 'mosaic',
    params: {
      columns: 44,
      rows: 26,
      randomRotation: 0.35,
      lumToRotation: 0.5,
      spacing: 0.08
    },
    material: {
      materialId: 'triangle',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Geometry',
    description: 'A faceted field where luminance turns every triangle.',
    tags: [
      'triangles'
    ]
  },
  {
    id: 'builtin-line-weave',
    name: 'Line Weave',
    techniqueId: 'mosaic',
    params: {
      columns: 60,
      rows: 34,
      lumToRotation: 1,
      rotation: 0,
      scale: 1.3,
      spacing: -0.05
    },
    material: {
      materialId: 'line',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Geometry',
    description: 'Lines rotate with the image and weave a moving engraving.',
    tags: [
      'lines',
      'etch'
    ]
  },
  {
    id: 'builtin-diamond-lattice',
    name: 'Diamond Lattice',
    techniqueId: 'mosaic',
    params: {
      columns: 38,
      rows: 22,
      rotation: 45,
      spacing: 0.18,
      lumToScale: 0.5
    },
    material: {
      materialId: 'rectangle',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Geometry',
    description: 'A 45\u00b0 lattice of diamonds breathing with brightness.',
    tags: [
      'lattice'
    ]
  },
  {
    id: 'builtin-data-grid',
    name: 'Data Grid',
    techniqueId: 'mosaic',
    params: {
      columns: 110,
      rows: 8,
      spacing: 0.3,
      threshold: 0.4,
      lumToScale: 0.9,
      contrast: 2
    },
    material: {
      materialId: 'rectangle',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'RULE-BASED SYSTEMS \u2014 the image reduced to rows of data bars.',
    tags: [
      'data',
      'mono'
    ]
  },
  {
    id: 'builtin-binary-field',
    name: 'Binary Field',
    techniqueId: 'mosaic',
    params: {
      columns: 72,
      rows: 40,
      threshold: 0.5,
      lumToScale: 0,
      scale: 0.9,
      contrast: 3,
      gamma: 1.4
    },
    material: {
      materialId: 'square',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'binary-flux',
        enabled: true,
        source: 'flux',
        target: 'threshold',
        amount: 0.3,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.15,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'DATA SYSTEMS \u2014 hard on/off cells; sound flips the decision boundary.',
    tags: [
      'binary',
      'audio'
    ]
  },
  {
    id: 'builtin-precision',
    name: 'Precision',
    techniqueId: 'mosaic',
    params: {
      columns: 200,
      rows: 112,
      spacing: 0.35,
      scale: 1,
      lumToScale: 0.7,
      gamma: 1.2
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'GEOMETRIC RHYTHM \u2014 a fine, exact grid rendered with restraint.',
    tags: [
      'fine',
      'exact'
    ]
  },
  {
    id: 'builtin-density',
    name: 'Density',
    techniqueId: 'mosaic',
    params: {
      columns: 90,
      rows: 50,
      lumToScale: -1,
      scale: 1.6,
      spacing: 0,
      minScale: 0.05
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'LIGHT SYSTEMS \u2014 darkness gains mass; highlights dissolve to points.',
    tags: [
      'inverse'
    ]
  },
  {
    id: 'builtin-white-signal',
    name: 'White Signal',
    techniqueId: 'mosaic',
    params: {
      invert: true,
      threshold: 0.65,
      columns: 64,
      rows: 36,
      lumToScale: 0.8,
      contrast: 2.2
    },
    material: {
      materialId: 'square',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'LIGHT SYSTEMS \u2014 only the brightest signal survives, inverted to white.',
    tags: [
      'white',
      'mono'
    ]
  },
  {
    id: 'builtin-swarm',
    name: 'Swarm',
    techniqueId: 'mosaic',
    params: {
      columns: 70,
      rows: 40,
      jitterX: 0.9,
      jitterY: 0.9,
      lumToScale: 0.5,
      scale: 0.8
    },
    material: {
      materialId: 'dot',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'swarm-time',
        enabled: true,
        source: 'time',
        target: 'rotation',
        amount: 0.3,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.6,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'LIVING MOTION \u2014 cells scatter like a swarm holding loose formation.',
    tags: [
      'organic',
      'dots'
    ]
  },
  {
    id: 'builtin-machine-vision',
    name: 'Machine Vision',
    techniqueId: 'mosaic',
    params: {
      contrast: 3.5,
      gamma: 0.6,
      threshold: 0.35,
      columns: 120,
      rows: 68,
      lumToScale: 1,
      scale: 0.7
    },
    material: {
      materialId: 'square',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'MACHINE VISION \u2014 what a detector keeps after thresholding the world.',
    tags: [
      'vision',
      'mono',
      'live'
    ]
  },
  {
    id: 'builtin-live-trails',
    name: 'Live Trails',
    techniqueId: 'echo',
    params: {
      copies: 30,
      delaySec: 0.06,
      decay: 0.95,
      opacity: 0.8
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Live',
    description: 'Camera motion leaves clean fading trails. Made for live input.',
    tags: [
      'live',
      'trails'
    ]
  },
  {
    id: 'builtin-mirror-delay',
    name: 'Mirror Delay',
    techniqueId: 'step-print',
    params: {
      mode: 'pingpong',
      stepSec: 0.18,
      copies: 5,
      offsetX: 3,
      decay: 0.88
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Live',
    description: 'Your movements answer themselves a beat later, displaced sideways.',
    tags: [
      'live',
      'delay'
    ]
  },
  {
    id: 'builtin-presence',
    name: 'Presence',
    techniqueId: 'mosaic',
    params: {
      columns: 52,
      rows: 30,
      lumToScale: 1,
      threshold: 0.08
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'presence-onset',
        enabled: true,
        source: 'onset',
        target: 'scale',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.05,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Live',
    description: 'The grid swells wherever a body is \u2014 onsets push it outward.',
    tags: [
      'live',
      'audio'
    ]
  },
  {
    id: 'builtin-slow-shutter',
    name: 'Slow Shutter',
    techniqueId: 'echo',
    params: {
      copies: 56,
      delaySec: 0.04,
      decay: 0.99,
      opacity: 0.6,
      blend: 'add',
      copyScale: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Live',
    description: 'Additive accumulation \u2014 move a light through frame and paint with it.',
    tags: [
      'live',
      'lightpaint'
    ]
  },
  {
    id: 'builtin-strobe-cut',
    name: 'Strobe Cut',
    techniqueId: 'mosaic',
    params: {
      columns: 48,
      rows: 27,
      lumToScale: 0.85
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'strobe-beat',
        enabled: true,
        source: 'beat:1/4',
        target: 'opacity',
        amount: 1.0,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.0,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Performance',
    description: 'The whole image gates on quarter notes. Instant club material.',
    tags: [
      'beat',
      'strobe'
    ]
  },
  {
    id: 'builtin-bass-bloom',
    name: 'Bass Bloom',
    techniqueId: 'mosaic',
    params: {
      columns: 30,
      rows: 17,
      scale: 0.8,
      spacing: 0.2
    },
    material: {
      materialId: 'circle',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'bloom-bass-scale',
        enabled: true,
        source: 'bass',
        target: 'scale',
        amount: 0.8,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.15,
        curve: 'linear',
        frozenValue: null
      },
      {
        id: 'bloom-bass-spacing',
        enabled: true,
        source: 'bass',
        target: 'spacing',
        amount: 0.4,
        min: 0.0,
        max: 1.0,
        invert: true,
        smoothing: 0.15,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Performance',
    description: 'Low end inflates every cell and closes the gaps between them.',
    tags: [
      'bass',
      'audio'
    ]
  },
  {
    id: 'builtin-shatter',
    name: 'Shatter',
    techniqueId: 'mosaic',
    params: {
      columns: 40,
      rows: 24,
      lumToScale: 0.6
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'shatter-jx',
        enabled: true,
        source: 'transients',
        target: 'jitterX',
        amount: 1.0,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.08,
        curve: 'linear',
        frozenValue: null
      },
      {
        id: 'shatter-rot',
        enabled: true,
        source: 'transients',
        target: 'randomRotation',
        amount: 0.8,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.08,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Performance',
    description: 'Every transient knocks the grid apart for an instant.',
    tags: [
      'transients',
      'impact'
    ]
  },
  {
    id: 'builtin-single-line',
    name: 'Single Line',
    techniqueId: 'slit-scan',
    params: {
      strips: 2,
      spanSec: 2.29,
      axis: 'vertical',
      interpolate: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Minimal',
    description: 'Two smooth bands spanning the whole buffer. Almost nothing, moving.',
    tags: [
      'reduction'
    ]
  },
  {
    id: 'builtin-two-tones',
    name: 'Two Tones',
    techniqueId: 'mosaic',
    params: {
      threshold: 0.5,
      contrast: 4,
      columns: 80,
      rows: 45,
      lumToScale: 0,
      scale: 1.02,
      spacing: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'mono',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Minimal',
    description: 'The image as pure black and white decision.',
    tags: [
      'mono',
      'poster'
    ]
  },
  {
    id: 'builtin-breath',
    name: 'Breath',
    techniqueId: 'echo',
    params: {
      copies: 3,
      delaySec: 0.3,
      decay: 0.95,
      copyScale: 1.01,
      opacity: 0.5
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'breath-bar',
        enabled: true,
        source: 'beat:bar',
        target: 'copyScale',
        amount: 0.15,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.6,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Minimal',
    description: 'Three soft echoes swelling gently once per bar.',
    tags: [
      'calm',
      'beat'
    ]
  },
  {
    id: 'builtin-field-of-dots',
    name: 'Field of Dots',
    techniqueId: 'mosaic',
    params: {
      columns: 48,
      rows: 27,
      scale: 0.55,
      spacing: 0.4,
      lumToScale: 0.35
    },
    material: {
      materialId: 'dot',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Minimal',
    description: 'An even field of dots holding the image at a polite distance.',
    tags: [
      'dots',
      'clean'
    ]
  },
  {
    id: 'builtin-infinite-tunnel',
    name: 'Infinite Tunnel',
    techniqueId: 'feedback-zoom',
    params: {
      zoom: 1.045,
      persistence: 0.965,
      injection: 0.42,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'The frame falls forever into its own center.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-soft-memory',
    name: 'Soft Memory',
    techniqueId: 'feedback-zoom',
    params: {
      zoom: 0.985,
      persistence: 0.94,
      injection: 0.6,
      mix: 0.85
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'The past swells gently outward and dissolves.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-collapse',
    name: 'Collapse',
    techniqueId: 'feedback-zoom',
    params: {
      zoom: 1.09,
      persistence: 0.9,
      injection: 0.75,
      centerY: -0.12,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'collapse-bass',
        enabled: true,
        source: 'bass',
        target: 'zoom',
        amount: 0.4,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.15,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Hard inward pull; bass accelerates the fall.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-spiral-echo',
    name: 'Spiral Echo',
    techniqueId: 'feedback-rotate',
    params: {
      rotation: 2.6,
      zoom: 1.012,
      persistence: 0.95,
      injection: 0.5,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Echoes corkscrew away from the center.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-slow-orbit',
    name: 'Slow Orbit',
    techniqueId: 'feedback-rotate',
    params: {
      rotation: 0.7,
      zoom: 1.002,
      persistence: 0.97,
      injection: 0.35,
      mix: 0.9
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'A long, patient rotation that never quite lets go.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-signal-drift',
    name: 'Signal Drift',
    techniqueId: 'feedback-drift',
    params: {
      driftX: 1.1,
      driftY: 0,
      persistence: 0.93,
      injection: 0.6,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'The image bleeds steadily off to the right.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-falling-memory',
    name: 'Falling Memory',
    techniqueId: 'feedback-drift',
    params: {
      driftX: 0,
      driftY: -1.4,
      persistence: 0.94,
      injection: 0.55,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Every frame sinks; the present floats on its own history.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-boiling-wall',
    name: 'Boiling Wall',
    techniqueId: 'feedback-displace',
    params: {
      amount: 1.8,
      scale: 9,
      speed: 1.6,
      persistence: 0.9,
      injection: 0.65,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'The surface simmers \u2014 detail churns without ever settling.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-slow-melt',
    name: 'Slow Melt',
    techniqueId: 'feedback-displace',
    params: {
      amount: 0.9,
      scale: 3.5,
      speed: 0.35,
      persistence: 0.955,
      injection: 0.5,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Long soft distortions drag the image downward into wax.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-living-mandala',
    name: 'Living Mandala',
    techniqueId: 'feedback-kaleido',
    params: {
      segments: 8,
      rotation: 1.6,
      zoom: 1.02,
      persistence: 0.94,
      injection: 0.55,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Eightfold symmetry that keeps inhaling the source.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-cathedral',
    name: 'Cathedral',
    techniqueId: 'feedback-kaleido',
    params: {
      segments: 4,
      rotation: 0.4,
      zoom: 1.006,
      persistence: 0.96,
      injection: 0.4,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Slow fourfold mirrors \u2014 architecture out of anything.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-phosphor-bloom',
    name: 'Phosphor Bloom',
    techniqueId: 'feedback-bloom',
    params: {
      threshold: 0.5,
      radius: 2.4,
      gain: 1.4,
      zoom: 1.006,
      persistence: 0.92,
      injection: 0.6,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Highlights burn in and glow like an old scope.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-halo-burn',
    name: 'Halo Burn',
    techniqueId: 'feedback-bloom',
    params: {
      threshold: 0.72,
      radius: 3.6,
      gain: 2.0,
      zoom: 1.012,
      persistence: 0.9,
      injection: 0.65,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'halo-highs',
        enabled: true,
        source: 'highs',
        target: 'gain',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Only the brightest edges survive \u2014 treble feeds the halo.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-channel-ghost',
    name: 'Channel Ghost',
    techniqueId: 'feedback-rgb',
    params: {
      redShift: 2.6,
      greenShift: 0.8,
      blueShift: 3.4,
      zoom: 1.003,
      persistence: 0.94,
      injection: 0.5,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Color planes separate and haunt their own outlines.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-color-memory',
    name: 'Color Memory',
    techniqueId: 'feedback-rgb',
    params: {
      redShift: 1.2,
      greenShift: 1.2,
      blueShift: 1.2,
      zoom: 0.994,
      persistence: 0.96,
      injection: 0.4,
      mix: 0.9
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'A soft chromatic wake expanding behind the image.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-rgb-echo',
    name: 'RGB Echo',
    techniqueId: 'feedback-rgb',
    params: {
      redShift: 4.5,
      greenShift: 2.2,
      blueShift: 6,
      zoom: 1.008,
      persistence: 0.9,
      injection: 0.7,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'rgbecho-flux',
        enabled: true,
        source: 'flux',
        target: 'redShift',
        amount: 0.6,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.1,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Feedback',
    description: 'Aggressive channel tearing that answers the audio.',
    tags: [
      'feedback'
    ]
  },
  {
    id: 'builtin-deep-curtain',
    name: 'Deep Curtain',
    techniqueId: 'time-field',
    params: {
      field: 'horizontal',
      depth: 2.29,
      offset: 0
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'The full atlas stretched left-to-right \u2014 the deepest curtain the buffer allows.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-time-iris',
    name: 'Time Iris',
    techniqueId: 'time-field',
    params: {
      field: 'radial',
      invert: true,
      depth: 1.8
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'The center holds the oldest moment; now rings the edges. A temporal iris.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-memory-spiral',
    name: 'Memory Spiral',
    techniqueId: 'time-field',
    params: {
      field: 'spiral',
      scale: 2,
      depth: 1.6
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Time winds around the center in a two-turn spiral.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-temporal-terrain',
    name: 'Temporal Terrain',
    techniqueId: 'time-field',
    params: {
      field: 'noise',
      scale: 0.7,
      speed: 0.15,
      depth: 1.9
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'A slow-drifting landscape where every hill is a different moment.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-luma-memory',
    name: 'Luma Memory',
    techniqueId: 'time-field',
    params: {
      field: 'luminance',
      depth: 1.6
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Bright regions stay present; shadows sink into the past. The image sculpts its own time.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-chrono-noise',
    name: 'Chrono Noise',
    techniqueId: 'time-field',
    params: {
      field: 'noise',
      scale: 3.2,
      speed: 0.8,
      depth: 1.1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Fine, fast temporal grain \u2014 the surface boils between moments.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-time-veil',
    name: 'Time Veil',
    techniqueId: 'time-field',
    params: {
      field: 'vertical',
      depth: 0.7,
      offset: 0.9
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'A soft veil: the frame hangs about a second behind, deeper toward the floor.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-edge-of-time',
    name: 'Edge of Time',
    techniqueId: 'time-field',
    params: {
      field: 'edges',
      depth: 1.8
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Contours peel away into history while flat regions stay present.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-radial-memory',
    name: 'Radial Memory',
    techniqueId: 'time-field',
    params: {
      field: 'radial',
      depth: 1.4
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'radmem-bass',
        enabled: true,
        source: 'bass',
        target: 'depth',
        amount: 0.6,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Now at the center, the past blooming outward \u2014 bass deepens the reach.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-broken-time',
    name: 'Broken Time',
    techniqueId: 'time-field',
    params: {
      field: 'noise',
      scale: 4.5,
      speed: 0.05,
      depth: 2.29
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'broken-beat',
        enabled: true,
        source: 'beat:1/4',
        target: 'offset',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.05,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Temporal',
    description: 'Hard temporal shards; every quarter note re-deals the moments.',
    tags: [
      'time',
      'field'
    ]
  },
  {
    id: 'builtin-flow-pull',
    name: 'Flow Pull',
    techniqueId: 'flow-displace',
    params: {
      amount: 1.6,
      threshold: 0.04
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Pixels drag hard along their own motion \u2014 liquid inertia.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-undertow',
    name: 'Undertow',
    techniqueId: 'flow-displace',
    params: {
      amount: 1.4,
      threshold: 0.05,
      against: true
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'The image pulls AGAINST its motion, like water resisting a swimmer.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-vector-smear',
    name: 'Vector Smear',
    techniqueId: 'directional-smear',
    params: {
      amount: 2.2,
      samples: 10,
      threshold: 0.05
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Painterly speed-lines along every moving edge.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-channel-drag',
    name: 'Channel Drag',
    techniqueId: 'motion-rgb',
    params: {
      amount: 1.6,
      threshold: 0.03
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Motion tears red ahead and blue behind \u2014 chroma with momentum.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-body-ghost',
    name: 'Body Ghost',
    techniqueId: 'flow-feedback',
    params: {
      flow: 1.2,
      persistence: 0.95,
      injection: 0.45,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'A wake of yourself follows every gesture.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-current',
    name: 'Current',
    techniqueId: 'flow-feedback',
    params: {
      flow: 1.8,
      persistence: 0.97,
      injection: 0.3,
      mix: 1
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'cur-bass',
        enabled: true,
        source: 'bass',
        target: 'flow',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'The whole frame becomes a river; bass strengthens the current.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-mosh-drift',
    name: 'Mosh Drift',
    techniqueId: 'motion-mosh',
    params: {
      flow: 1.2,
      threshold: 0.12,
      blockiness: 3,
      chromaDrift: 0.15,
      persistence: 0.985,
      injection: 0.65
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Moving regions smear old pixels; still regions refresh \u2014 the signature mosh.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-block-storm',
    name: 'Block Storm',
    techniqueId: 'motion-mosh',
    params: {
      flow: 2,
      threshold: 0.08,
      blockiness: 7,
      chromaDrift: 0.35,
      persistence: 0.99,
      injection: 0.5
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'bs-flux',
        enabled: true,
        source: 'flux',
        target: 'flow',
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.1,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Coarse blocks ride the motion; audio flux whips the storm.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-clean-wake',
    name: 'Clean Wake',
    techniqueId: 'motion-trails',
    params: {
      flow: 0.6,
      threshold: 0.08,
      persistence: 0.95,
      injection: 0.85
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Only what moves leaves a trail; stillness stays pristine.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-motion-memory',
    name: 'Motion Memory',
    techniqueId: 'time-field',
    params: {
      field: 'motion',
      depth: 1.8,
      scale: 2
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Motion',
    description: 'Moving regions tear into the past; the still world stays present.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-activity-map',
    name: 'Activity Map',
    techniqueId: 'time-field',
    params: {
      field: 'motion',
      depth: 2.29,
      scale: 3,
      invert: true
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'MACHINE VISION study: activity itself becomes the depth of time.',
    tags: [
      'motion',
      'flow'
    ]
  },
  {
    id: 'builtin-coral',
    name: 'Coral',
    techniqueId: 'reaction-diffusion',
    params: {
      feed: 0.0545,
      kill: 0.062,
      speed: 4,
      contrast: 2.4,
      grid: 320
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Chemistry grows branching reefs from a handful of seeds.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-worm-field',
    name: 'Worm Field',
    techniqueId: 'reaction-diffusion',
    params: {
      feed: 0.078,
      kill: 0.061,
      speed: 5,
      contrast: 2.2,
      grid: 320
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Long crawling filaments that never stop rearranging.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-maze-growth',
    name: 'Maze Growth',
    techniqueId: 'reaction-diffusion',
    params: {
      feed: 0.029,
      kill: 0.057,
      speed: 4,
      contrast: 2.6,
      grid: 384
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Corridors close and reopen \u2014 a labyrinth building itself.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-spore-field',
    name: 'Spore Field',
    techniqueId: 'reaction-diffusion',
    params: {
      feed: 0.037,
      kill: 0.06,
      speed: 3,
      contrast: 3,
      grid: 256,
      density: 0.12
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Isolated cells divide into a slow spreading colony.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-chemical-bloom',
    name: 'Chemical Bloom',
    techniqueId: 'reaction-diffusion',
    params: {
      feed: 0.062,
      kill: 0.0625,
      speed: 6,
      contrast: 2,
      grid: 320
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [
      {
        id: 'bloom-bass',
        enabled: true,
        source: 'bass',
        target: 'feed',
        amount: 0.4,
        min: 0.0,
        max: 1.0,
        invert: false,
        smoothing: 0.25,
        curve: 'linear',
        frozenValue: null
      }
    ],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Pulsing growth; the low end feeds the reaction.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-lichen',
    name: 'Lichen',
    techniqueId: 'reaction-diffusion',
    params: {
      feed: 0.0435,
      kill: 0.0595,
      speed: 4,
      contrast: 2.8,
      grid: 448
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Fine encrusting texture, slow and organic.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-life',
    name: 'Life',
    techniqueId: 'cellular',
    params: {
      rule: 'life',
      grid: 256,
      density: 0.28
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Classic life rules — the canonical emergence machine.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-colony',
    name: 'Colony',
    techniqueId: 'cellular',
    params: {
      rule: 'highlife',
      grid: 256,
      density: 0.32
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'HighLife: replicators and drifting colonies.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-signal-cells',
    name: 'Signal Cells',
    techniqueId: 'cellular',
    params: {
      rule: 'seeds',
      grid: 320,
      density: 0.02
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Seeds: explosive propagation from almost nothing.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-night-grid',
    name: 'Night Grid',
    techniqueId: 'cellular',
    params: {
      rule: 'maze',
      grid: 192,
      density: 0.18
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Simulation',
    description: 'Cellular maze weaving and unweaving itself.',
    tags: [
      'simulation'
    ]
  },
  {
    id: 'builtin-living-grid',
    name: 'Living Grid',
    techniqueId: 'cellular',
    params: {
      rule: 'daynight',
      grid: 256,
      density: 0.4
    },
    material: {
      materialId: 'square',
      colorMode: 'source',
      params: {
        aspect: 1
      },
      assetPath: null
    },
    modulations: [],
    triggers: [],
    builtin: true,
    category: 'Studies',
    description: 'ORGANIC COMPUTATION study: symmetric day/night growth.',
    tags: [
      'simulation'
    ]
  },
];

const AUDIO_SOURCES = new Set(['master', 'rms', 'bass', 'mids', 'highs', 'transients']);

/**
 * What a preset needs from the project to actually do something.
 * Derived from the preset's own content so nothing has to be declared twice.
 */
export function presetRequirements(preset: Preset): { video: boolean; audio: boolean; bpm: boolean } {
  const temporalTechniques = new Set(['echo', 'step-print', 'slit-scan']);
  const gridTriggerSources = new Set(['beat', 'bar', 'div:1/2', 'div:1/4', 'div:1/8', 'div:1/16']);
  return {
    video: preset.params.tileMode === 'tile' || temporalTechniques.has(preset.techniqueId),
    audio:
      preset.modulations.some((m) => AUDIO_SOURCES.has(m.source)) ||
      preset.triggers.some((t) => t.source === 'onset'),
    bpm:
      preset.modulations.some((m) => m.source.startsWith('beat:')) ||
      preset.triggers.some((t) => gridTriggerSources.has(t.source)),
  };
}

/** Human-readable note for a preset that needs more than the current project has. */
export function unmetRequirementNote(
  preset: Preset,
  project: { hasVideo: boolean; hasAudio: boolean; hasBpm: boolean },
): string | null {
  const req = presetRequirements(preset);
  const missing: string[] = [];
  if (req.video && !project.hasVideo) missing.push('a video source');
  if (req.audio && !project.hasAudio) missing.push('an audio source');
  if (req.bpm && !project.hasBpm) missing.push('a BPM');
  if (missing.length === 0) return null;
  return `Needs ${missing.join(' and ')}`;
}

export async function listAllPresets(): Promise<Preset[]> {
  try {
    const user = await window.material.listPresets();
    return [...BUILTIN_PRESETS, ...user];
  } catch (err) {
    reportError('List presets', err);
    return BUILTIN_PRESETS;
  }
}

export function applyPreset(preset: Preset): void {
  useProjectStore.getState().apply((p) => {
    const base = withTechniqueEnsured(p);
    return {
      ...base,
      techniques: base.techniques.map((t, i) =>
        i === 0
          ? {
              ...t,
              techniqueId: preset.techniqueId,
              // CE1A: presets apply over the technique's DEFAULTS, never over
              // whatever params the previous state left behind — a curated
              // preset must look the same from any starting point. (User
              // presets are unaffected: they capture the full param record.)
              params: {
                ...(getTechnique(preset.techniqueId)
                  ? defaultParams(getTechnique(preset.techniqueId)!)
                  : t.params),
                ...preset.params,
              },
            }
          : t,
      ),
      material: preset.material,
      modulations: preset.modulations,
      triggers: preset.triggers,
    };
  });
}

export async function saveCurrentAsPreset(name: string): Promise<Preset | null> {
  const { project } = useProjectStore.getState();
  const technique = project.techniques.find((t) => t.enabled);
  if (!technique) {
    useUiStore.getState().pushToast('info', 'Nothing to save as a preset');
    return null;
  }
  const preset: Preset = {
    id: uid('preset'),
    name,
    techniqueId: technique.techniqueId,
    params: technique.params,
    material: project.material,
    modulations: project.modulations,
    triggers: project.triggers,
    builtin: false,
    category: '',
    description: '',
    tags: [],
  };
  try {
    await window.material.savePreset(preset);
    useUiStore.getState().pushToast('info', `Preset "${name}" saved`);
    return preset;
  } catch (err) {
    reportError('Save preset', err);
    return null;
  }
}
