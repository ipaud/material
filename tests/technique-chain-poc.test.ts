import { describe, expect, it, vi } from 'vitest';
import { renderTechniqueChain } from '@/rendering/techniqueChain';

describe('schema-free technique chain prototype', () => {
  const targets = [{ texture: 'a' }, { texture: 'b' }] as const;

  it('routes ordered passes through alternating targets without read/write aliasing', () => {
    const seen: string[] = [];
    const output = renderTechniqueChain<string, (typeof targets)[number], string>(
      'source',
      ['Stage A', 'Stage B', 'Stage C'],
      targets,
      (stage, input, target) => {
        expect(input).not.toBe(target.texture);
        seen.push(`${stage}:${input}->${target.texture}`);
      },
    );

    expect(seen).toEqual(['Stage A:source->a', 'Stage B:a->b', 'Stage C:b->a']);
    expect(output).toBe('a');
  });

  it('preserves one-stage output routing', () => {
    const renderPass = vi.fn();
    const output = renderTechniqueChain<string, (typeof targets)[number], string>(
      'source',
      ['Stage A'],
      targets,
      renderPass,
    );

    expect(renderPass).toHaveBeenCalledWith('Stage A', 'source', targets[0]);
    expect(output).toBe('a');
  });

  it('rejects invalid stage counts and aliased targets', () => {
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
        ['a', 'b', 'c', 'd'],
        targets,
        vi.fn(),
      ),
    ).toThrow(RangeError);
    expect(() =>
      renderTechniqueChain<string, { texture: string }, string>(
        'source',
        ['a'],
        [{ texture: 'same' }, { texture: 'same' }],
        vi.fn(),
      ),
    ).toThrow(/distinct/);
  });
});
