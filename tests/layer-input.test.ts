import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  emptyLayer,
  layerSchema,
  parseProject,
} from '@shared/schemas/project';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

describe('layer.input', () => {
  it('defaults to "source": every existing layer means what it always meant', () => {
    expect(emptyLayer('x').input).toBe('source');
    const parsed = layerSchema.parse({
      id: 'l1',
      material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    });
    expect(parsed.input).toBe('source');
  });

  it('accepts "below", refuses anything else, and survives a save/load round trip', () => {
    const project = createEmptyProject('serial');
    const layers = project.layers.map((l) => ({ ...l, input: 'below' as const }));
    const back = parseProject(JSON.parse(JSON.stringify({ ...project, layers })));
    expect(back.layers[0]!.input).toBe('below');
    expect(() => layerSchema.parse({ ...layers[0], input: 'above' })).toThrow();
  });

  it('a project written before the field loads with every layer on "source"', () => {
    const project = createEmptyProject('old');
    const stripped = {
      ...project,
      layers: project.layers.map(({ input: _input, ...rest }) => rest),
    };
    expect(parseProject(JSON.parse(JSON.stringify(stripped))).layers.every((l) => l.input === 'source')).toBe(true);
  });
});

// No GL context in vitest: the structure is pinned here, the pixels by
// scripts/serial-gate.mjs (headless renders).
describe('serial layers are drawn AFTER the layers beneath them, inside the composite', () => {
  const compositor = read('src/rendering/layers/LayerCompositor.ts');
  const host = read('src/rendering/layers/LayerHost.ts');

  it('the compositor hands a layer the accumulated backdrop before it samples the layer', () => {
    expect(compositor).toContain('before?: (backdrop: THREE.Texture) => void');
    const loop = compositor.slice(compositor.indexOf('for (const layer of layers)'));
    expect(loop.indexOf('layer.before?.(read.texture)')).toBeGreaterThan(-1);
    expect(loop.indexOf('layer.before?.(read.texture)')).toBeLessThan(loop.indexOf('u.uLayer!.value = layer.texture'));
  });

  it('only "source" layers may take the single-opaque fast path', () => {
    const fn = host.slice(host.indexOf('private singleOpaqueIndex'));
    expect(fn.slice(0, 600)).toContain("(state.input ?? 'source') !== 'source'");
  });

  it('"source" layers still render eagerly, in the same order as before', () => {
    const fn = host.slice(host.indexOf('  composite('));
    expect(fn).toContain("state.input === 'below'");
  });
});
