import { afterEach, describe, expect, it } from 'vitest';
import { modulationRuntime } from '@/modulation/runtime';

describe('stage-scoped Take control', () => {
  afterEach(() => modulationRuntime.setTakeState(null));

  it('overlays Take values onto matching stage identity only', () => {
    modulationRuntime.setTakeState({
      opacity: new Map(),
      macros: new Map(),
      params: new Map(),
      stageParams: new Map([['layer-a', new Map([['stage-b', { columns: 64 }]])]]),
    });

    expect(modulationRuntime.transformStageFor('layer-a', 'stage-b', { columns: 24, rows: 14 }))
      .toEqual({ columns: 64, rows: 14 });
    expect(modulationRuntime.transformStageFor('layer-a', 'stage-c', { columns: 24 }))
      .toEqual({ columns: 24 });
    expect(modulationRuntime.transformStageFor('layer-c', 'stage-b', { columns: 24 }))
      .toEqual({ columns: 24 });
  });
});
