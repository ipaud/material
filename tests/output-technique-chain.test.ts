import { describe, expect, it, vi } from 'vitest';
import { OutputLayer } from '@/output-window/outputLayer';
import { registerTechnique, unregisterTechnique } from '@/techniques/registry';

const stage = (id: string, techniqueId: string, params: Record<string, number | boolean | string>) => ({
  id,
  techniqueId,
  enabled: true,
  params,
});

function makeInput(techniqueChain: ReturnType<typeof stage>[]) {
  return {
    id: 'layer-1',
    techniqueId: 'flow-displace',
    techniqueChain,
    materialState: null,
    blendMode: 'normal',
    enabled: true,
    opacity: 1,
    source: null,
  };
}

function makeBranch() {
  return {
    setTechniqueRenderer: vi.fn(),
    setTechniqueParams: vi.fn(),
    setTechniqueChain: vi.fn(),
    setTechniqueStageParams: vi.fn(),
    setTemporalEnabled: vi.fn(),
    setMaterialState: vi.fn(),
  };
}

function makeHost() {
  return { setTechniqueChain: vi.fn() };
}

describe('OutputLayer technique-chain replication', () => {
  it('mounts compatible ordered stages and forwards their resolved params to the branch', () => {
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    const chain = [
      stage('stage-1', 'motion-rgb', { amount: 0.6 }),
      stage('stage-2', 'directional-smear', { samples: 9 }),
    ];

    output.applyInputs(branch as never, makeInput(chain), 1);

    const installed = host.setTechniqueChain.mock.calls[0]?.[1] as
      | { renderer: unknown; params: Record<string, number | boolean | string> }[]
      | undefined;
    expect(installed).toHaveLength(2);
    expect(installed?.map(({ params }) => params)).toEqual(chain.map(({ params }) => params));
    expect(installed?.every(({ renderer }) => renderer != null)).toBe(true);
    expect(branch.setTechniqueChain).not.toHaveBeenCalled();
  });

  it('reuses stage renderers when the ordered stage identities are unchanged', () => {
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    const input = makeInput([stage('stage-1', 'motion-rgb', { amount: 0.6 })]);

    output.applyInputs(branch as never, input, 1);
    const firstRenderer = (host.setTechniqueChain.mock.calls[0]?.[1] as { renderer: unknown }[])[0]?.renderer;
    output.applyInputs(branch as never, input, 1);
    const nextRenderer = (host.setTechniqueChain.mock.calls[1]?.[1] as { renderer: unknown }[])[0]?.renderer;

    expect(nextRenderer).toBe(firstRenderer);
  });

  it('forwards editor-resolved stage params to replica without rebuilding renderers', () => {
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    output.applyInputs(branch as never, makeInput([stage('stage-a', 'motion-rgb', { amount: 0.2 })]), 1);
    const renderer = ((host.setTechniqueChain.mock.calls[0]?.[1] as { renderer: unknown }[])[0])?.renderer;

    output.noteStageParams({ 'stage-a': { amount: 0.9 } });

    expect(branch.setTechniqueStageParams).toHaveBeenCalledWith(new Map([['stage-a', { amount: 0.9 }]]));
    expect(((host.setTechniqueChain.mock.calls[0]?.[1] as { renderer: unknown }[])[0])?.renderer).toBe(renderer);
  });

  it('applies resolved primary params to the output branch', () => {
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    const params = { columns: 32, rows: 18 };
    output.applyInputs(branch as never, { ...makeInput([]), techniqueParams: params }, 1);

    output.noteParams({ columns: 48, rows: 27 });

    expect(branch.setTechniqueParams).toHaveBeenNthCalledWith(1, params);
    expect(branch.setTechniqueParams).toHaveBeenLastCalledWith({ columns: 48, rows: 27 });
  });

  it('replaces custom stage renderer after its pack revision changes', () => {
    const id = 'custom:test-pack:effect';
    const makeDefinition = (dispose: () => void) => ({
      id, name: 'Effect', category: 'image' as const, chainBehavior: 'stateless' as const,
      description: '', sections: [],
      createRenderer: () => ({ object3d: {} as never, update: () => {}, dispose }),
    });
    const oldDispose = vi.fn<() => void>();
    const newDispose = vi.fn<() => void>();
    registerTechnique(makeDefinition(oldDispose));
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    output.applyInputs(branch as never, { ...makeInput([stage('custom-stage', id, {})]), techniqueId: id }, 1);
    const first = (host.setTechniqueChain.mock.calls[0]?.[1] as { renderer: unknown }[])[0]?.renderer;
    const firstPrimary = branch.setTechniqueRenderer.mock.calls[0]?.[0];

    registerTechnique(makeDefinition(newDispose));
    output.refreshCustomPrimaryRenderer(branch as never, 'test-pack');
    output.refreshCustomChainRenderers(branch as never, 'test-pack');
    const refreshed = host.setTechniqueChain.mock.calls.at(-1)?.[1] as { renderer: unknown }[];

    expect(branch.setTechniqueRenderer.mock.calls.at(-1)?.[0]).not.toBe(firstPrimary);
    expect(refreshed[0]?.renderer).not.toBe(first);
    expect(oldDispose).toHaveBeenCalledOnce();
    unregisterTechnique(id);
  });

  it.each([
    ['removed', []],
    ['incompatible temporal', [stage('unsafe', 'echo', {})]],
  ])('clears the branch chain when it is %s', (_reason, chain) => {
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    output.applyInputs(branch as never, makeInput([stage('safe', 'motion-rgb', { amount: 1 })]), 1);

    output.applyInputs(branch as never, makeInput(chain), 1);

    expect(host.setTechniqueChain).toHaveBeenLastCalledWith('layer-1', []);
  });

  it('installs chain after resolved primary params make it compatible', () => {
    const host = makeHost();
    const output = new OutputLayer('layer-1', host as never);
    const branch = makeBranch();
    const input = {
      ...makeInput([stage('stage-a', 'motion-rgb', { amount: 0.5 })]),
      techniqueId: 'mosaic',
      techniqueParams: { mode: 'video-tile' },
    };
    output.applyInputs(branch as never, input as never, 1);

    output.noteParams({ mode: 'pixel-grid' });

    expect(host.setTechniqueChain.mock.calls.at(-1)?.[0]).toBe('layer-1');
    expect(host.setTechniqueChain.mock.calls.at(-1)?.[1]).toHaveLength(1);
  });
});
