import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createEmptyProject } from '@shared/schemas/project';
import { InspectorPanel } from '@/inspector/InspectorPanel';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';

function setup(
  chain: Array<{ id: string; techniqueId: string; enabled: boolean; params: Record<string, number | boolean | string> }> = [],
  sourceKind: 'image' | 'generator' = 'image',
) {
  const project = createEmptyProject('Chain inspector');
  const mosaic = getTechnique('mosaic')!;
  useProjectStore.setState({
    project: {
      ...project,
      sources: [sourceKind === 'generator'
        ? { id: 'src1', kind: 'generator', generator: 'noise', params: {}, seed: 1 }
        : { id: 'src1', kind: 'image', path: '/tmp/source.png', metadata: null }],
      composition: { ...project.composition, sourceId: 'src1' },
      layers: project.layers.map((layer, index) => index === 0
        ? { ...layer, sourceId: 'src1', technique: { id: 'primary', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) }, techniqueChain: chain }
        : layer),
    },
  });
  render(<InspectorPanel />);
  fireEvent.click(screen.getByRole('button', { name: /technique chain/i }));
}

beforeEach(() => {
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ project: createEmptyProject('Chain inspector') });
});

describe('BUILD technique-chain editor', () => {
  it('adds compatible stage with default parameter values', () => {
    setup();
    fireEvent.change(screen.getByRole('combobox', { name: /add technique stage/i }), { target: { value: 'mosaic' } });

    const stage = useProjectStore.getState().project.layers[0]!.techniqueChain[0]!;
    expect(stage.techniqueId).toBe('mosaic');
    expect(stage.params.columns).toBe(defaultParams(getTechnique('mosaic')!).columns);
    expect(stage.id).toBeTruthy();
  });

  it('explains why Generator → Mosaic → Flow Feedback is paused', () => {
    setup([{ id: 'feedback', techniqueId: 'flow-feedback', enabled: true, params: {} }], 'generator');

    expect(screen.getByText(/Chain paused: Feedback stages need per-stage state and export replay/i)).toBeInTheDocument();
  });

  it('reorders stages without changing their identities or params', () => {
    setup([
      { id: 'second', techniqueId: 'mosaic', enabled: true, params: { columns: 22 } },
      { id: 'third', techniqueId: 'flow-displace', enabled: true, params: { strength: 0.7 } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /3\. flow displace/i }));
    fireEvent.click(screen.getByRole('button', { name: /move flow displace up/i }));

    const chain = useProjectStore.getState().project.layers[0]!.techniqueChain;
    expect(chain.map((stage) => stage.id)).toEqual(['third', 'second']);
    expect(chain[0]?.params.strength).toBe(0.7);
    expect(chain[1]?.params.columns).toBe(22);
  });

  it('removes selected stage and leaves remaining stage untouched', () => {
    setup([
      { id: 'second', techniqueId: 'mosaic', enabled: true, params: { columns: 22 } },
      { id: 'third', techniqueId: 'flow-displace', enabled: true, params: { strength: 0.7 } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /2\. mosaic/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove mosaic/i }));

    expect(useProjectStore.getState().project.layers[0]!.techniqueChain).toEqual([
      { id: 'third', techniqueId: 'flow-displace', enabled: true, params: { strength: 0.7 } },
    ]);
  });

  it('edits and persists additional-stage parameters', () => {
    setup([{ id: 'second', techniqueId: 'mosaic', enabled: true, params: { columns: 22 } }]);
    fireEvent.click(screen.getByRole('button', { name: /2\. mosaic/i }));
    fireEvent.doubleClick(screen.getAllByText('Columns')[0]!);

    expect(useProjectStore.getState().project.layers[0]!.techniqueChain[0]!.params.columns).toBe(48);
  });
});

describe('typography text undo', () => {
  it('typing several characters is one undo step', () => {
    const project = createEmptyProject('Typography undo');
    const material = { materialId: 'typography', colorMode: 'source' as const, assetPath: null, params: { text: 'AB' } };
    useProjectStore.getState().loadProject('', {
      ...project,
      material,
      sources: [{ id: 'src1', kind: 'image', path: '/tmp/source.png', metadata: null }],
      composition: { ...project.composition, sourceId: 'src1' },
      layers: project.layers.map((layer, index) => index === 0
        ? { ...layer, sourceId: 'src1', material, technique: { id: 'primary', techniqueId: 'mosaic', enabled: true, params: defaultParams(getTechnique('mosaic')!) } }
        : layer),
    });
    render(<InspectorPanel />);
    const text = screen.getByRole('textbox', { name: 'Text' });
    fireEvent.change(text, { target: { value: 'ABC' } });
    fireEvent.change(text, { target: { value: 'ABCD' } });
    fireEvent.change(text, { target: { value: 'ABCDE' } });
    fireEvent.blur(text);
    const textOf = () => useProjectStore.getState().project.layers[0]!.material.params.text;
    expect(textOf()).toBe('ABCDE');

    useProjectStore.getState().undo();
    expect(textOf()).toBe('AB');
  });
});

describe('typography text field styling', () => {
  it('the textarea class has a themed rule, not the browser default white box', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/components/parameter-slider.css', 'utf8');
    const rule = /\n\.input\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--surface-2\)/);
    expect(rule).toMatch(/color:\s*var\(--text-0\)/);
    expect(readFileSync('src/styles/global.css', 'utf8')).toMatch(/\.input:focus-visible/);
    // The row is a fixed 22px line; without this the field covered the Color row above.
    expect(css).toMatch(/\.param-row:has\(> \.input\)\s*\{[^}]*height:\s*auto/);
  });
});
