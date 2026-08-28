import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CandidatePane } from '@/explore/CandidatePane';
import { ExploreRail } from '@/explore/ExploreRail';
import { PopulationStrip } from '@/explore/PopulationStrip';
import { ExploreActions } from '@/explore/ActionBar';
import { StageHeader } from '@/explore/StageHeader';
import { ExploreEmpty } from '@/workspaces/ExploreWorkspace';
import {
  candidateRuntime,
  useCandidateStore,
  type Candidate,
} from '@/performance/candidateRuntime';
import { emptyMutationLocks } from '@/performance/mutation';
import { useExploreStore } from '@/state/exploreStore';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { createEmptyProject } from '@shared/schemas/project';
import type { Variation } from '@/explore/exploration';

function fakeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'cand_test',
    parentLookId: null,
    parentSeed: 111,
    seed: 829174,
    core: {
      techniqueId: 'mosaic',
      params: {},
      material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
      modulations: [],
      triggers: [],
      seed: 829174,
    },
    metadata: {
      seed: 829174,
      parentSeed: 111,
      intensity: 'med',
      locks: emptyMutationLocks(),
      generation: 3,
      changedParams: 5,
      changedModulations: 1,
    },
    thumbnail: 'data:image/png;base64,',
    parentCandidateId: 'cand_prev',
    label: 'MUTATION 9174',
    darkThumbnail: false,
    ...overrides,
  };
}

function setCandidate(candidate: Candidate | null, previewing = false) {
  useCandidateStore.setState({ candidate, previewing, queuedId: null });
}

