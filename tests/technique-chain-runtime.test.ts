import { describe, expect, it, vi } from 'vitest';
import { renderTechniqueChain } from '@/rendering/techniqueChain';
import { LayerRuntimeImpl } from '@/rendering/layers/LayerRuntimeImpl';

describe('renderTechniqueChain', () => {
  const targets = [{ texture: 'target-a' }, { texture: 'target-b' }] as const;

  it('runs stages in order through alternating targets and returns the final texture', () => {
    const passes: string[] = [];
    const result = renderTechniqueChain<string, { texture: string }, string>(
      'source',
      ['A', 'B', 'C'],
      targets,
      (stage, input, output) => {
        expect(input).not.toBe(output.texture);
        passes.push(`${stage}:${input}->${output.texture}`);
      },
    );

    expect(passes).toEqual([
      'A:source->target-a',
      'B:target-a->target-b',
      'C:target-b->target-a',
    ]);
    expect(result).toBe('target-a');
  });

  it('uses the first target and returns its texture for a single stage', () => {
    const renderPass = vi.fn();
    const result = renderTechniqueChain<string, (typeof targets)[number], string>(
      'source',
      ['only'],
      targets,
      renderPass,
    );

    expect(renderPass).toHaveBeenCalledTimes(1);
    expect(renderPass).toHaveBeenCalledWith('only', 'source', targets[0]);
    expect(result).toBe('target-a');
  });

  it('writes last stage into supplied layer target', () => {
    const finalTarget = { texture: 'layer-output' };
    const outputs: string[] = [];
    const result = renderTechniqueChain<string, { texture: string }, string>(
      'source',
      ['A', 'B', 'C'],
      targets,
      (stage, _input, output) => outputs.push(`${stage}:${output.texture}`),
      finalTarget,
    );

    expect(outputs).toEqual(['A:target-a', 'B:target-b', 'C:layer-output']);
    expect(result).toBe('layer-output');
  });

  it('rejects empty and overlong chains', () => {
    expect(() =>
      renderTechniqueChain<string, (typeof targets)[number], string>(
        'source',
        [],
        targets,
        vi.fn(),
      ),
    ).toThrow(RangeError);
    expect(() =>
      renderTechniqueChain<string, (typeof targets)[number], string>(
        'source',
        ['A', 'B', 'C', 'D'],
        targets,
        vi.fn(),
      ),
    ).toThrow(RangeError);
  });

  it('rejects targets that alias the same texture', () => {
    expect(() =>
      renderTechniqueChain<string, { texture: string }, string>(
        'source',
        ['A'],
        [{ texture: 'same' }, { texture: 'same' }],
        vi.fn(),
      ),
    ).toThrow(/distinct|alias/i);
  });
});

describe('LayerRuntimeImpl stage override lifecycle', () => {
  it('clears export-only stage params when export ends', () => {
    const runtime = new LayerRuntimeImpl();
    runtime.setTechniqueStageParams(new Map([['stage-a', { columns: 64 }]]));
    runtime.beginExportMode();
    runtime.endExportMode();

    expect((runtime as unknown as { techniqueStageOverrides: ReadonlyMap<string, unknown> }).techniqueStageOverrides.size).toBe(0);
  });
});
