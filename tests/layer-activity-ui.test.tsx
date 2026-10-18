import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LayerStrip } from '@/performance/ui/LayerStrip';
import { setLayerActivity } from '@/projects/layerActions';
import { useProjectStore } from '@/state/projectStore';

afterEach(cleanup);
beforeEach(() => useProjectStore.getState().newProject());

const layer0 = () => useProjectStore.getState().project.layers[0]!;

describe('setLayerActivity', () => {
  it('sets, patches and clears a window; end can never precede start', () => {
    const id = layer0().id;
    setLayerActivity(id, { start: 10, end: 20 });
    expect(layer0().activity).toEqual({ start: 10, end: 20, fadeIn: 0, fadeOut: 0 });
    setLayerActivity(id, { fadeIn: 2 });
    expect(layer0().activity).toMatchObject({ start: 10, end: 20, fadeIn: 2 });
    setLayerActivity(id, { start: 25 });
    expect(layer0().activity!.end).toBeGreaterThan(layer0().activity!.start);
    setLayerActivity(id, null);
    expect(layer0().activity).toBeNull();
  });

  it('is one undo step', () => {
    const id = layer0().id;
    setLayerActivity(id, { start: 5, end: 9 });
    useProjectStore.getState().undo();
    expect(layer0().activity).toBeNull();
  });
});

describe('LayerStrip window fields', () => {
  it('shows start/end/fade fields and writes them to the layer', () => {
    render(<LayerStrip />);
    fireEvent.click(screen.getByRole('button', { name: /layer 1 window/i }));
    fireEvent.change(screen.getByLabelText(/layer 1 window start/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/layer 1 window end/i), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText(/layer 1 fade in/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/layer 1 fade out/i), { target: { value: '3' } });
    expect(layer0().activity).toEqual({ start: 10, end: 20, fadeIn: 2, fadeOut: 3 });
  });
});

describe('LayerStrip input selector', () => {
  it('chooses between the layer\'s own source and the layers beneath it', async () => {
    const { addLayer, setLayerInput } = await import('@/projects/layerActions');
    addLayer();
    const second = useProjectStore.getState().project.layers[1]!;
    render(<LayerStrip />);
    const select = screen.getByLabelText(`${second.name || 'Layer 2'} input`) as HTMLSelectElement;
    expect(select.value).toBe('source');
    fireEvent.change(select, { target: { value: 'below' } });
    expect(useProjectStore.getState().project.layers[1]!.input).toBe('below');
    setLayerInput(second.id, 'source');
    expect(useProjectStore.getState().project.layers[1]!.input).toBe('source');
  });

  it('the bottom layer has nothing beneath it, so its selector is disabled', () => {
    render(<LayerStrip />);
    expect(screen.getByLabelText('Layer 1 input')).toBeDisabled();
  });
});
