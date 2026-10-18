import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TriggersSection } from '@/inspector/TriggersSection';
import { useProjectStore } from '@/state/projectStore';
import { emptyLayer, triggerMappingSchema } from '@shared/schemas/project';

afterEach(cleanup);

beforeEach(() => {
  useProjectStore.getState().newProject();
  const tech = { id: 't', techniqueId: 'flow-displace', enabled: true, params: {} };
  useProjectStore.getState().apply((p) => ({
    ...p,
    layers: [
      { ...p.layers[0]!, id: 'l1', name: 'Base', technique: tech },
      { ...emptyLayer('l2', 'Grit'), technique: tech },
    ],
    selectedLayerId: 'l1',
    triggers: [
      { ...triggerMappingSchema.parse({ id: 'k', enabled: true, source: 'beat', action: 'pulse' }), targetParam: 'amount' },
    ],
  }));
});

describe('trigger layer selector', () => {
  it('aims a pulse at one layer and can return it to the primary layer', () => {
    render(<TriggersSection />);
    fireEvent.click(screen.getByLabelText(/expand trigger/i));
    const select = screen.getByLabelText(/trigger layer/i) as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'l2' } });
    expect(useProjectStore.getState().project.triggers[0]!.targetLayerId).toBe('l2');
    fireEvent.change(select, { target: { value: '' } });
    expect('targetLayerId' in useProjectStore.getState().project.triggers[0]!).toBe(false);
  });
});