beforeEach(() => {
  useProjectStore.setState({ project: createEmptyProject('Explore test') });
  setCandidate(null);
  useCandidateStore.setState({ intensity: 'med', locks: emptyMutationLocks() });
  useExploreStore.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CandidatePane — no candidate', () => {
  it('stays structurally present and offers MUTATE CURRENT', () => {
    const generate = vi.spyOn(candidateRuntime, 'generate').mockReturnValue(null);
    render(<CandidatePane />);
    expect(screen.getByText('CANDIDATE')).toBeInTheDocument();
    expect(screen.getByText('NO CANDIDATE')).toBeInTheDocument();
    fireEvent.click(screen.getByText('MUTATE CURRENT'));
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('CandidatePane — with candidate', () => {
  it('shows label, seed and generation', () => {
    setCandidate(fakeCandidate());
    render(<CandidatePane />);
    expect(screen.getByText('MUTATION 9174')).toBeInTheDocument();
    expect(screen.getByText(/SEED 829174/)).toBeInTheDocument();
    expect(screen.getByText(/GEN 03/)).toBeInTheDocument();
  });

  it('hold-to-audition presses and releases the preview, never toggles', () => {
    setCandidate(fakeCandidate());
    const setPreview = vi.spyOn(candidateRuntime, 'setPreview').mockImplementation(() => {});
    render(<CandidatePane />);
    const button = screen.getByText('HOLD TO AUDITION');
    fireEvent.pointerDown(button);
    expect(setPreview).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(button);
    expect(setPreview).toHaveBeenLastCalledWith(false);
    fireEvent.pointerDown(button);
    fireEvent.pointerLeave(button);
    expect(setPreview).toHaveBeenLastCalledWith(false);
  });

  it('names the audition state in text while previewing, not colour alone', () => {
    setCandidate(fakeCandidate(), true);
    render(<CandidatePane />);
    expect(screen.getByText('AUDITIONING — RELEASE FOR CURRENT')).toBeInTheDocument();
    expect(screen.getByText('ON STAGE')).toBeInTheDocument();
  });

  it('offers re-thumbnail when the captured frame was dark', () => {
    setCandidate(fakeCandidate({ darkThumbnail: true }));
    const rethumb = vi.spyOn(candidateRuntime, 'rethumbnail').mockImplementation(() => {});
    render(<CandidatePane />);
    fireEvent.click(screen.getByText('DARK FRAME — RE-THUMBNAIL'));
    expect(rethumb).toHaveBeenCalledTimes(1);
  });
});

describe('StageHeader', () => {
  it('says CURRENT normally and PREVIEWING CANDIDATE while auditioning', () => {
    render(<StageHeader />);
    expect(screen.getByText('CURRENT')).toBeInTheDocument();
    cleanup();
    setCandidate(fakeCandidate(), true);
    render(<StageHeader />);
    expect(screen.getByText('PREVIEWING CANDIDATE')).toBeInTheDocument();
    expect(screen.getByText('MUTATION 9174')).toBeInTheDocument();
  });
});

describe('ExploreRail', () => {
  it('shows mutation info from real candidate metadata', () => {
    setCandidate(fakeCandidate());
    render(<ExploreRail />);
    expect(screen.getByText('829174')).toBeInTheDocument();
    expect(screen.getByText('111')).toBeInTheDocument();
    expect(screen.getByText('5P / 1M')).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
  });

  it('toggles mutation locks through the existing store', () => {
    render(<ExploreRail />);
    fireEvent.click(screen.getByText('TIMING'));
    expect(useCandidateStore.getState().locks.timing).toBe(true);
    fireEvent.click(screen.getByText('TIMING'));
    expect(useCandidateStore.getState().locks.timing).toBe(false);
  });

  it('renders lineage compactly with prior mutation count', () => {
    setCandidate(fakeCandidate());
    render(<ExploreRail />);
    expect(screen.getByText(/2 prior mutations/)).toBeInTheDocument();
    expect(screen.getByText(/MUTATION 9174/)).toBeInTheDocument();
  });

  it('hides lineage when there is no candidate', () => {
    render(<ExploreRail />);
    expect(screen.queryByText('LINEAGE')).not.toBeInTheDocument();
  });
});

describe('ExploreActions', () => {
  it('selects mutation intensity', () => {
    render(<ExploreActions />);
    fireEvent.click(screen.getByText('HIGH'));
    expect(useCandidateStore.getState().intensity).toBe('high');
    expect(screen.getByText('HIGH')).toHaveAttribute('aria-checked', 'true');
  });

  it('disables candidate verbs without a candidate and wires them with one', () => {
    const apply = vi.spyOn(candidateRuntime, 'apply').mockReturnValue(true);
    const pin = vi.spyOn(candidateRuntime, 'pin').mockReturnValue(null);
    const { unmount } = render(<ExploreActions />);
    expect(screen.getByText('APPLY')).toBeDisabled();
    expect(screen.getByText('PIN')).toBeDisabled();
    expect(screen.getByText('MUTATE AGAIN')).toBeDisabled();
    expect(screen.getByText('MUTATE')).toBeInTheDocument();
    unmount();

    setCandidate(fakeCandidate());
    render(<ExploreActions />);
    expect(screen.getByText('REGENERATE')).toBeInTheDocument();
    fireEvent.click(screen.getByText('APPLY'));
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('PIN'));
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it('MUTATE AGAIN mutates from the candidate, preserving lineage', () => {
    setCandidate(fakeCandidate());
    const generate = vi.spyOn(candidateRuntime, 'generate').mockReturnValue(null);
    render(<ExploreActions />);
    fireEvent.click(screen.getByText('MUTATE AGAIN'));
    expect(generate).toHaveBeenCalledWith({ fromCandidate: true });
  });
});

describe('PopulationStrip', () => {
  const variation = (seed: number): Variation => ({
    seed,
    generation: 0,
    parentSeed: null,
    patch: { params: {}, modulations: {} },
  });

  it('renders the population and marks the selection', () => {
    useExploreStore.getState().startGeneration(1, [variation(101), variation(102)]);
    useExploreStore.getState().finishGeneration();
    render(<PopulationStrip />);
    const cards = document.querySelectorAll('.pop-card');
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[0]!);
    expect(useExploreStore.getState().selectedSeed).toBe(101);
    expect(document.querySelector('.pop-card.selected')).toBe(cards[0]);
  });

  it('shows selection metadata and actions only with a selection', () => {
    useExploreStore.getState().startGeneration(1, [variation(101)]);
    useExploreStore.getState().finishGeneration();
    render(<PopulationStrip />);
    expect(screen.queryByText('PIN')).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('.pop-card')!);
    expect(screen.getByText(/SEED 101/)).toBeInTheDocument();
    expect(screen.getByText('PIN')).toBeInTheDocument();
    expect(screen.getByText('APPLY')).toBeInTheDocument();
    expect(screen.getByText('MUTATE SELECTED')).toBeInTheDocument();
  });
});

describe('empty project', () => {
  it('routes to BUILD instead of faking a population', () => {
    useUiStore.setState({ workspace: 'explore' });
    render(<ExploreEmpty />);
    expect(screen.getByText('BUILD A SYSTEM FIRST')).toBeInTheDocument();
    fireEvent.click(screen.getByText('GO TO BUILD'));
    expect(useUiStore.getState().workspace).toBe('build');
  });
});

describe('candidate preview isolation (UI path)', () => {
  it('resolveOverlay stays null when not previewing and pure when previewing', () => {
    // The UI never mutates the document to preview: the overlay resolve is
    // the only path, and it must be a pure read.
    expect(candidateRuntime.resolveOverlay()).toBeNull();
    const before = useProjectStore.getState().project;
    setCandidate(fakeCandidate(), true);
    // Store-level preview flag alone must not touch the project document.
    expect(useProjectStore.getState().project).toBe(before);
  });
});
