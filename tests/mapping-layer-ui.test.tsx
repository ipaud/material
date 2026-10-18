import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModulationSection } from '@/inspector/ModulationSection';
import { useProjectStore } from '@/state/projectStore';
import { emptyLayer, type ModulationMapping } from '@shared/schemas/project';

afterEach(cleanup);

beforeEach(() => {
  useProjectStore.getState().newProject();
  const tech = { id: 't', techniqueId: 'flow-displace', enabled: true, params: {} };
  const mapping = {
    id: 'm1', enabled: true, source: 'audio.bass', target: 'amount', amount: 1, min: 0, max: 1,
    invert: false, smoothing: 0, curve: 'linear', frozenValue: null,
  } as ModulationMapping;
  useProjectStore.getState().apply((p) => ({
    ...p,
    layers: [
      { ...p.layers[0]!, id: 'l1', name: 'Base', technique: tech },
      { ...emptyLayer('l2', 'Grit'), technique: tech },
    ],
    selectedLayerId: 'l1',
    modulations: [mapping],
  }));
});

describe('mapping layer selector', () => {
  it('lets one mapping be aimed at a specific layer', () => {
    render(<ModulationSection />);
    fireEvent.click(screen.getByLabelText(/expand mapping/i));
    const select = screen.getByLabelText(/mapping layer/i) as HTMLSelectElement;
    expect(select.value).toBe('l1'); // absent target = the bottom layer, shown explicitly
    fireEvent.change(select, { target: { value: 'l2' } });
    expect(useProjectStore.getState().project.modulations[0]!.targetLayerId).toBe('l2');
  });
});
