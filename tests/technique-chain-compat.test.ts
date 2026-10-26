import { describe, expect, it } from 'vitest';
import { assessTechniqueChain } from '@/techniques/chainCompatibility';

const stage = (techniqueId: string, params: Record<string, unknown> = {}) => ({ techniqueId, params });

describe('assessTechniqueChain', () => {
  it('keeps every existing single-stage effect valid, including one that needs history', () => {
    expect(assessTechniqueChain([stage('echo')])).toMatchObject({ compatible: true });
    expect(assessTechniqueChain([stage('flow-feedback')])).toMatchObject({ compatible: true });
  });

  it('allows an ordered chain of explicitly chain-safe stateless and flow stages', () => {
    expect(
      assessTechniqueChain([stage('flow-displace'), stage('motion-rgb'), stage('directional-smear')]),
    ).toMatchObject({ compatible: true });
  });

  it('rejects chains longer than three stages with a readable reason', () => {
    const result = assessTechniqueChain([
      stage('flow-displace'),
      stage('motion-rgb'),
      stage('directional-smear'),
      stage('flow-displace'),
    ]);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/3|three/i);
  });

  it.each([
    ['echo', {}],
    ['time-field', {}],
    ['mosaic', { tileMode: 'tile' }],
    ['flow-feedback', {}],
    ['motion-mosh', {}],
    ['reaction-diffusion', {}],
    ['cellular', {}],
    ['does-not-exist', {}],
    ['custom:missing-pack:shader', {}],
  ])('rejects a multi-stage chain containing unsafe or unclassified stage %s with a reason', (id, params) => {
    const result = assessTechniqueChain([stage('flow-displace'), stage(id, params)]);
    expect(result.compatible).toBe(false);
    expect(result.reason).toEqual(expect.any(String));
    expect(result.reason?.trim().length).toBeGreaterThan(0);
  });

  it.each([
    ['Mosaic → Echo', stage('mosaic'), stage('echo')],
    ['Mosaic → Flow Feedback', stage('mosaic'), stage('flow-feedback')],
  ])('rejects %s with a reason', (_chain, ...stages) => {
    const result = assessTechniqueChain(stages);
    expect(result.compatible).toBe(false);
    expect(result.reason?.trim().length).toBeGreaterThan(0);
  });

  it('rejects an unknown stage count instead of treating it as an empty chain', () => {
    const result = assessTechniqueChain(undefined);
    expect(result.compatible).toBe(false);
    expect(result.reason).toEqual(expect.any(String));
    expect(result.reason?.trim().length).toBeGreaterThan(0);
  });

  it('rejects an empty chain with a readable reason', () => {
    const result = assessTechniqueChain([]);
    expect(result.compatible).toBe(false);
    expect(result.reason).toEqual(expect.any(String));
  });
});
