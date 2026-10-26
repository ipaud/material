import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { renderTechniqueChain } from '@/rendering/techniqueChain';
import { LayerRuntimeImpl } from '@/rendering/layers/LayerRuntimeImpl';
import { engine } from '@/rendering/RenderEngine';
import { resyncFromStore, syncLayersForExport } from '@/rendering/engineBridge';
import { createEmptyProject } from '@shared/schemas/project';
import type { MaterialState } from '@shared/schemas/project';
import type { TechniqueRenderer } from '@/techniques/types';

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

describe('engine bridge technique-chain installation', () => {
  it('installs compatible stable-ID stages and clears incompatible chains', () => {
    const base = createEmptyProject('chain bridge');
    const layer = base.layers[0]!;
    const compatible = {
      ...base,
      layers: [{
        ...layer,
        technique: { id: 'primary', techniqueId: 'mosaic', enabled: true, params: { tileMode: 'off' } },
        techniqueChain: [{ id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { columns: 24 } }],
      }],
    };
    const setChain = vi.spyOn(engine, 'setTechniqueChain');
    try {
      syncLayersForExport(compatible);
      expect(setChain).toHaveBeenLastCalledWith(layer.id, [
        expect.objectContaining({ stageId: 'stage-a', params: { columns: 24 } }),
      ]);
      expect(engine.branchFor(layer.id)?.hasTechniqueChain).toBe(true);

      const changedStageId = {
        ...compatible,
        layers: [{
          ...compatible.layers[0]!,
          techniqueChain: [{ id: 'stage-b', techniqueId: 'mosaic', enabled: true, params: { columns: 48 } }],
        }],
      };
      syncLayersForExport(changedStageId);
      expect(setChain).toHaveBeenLastCalledWith(layer.id, [
        expect.objectContaining({ stageId: 'stage-b', params: { columns: 48 } }),
      ]);

      const incompatible = {
        ...compatible,
        layers: [{
          ...compatible.layers[0]!,
          techniqueChain: [{ id: 'temporal', techniqueId: 'echo', enabled: true, params: {} }],
        }],
      };
      syncLayersForExport(incompatible);
      expect(setChain).toHaveBeenLastCalledWith(layer.id, []);
      expect(engine.branchFor(layer.id)?.hasTechniqueChain).toBe(false);
    } finally {
      resyncFromStore();
      setChain.mockRestore();
    }
  });
});

describe('LayerRuntimeImpl technique-chain render integration', () => {
  it('passes resolved stage params and restores render state after success or failure', () => {
    let currentTarget: unknown = { texture: 'outer' };
    let scissorTest = true;
    const fakeRenderer = {
      getRenderTarget: () => currentTarget,
      setRenderTarget: (target: unknown) => { currentTarget = target; },
      getScissorTest: () => scissorTest,
      setScissorTest: (enabled: boolean) => { scissorTest = enabled; },
      setClearColor: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    const makeTarget = (name: string) => ({
      width: 64,
      height: 64,
      texture: new THREE.Texture(),
      name,
    }) as unknown as THREE.WebGLRenderTarget;
    const outer = currentTarget;
    const scratch = [makeTarget('scratch-a'), makeTarget('scratch-b')] as const;
    const finalTarget = makeTarget('final');
    const primaryObject = new THREE.Object3D();
    const stageObject = new THREE.Object3D();
    const primary = {
      object3d: primaryObject,
      chainBehavior: 'stateless',
      update: vi.fn(),
      dispose: vi.fn(),
    } as unknown as TechniqueRenderer;
    const stage = {
      object3d: stageObject,
      chainBehavior: 'stateless',
      update: vi.fn(),
      dispose: vi.fn(),
    } as unknown as TechniqueRenderer;
    const runtime = new LayerRuntimeImpl();
    runtime.initBranch(fakeRenderer);
    runtime.setSource(new THREE.Texture());
    runtime.setTechniqueRenderer(primary);
    runtime.setTechniqueParams({ scale: 1 });
    runtime.setTechniqueChain([{ stageId: 'stage-a', renderer: stage, params: { columns: 24 } }]);
    runtime.setTechniqueStageParams(new Map([['stage-a', { columns: 64 }]]));
    runtime.setTechniqueScratchTargets(scratch);
    runtime.setMaterialState({ materialId: 'square', colorMode: 'source', params: {}, assetPath: null } as MaterialState);

    try {
      runtime.renderLayerTo(finalTarget, { clear: true });
      expect(stage.update).toHaveBeenLastCalledWith(
        { columns: 64 },
        expect.objectContaining({ sourceTexture: scratch[0]!.texture }),
      );
      expect(runtime.lastResolvedStageParams).toEqual({ 'stage-a': { columns: 64 } });
      expect(fakeRenderer.render).toHaveBeenCalledTimes(2);
      expect(currentTarget).toBe(outer);
      expect(scissorTest).toBe(true);
      expect(primaryObject.visible).toBe(true);
      expect(stageObject.visible).toBe(false);

      const failure = new Error('simulated GPU pass failure');
      (fakeRenderer.render as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw failure; });
      expect(() => runtime.renderLayerTo(finalTarget, { clear: true })).toThrow(failure);
      expect(currentTarget).toBe(outer);
      expect(scissorTest).toBe(true);
      expect(primaryObject.visible).toBe(true);
      expect(stageObject.visible).toBe(false);
    } finally {
      runtime.disposeBranch();
    }
  });
});
