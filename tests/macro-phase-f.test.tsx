import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createEmptyProject } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useMidiStore, midiEngine } from '@/midi/midiEngine';
import { MacrosSection } from '@/inspector/MacrosSection';
import { MidiSection } from '@/inspector/MidiSection';

const mapping = {
  targetParam: 'scale',
  amount: 0.5,
  min: 0.2,
  max: 0.8,
  invert: false,
  curve: 'linear' as const,
  enabled: true,
};

function setProject() {
  const project = createEmptyProject('Macro phase F');
  useProjectStore.setState({
    project: {
      ...project,
      layers: project.layers.map((layer) => ({
        ...layer,
        technique: { id: 'tech1', techniqueId: 'mosaic', enabled: true, params: {} },
      })),
      macros: [{ id: 'mac1', name: 'CHAOS', value: 0.4, mappings: [mapping] }],
      midiMappings: [
        {
          id: 'midi1',
          enabled: true,
          deviceId: 'dev1',
          deviceLabel: 'Test Controller',
          channel: 0,
          messageType: 'cc',
          control: 12,
          targetType: 'macro',
          targetParam: 'mac1',
          action: null,
          targetMappingId: null,
          lookSlot: null,
          quantize: 'off',
          min: 0,
          max: 1,
          invert: false,
          smoothing: 0,
          curve: 'linear',
          pickupMode: 'pickup',
          mode: 'absolute',
        },
      ],
    },
  });
}

beforeEach(() => {
  setProject();
  useMidiStore.setState({ availability: 'ready', devices: [], bound: {}, status: {}, learn: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Macro 2.0 mapping controls', () => {
  it('exposes mapping window, inversion and curve as editable controls', () => {
    render(<MacrosSection />);
    fireEvent.click(screen.getByRole('button', { name: '⋯' }));

    const minimum = screen.getByLabelText('Mapping minimum');
    const maximum = screen.getByLabelText('Mapping maximum');
    const invert = screen.getByLabelText('Invert macro mapping');
    const curve = screen.getByLabelText('Mapping curve');
    expect(minimum).toHaveValue('0.2');
    expect(maximum).toHaveValue('0.8');
    expect(curve).toHaveValue('linear');

    fireEvent.change(minimum, { target: { value: '0.1' } });
    fireEvent.change(maximum, { target: { value: '0.9' } });
    fireEvent.click(invert);
    fireEvent.change(curve, { target: { value: 'exponential' } });

    expect(useProjectStore.getState().project.macros[0]?.mappings[0]).toMatchObject({
      min: 0.1,
      max: 0.9,
      invert: true,
      curve: 'exponential',
    });
  });

  it('labels macro MIDI destinations and preserves macro target during relearn', () => {
    const startLearn = vi.spyOn(midiEngine, 'startLearn').mockResolvedValue(null);
    render(<MidiSection />);

    expect(screen.getByText('CHAOS')).toBeInTheDocument();
    act(() => {
      useProjectStore.getState().apply((project) => ({
        ...project,
        macros: project.macros.map((macro) => ({ ...macro, name: 'AFTERSHOCK' })),
      }));
    });
    expect(screen.getByText('AFTERSHOCK')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Relearn'));
    expect(startLearn).toHaveBeenCalledWith({ targetType: 'macro', targetParam: 'mac1' }, 'AFTERSHOCK');
  });
});
