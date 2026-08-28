import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ActionsStrip,
  CandidateCluster,
  LooksStrip,
  MacrosStrip,
} from '@/performance/ui/PerformanceWorkspace';
import { StageOverlay } from '@/performance/ui/StageOverlay';
import { HudLine } from '@/performance/ui/HudLine';
import { StatusRail } from '@/performance/ui/StatusRail';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { useMidiStore } from '@/midi/midiEngine';
import { candidateRuntime, useCandidateStore } from '@/performance/candidateRuntime';
import { emptyMutationLocks } from '@/performance/mutation';
import { createEmptyProject, type PinnedLook, type Project } from '@shared/schemas/project';

function look(slot: number, label: string, overrides: Partial<PinnedLook> = {}): PinnedLook {
  return {
    id: `look_${slot}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    label,
    note: '',
    slot,
    seed: slot * 100,
    thumbnail: null,
    techniques: [
      { id: `t${slot}`, techniqueId: 'mosaic', enabled: true, params: { columns: 10 * slot } },
    ],
    material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    modulations: [],
    triggers: [],
    ...overrides,
  };
}

function setProject(mutate: (p: Project) => Project) {
  useProjectStore.setState({ project: mutate(createEmptyProject('Perform test')) });
}

function midiMapping(control: number): Project['midiMappings'][number] {
  return {
    id: 'mm1',
    enabled: true,
    deviceId: 'dev1',
    deviceLabel: 'Test Controller',
    channel: 1,
    messageType: 'cc',
    control,
    targetType: 'macro',
    targetParam: 'mac1',
    action: null,
    targetMappingId: null,
    lookSlot: null,
    quantize: 'off',
    invert: false,
    smoothing: 0,
    min: 0,
    max: 1,
    curve: 'linear',
    pickupMode: 'pickup',
    mode: 'absolute',
  };
}

const frozenMapping = {
  id: 'm1',
  source: 'bass',
  target: 'scale',
  amount: 0.5,
  smoothing: 0.25,
  min: 0,
  max: 1,
  curve: 'linear' as const,
  invert: false,
  enabled: true,
  frozenValue: 0.4,
};

beforeEach(() => {
  vi.useFakeTimers();
  setProject((p) => p);
  useCandidateStore.setState({
    candidate: null,
    previewing: false,
    queuedId: null,
    intensity: 'med',
    locks: emptyMutationLocks(),
  });
  useUiStore.setState({ perfMorphTargetId: null, offlineSources: [], workspace: 'perform' });
  useMidiStore.setState({ devices: [], availability: 'idle', learn: null, status: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeCandidate(gen = 1) {
  return {
    id: 'cand_1',
    parentLookId: null,
    parentSeed: 1,
    seed: 842,
    core: {
      techniqueId: 'mosaic',
      params: {},
      material: { materialId: 'square', colorMode: 'source' as const, params: {}, assetPath: null },
      modulations: [],
      triggers: [],
      seed: 842,
    },
    metadata: {
      seed: 842,
      parentSeed: 1,
      intensity: 'med' as const,
      locks: emptyMutationLocks(),
      generation: gen,
      changedParams: 3,
      changedModulations: 0,
    },
    thumbnail: null,
    parentCandidateId: null,
    label: 'MUTATION 0842',
    darkThumbnail: false,
  };
}

describe('LooksStrip', () => {
  it('renders active look with yellow state and its number/name', () => {
    setProject((p) => ({
      ...p,
      pinnedLooks: [look(1, 'CLEAN'), look(2, 'PUMP')],
      activeLookId: 'look_1',
    }));
    render(<LooksStrip />);
    const active = document.querySelector('.perf-look.active');
    expect(active).not.toBeNull();
    expect(active).toHaveTextContent('CLEAN');
    expect(active).toHaveTextContent('1');
    expect(document.querySelectorAll('.perf-look.empty')).toHaveLength(7);
  });

  it('marks a modified active look with the dirty dot', () => {
    setProject((p) => ({
      ...p,
      pinnedLooks: [look(1, 'CLEAN')],
      activeLookId: 'look_1',
      techniques: [{ id: 'live', techniqueId: 'mosaic', enabled: true, params: { columns: 999 } }],
      explore: { lockedParams: [], lastSeed: 100 },
    }));
    render(<LooksStrip />);
    expect(document.querySelector('.perf-dirty')).not.toBeNull();
  });

  it('shows the morph target with cyan MORPH state, never colour alone', () => {
    setProject((p) => ({ ...p, pinnedLooks: [look(1, 'CLEAN'), look(2, 'PUMP')] }));
    useUiStore.setState({ perfMorphTargetId: 'look_2' });
    render(<LooksStrip />);
    const target = document.querySelector('.perf-look.morph-target');
    expect(target).toHaveTextContent('PUMP');
    expect(target).toHaveTextContent('MORPH');
  });
});

describe('MacrosStrip', () => {
  it('shows macro name, value and CC pickup state as text', () => {
    setProject((p) => ({
      ...p,
      macros: [{ id: 'mac1', name: 'MEMORY', value: 0.73, mappings: [] }],
      midiMappings: [midiMapping(21)],
    }));
    useMidiStore.setState({ status: { mm1: 'waiting' } });
    render(<MacrosStrip />);
    expect(screen.getByText('MEMORY')).toBeInTheDocument();
    expect(screen.getByText('0.73')).toBeInTheDocument();
    expect(screen.getByText(/CC21 · PICKUP/)).toBeInTheDocument();
  });

  it('names live and frozen states', () => {
    setProject((p) => ({
      ...p,
      macros: [{ id: 'mac1', name: 'DEPTH', value: 0.2, mappings: [] }],
      midiMappings: [midiMapping(9)],
    }));
    useMidiStore.setState({ status: { mm1: 'live' } });
    render(<MacrosStrip />);
    expect(screen.getByText(/CC9 · LIVE/)).toBeInTheDocument();
  });
});

describe('ActionsStrip', () => {
  it('FREEZE reads as engaged ■ FROZEN text when any value is frozen', () => {
    setProject((p) => ({ ...p, modulations: [frozenMapping] }));
    render(<ActionsStrip />);
    const btn = screen.getByText('■ FROZEN');
    expect(btn).toHaveClass('engaged');
  });

  it('shows the active quantization', () => {
    setProject((p) => ({ ...p, performanceQuantize: '2bars' }));
    render(<ActionsStrip />);
    // '2 BARS' also exists as a morph duration option — scope to the SYNC group.
    const sync = screen.getByRole('group', { name: 'Quantization' });
    const active = sync.querySelector('.perf-quant-btn.active');
    expect(active).toHaveTextContent('2 BARS');
  });

  it('pads use real payload names and have accessible labels', () => {
    setProject((p) => ({
      ...p,
      performancePads: [
        {
          id: 'pad1',
          label: 'PUMP',
          velocityScale: false,
          trigger: {
            id: 'pt1',
            enabled: true,
            source: 'manual',
            action: 'pulse' as const,
            targetParam: 'scale',
            targetMappingId: null,
            lookSlot: null,
            quantize: 'off' as const,
            cooldownSec: 0,
            attackSec: 0.01,
            holdSec: 0,
            decaySec: 0.2,
            amount: 0.3,
            curve: 'easeOut' as const,
          },
        },
        { id: 'pad2', label: 'EMPTY', velocityScale: false, trigger: null },
      ],
    }));
    render(<ActionsStrip />);
    expect(screen.getByLabelText('Pad Z: PUMP')).toBeEnabled();
    expect(screen.getByLabelText('Pad X unassigned')).toBeDisabled();
  });

  it('pad flashes imperatively on the pad-fired event', () => {
    setProject((p) => ({
      ...p,
      performancePads: [
        {
          id: 'pad1',
          label: 'PUMP',
          velocityScale: false,
          trigger: {
            id: 'pt1',
            enabled: true,
            source: 'manual',
            action: 'pulse' as const,
            targetParam: 'scale',
            targetMappingId: null,
            lookSlot: null,
            quantize: 'off' as const,
            cooldownSec: 0,
            attackSec: 0.01,
            holdSec: 0,
            decaySec: 0.2,
            amount: 0.3,
            curve: 'easeOut' as const,
          },
        },
      ],
    }));
    render(<ActionsStrip />);
    window.dispatchEvent(new CustomEvent('material:pad-fired', { detail: 'pad1' }));
    expect(document.querySelector('.perf-pad.fired')).not.toBeNull();
  });
});

describe('CandidateCluster', () => {
  it('collapses to MUTATE plus intensity/locks when no candidate exists', () => {
    render(<CandidateCluster />);
    expect(screen.getByText('MUTATE')).toBeInTheDocument();
    expect(screen.getByText('MED')).toHaveClass('active');
    expect(screen.queryByText('APPLY')).not.toBeInTheDocument();
  });

  it('shows candidate identity, preview hold and queued state', () => {
    useCandidateStore.setState({ candidate: fakeCandidate(), queuedId: 'cand_1' });
    render(<CandidateCluster />);
    expect(screen.getByText('MUTATION 0842')).toBeInTheDocument();
    expect(screen.getByText(/QUEUED/)).toBeInTheDocument();
    const hold = screen.getByText('B · HOLD');
    const setPreview = vi.spyOn(candidateRuntime, 'setPreview').mockImplementation(() => {});
    fireEvent.pointerDown(hold);
    expect(setPreview).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(hold);
    expect(setPreview).toHaveBeenLastCalledWith(false);
  });

  it('labels an active audition in text', () => {
    useCandidateStore.setState({ candidate: fakeCandidate(), previewing: true });
    render(<CandidateCluster />);
    expect(screen.getByText('◉ PREVIEWING')).toBeInTheDocument();
    expect(screen.getByText(/ON OUTPUT/)).toBeInTheDocument();
  });
});

describe('StageOverlay priority', () => {
  it('shows the current look chip', () => {
    setProject((p) => ({ ...p, pinnedLooks: [look(3, 'ECHO')], activeLookId: 'look_3' }));
    render(<StageOverlay />);
    expect(screen.getByText('ECHO')).toBeInTheDocument();
  });

  it('FROZEN outranks candidate preview; OFFLINE outranks FROZEN', () => {
    setProject((p) => ({
      ...p,
      sources: [{ id: 's1', kind: 'video', path: '/tmp/x.mp4', metadata: null }],
      composition: { ...p.composition, sourceId: 's1' },
      modulations: [frozenMapping],
    }));
    useCandidateStore.setState({ candidate: fakeCandidate(), previewing: true });
    const { rerender } = render(<StageOverlay />);
    expect(screen.getByText('■ FROZEN')).toBeInTheDocument();
    expect(screen.queryByText('PREVIEWING CANDIDATE')).not.toBeInTheDocument();

    useUiStore.setState({ offlineSources: ['s1'] });
    rerender(<StageOverlay />);
    expect(screen.getByText('MEDIA OFFLINE')).toBeInTheDocument();
    expect(screen.queryByText('■ FROZEN')).not.toBeInTheDocument();
  });
});

describe('HUD trust', () => {
  it('keeps FROZEN visible and working in HUD', () => {
    setProject((p) => ({ ...p, modulations: [frozenMapping] }));
    render(<HudLine />);
    const chip = screen.getByText('■ FROZEN');
    expect(chip).toBeInTheDocument();
    expect(chip.tagName).toBe('BUTTON');
  });

  it('labels candidate audition inside HUD', () => {
    useCandidateStore.setState({ candidate: fakeCandidate(), previewing: true });
    render(<HudLine />);
    expect(screen.getByText('PREVIEWING CANDIDATE')).toBeInTheDocument();
  });
});

describe('StatusRail MIDI', () => {
  it('shows OFFLINE with mappings retained when a mapped project has no device', () => {
    setProject((p) => ({
      ...p,
      midiMappings: [midiMapping(21)],
    }));
    useMidiStore.setState({ availability: 'ready', devices: [] });
    render(<StatusRail />);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.getByText('MAPPINGS RETAINED')).toBeInTheDocument();
  });

  it('shows the device name when connected', () => {
    useMidiStore.setState({
      availability: 'ready',
      devices: [{ id: 'd1', name: 'Launch Control XL', manufacturer: 'Novation' }],
    });
    render(<StatusRail />);
    expect(screen.getByText('Launch Control XL')).toBeInTheDocument();
  });
});
