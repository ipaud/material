import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('v0.6E — the Output shows the composition, and still evaluates nothing', () => {
  it('the stack crosses as CONFIGURATION and resolved values, never pixels', () => {
    const channel = stripComments(read('shared', 'outputChannel.ts'));
    // Configuration on the low-rate message.
    expect(channel).toContain('layers?: OutputLayerInput[]');
    expect(channel).toContain('blendMode: string');
    // Resolved values on the per-frame message.
    expect(channel).toContain('layerParams?: Record<string, ParamRecord>');
    expect(channel).toContain('layerOpacity?: Record<string, number>');
    expect(channel).toContain('layerSourceParams?: Record<string, ParamRecord>');
    // And nothing that could be an image.
    for (const banned of ['ImageData', 'pixels', 'Float32Array', 'texture', 'Texture', 'canvas']) {
      expect(channel.includes(banned), `channel must not carry ${banned}`).toBe(false);
    }
  });

  it('the replica evaluates no modulation of its own', () => {
    // Passivity is the whole contract. Layers must not have smuggled an
    // evaluator into the Output process.
    for (const f of ['replica.ts', 'outputLayer.ts']) {
      const src = read('src', 'output-window', f);
      for (const banned of [
        'applyModulations',
        'modulationRuntime',
        'evalSources',
        'useProjectStore',
        'applyMacros',
        'morphRuntime',
      ]) {
        expect(src.includes(banned), `${f} must not reach for ${banned}`).toBe(false);
      }
    }
  });

  it('every layer is published once, by the host, not once per branch', () => {
    // A branch is not the composition. If each published, the Output would get
    // one message per layer per frame and show whichever arrived last.
    // v0.6.1 makes this structural: the runtime class cannot reach the bus at
    // all, so there is exactly one emitFrame site in the tree and it is the
    // host's, called after compositing.
    const runtime = read('src', 'rendering', 'layers', 'LayerRuntimeImpl.ts');
    expect(runtime.includes('runtimeBus'), 'a runtime must not reach the bus').toBe(false);
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    expect((engine.match(/runtimeBus\.emitFrame\(/g) ?? []).length).toBe(1);
    expect(engine).toContain('private publishComposition()');
  });

  it('the bridge forwards the stack on both messages', () => {
    // Declaring a field and never copying it is exactly how CE1F and CE1G
    // stayed invisible in the Output for a release.
    const bridge = read('src', 'output', 'outputBridge.ts');
    const inputs = bridge.slice(bridge.indexOf('function toInputsMsg'));
    expect(inputs.slice(0, 700)).toContain('layers: inputs.layers');
    const frame = bridge.slice(bridge.indexOf('function toFrameMsg'));
    expect(frame.slice(0, 1600)).toContain('layerParams: frame.layerParams');
    expect(frame.slice(0, 1600)).toContain('layerOpacity: frame.layerOpacity');
    expect(frame.slice(0, 1600)).toContain('layerSourceParams: frame.layerSourceParams');
  });

  it('authority values win over any locally resolved one', () => {
    // In an export and in the replica the value has already been resolved
    // elsewhere. Checking the live sink first made the Output ignore the
    // opacity it had just been sent.
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const fn = host.slice(host.indexOf('private effectiveOpacityAt('));
    const body = fn.slice(0, 700);
    expect(body.indexOf('authorityOpacity')).toBeLessThan(body.indexOf('opacitySink'));
    // The ordinary preview path reaches for them too — that is how the replica
    // renders, since it has no transform of its own.
    const comp = host.slice(host.indexOf('  composite('));
    expect(comp.slice(0, 700)).toContain('override ?? this.authorityParams');
  });

  it('a replica that predates layers is left on its single-source path', () => {
    const replica = read('src', 'output-window', 'replica.ts');
    const fn = replica.slice(replica.indexOf('private applyLayerInputs('));
    expect(fn.slice(0, 700)).toContain('if (!inputs || inputs.length === 0)');
  });

  it('a generator layer in the Output is a temporal source, as it is in the editor', () => {
    // Omitting it left a Slit Scan layer with no history at all: mean 128
    // against the editor's 191, with real black where the editor had none.
    const layer = read('src', 'output-window', 'outputLayer.ts');
    expect(layer).toContain('branch.setTemporalSource(this.generator.temporalSource())');
    // Capability is decided from the same registry helper on both sides.
    expect(layer).toContain('techniqueNeedsTemporal(');
  });
});
