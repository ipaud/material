import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createEmptyProject } from '@shared/schemas/project';
import { LooksPanel } from '@/library/LooksPanel';
import { pinCurrentLook } from '@/projects/lookActions';
import { useProjectStore } from '@/state/projectStore';
import { useExploreStore } from '@/state/exploreStore';
import { useUiStore } from '@/state/uiStore';
import { exploreAroundPin } from '@/explore/exploreActions';
import { engine } from '@/rendering/RenderEngine';
import { createPin } from '@/projects/lookActions';
import { exportPngStill } from '@/export/exportStill';

afterEach(() => cleanup());

describe('Pins in Library', () => {
  it('promotes an unslotted Pin into the next Look slot', () => {
    const project = createEmptyProject('Pin UI');
    useProjectStore.getState().loadProject('', {
      ...project,
      layers: [
        {
          ...project.layers[0]!,
          technique: { id: 'tech-pin-ui', techniqueId: 'mosaic', enabled: true, params: {} },
        },
      ],
    });
    const pin = pinCurrentLook()!;

    render(<LooksPanel />);
    expect(screen.getByRole('button', { name: 'Apply PIN 001' })).toHaveAttribute('type', 'button');
    const actions = screen.getByRole('button', { name: 'Actions for PIN 001' });
    fireEvent.click(actions);
    expect(actions).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText('Make Look'));

    expect(useProjectStore.getState().project.pinnedLooks[0]).toMatchObject({
      id: pin.id,
      label: 'LOOK 01',
      slot: 1,
    });
  });

  it('opens Explore around compatible Pin values without changing Current', () => {
    const project = createEmptyProject('Explore Pin');
    const original = {
      ...project,
      layers: [{
        ...project.layers[0]!,
        technique: { id: 'tech-explore-pin', techniqueId: 'mosaic', enabled: true, params: { scale: 0.7 } },
      }],
    };
    useProjectStore.getState().loadProject('', original);
    const pin = pinCurrentLook()!;
    vi.spyOn(engine, 'renderStill').mockReturnValue(new Uint8Array(220 * 220 * 4));

    exploreAroundPin(pin);

    expect(useUiStore.getState().workspace).toBe('explore');
    expect(useProjectStore.getState().project.layers[0]?.technique?.params).toEqual({ scale: 0.7 });
    expect(useExploreStore.getState().variations[0]?.patch.params).toEqual({ scale: 0.7 });
  });

  it('holds renderer-only Compare and cancels preview before applying an edit', () => {
    const project = createEmptyProject('Compare Pin');
    const original = {
      ...project,
      sources: [{ id: 'generator-pin', kind: 'generator' as const, generator: 'noise', params: {}, seed: 4 }],
      composition: { ...project.composition, sourceId: 'generator-pin' },
      layers: [{
        ...project.layers[0]!, sourceId: 'generator-pin',
        technique: { id: 'tech-compare-pin', techniqueId: 'mosaic', enabled: true, params: { scale: 0.7 } },
      }],
    };
    useProjectStore.getState().loadProject('', original);
    const pin = pinCurrentLook()!;
    useProjectStore.getState().apply((p) => ({
      ...p,
      layers: p.layers.map((layer) => layer.technique
        ? { ...layer, technique: { ...layer.technique, params: { scale: 0.2 } } }
        : layer),
    }));
    const current = useProjectStore.getState().project;
    const historyDepth = useProjectStore.getState().past.length;

    render(<LooksPanel />);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${pin.label}` }));
    const compare = screen.getByRole('button', { name: 'HOLD TO COMPARE' });
    fireEvent.pointerDown(compare);
    expect(useProjectStore.getState().previewProject?.layers[0]?.technique?.params).toEqual({ scale: 0.7 });
    expect(useProjectStore.getState().project).toBe(current);
    expect(useProjectStore.getState().past).toHaveLength(historyDepth);
    fireEvent.pointerUp(compare);
    expect(useProjectStore.getState().previewProject).toBeNull();

    fireEvent.pointerDown(compare);
    useProjectStore.getState().apply((p) => ({
      ...p,
      layers: p.layers.map((layer) => layer.technique
        ? { ...layer, technique: { ...layer.technique, params: { scale: 0.9 } } }
        : layer),
    }));
    expect(useProjectStore.getState().previewProject).toBeNull();
    expect(useProjectStore.getState().project.layers[0]?.technique?.params).toEqual({ scale: 0.9 });
  });

  it('exports Pin renderer state even when Current source is empty', async () => {
    const base = createEmptyProject('Empty Current');
    const current = {
      ...base,
      sources: [{ id: 'pin-source', kind: 'generator' as const, generator: 'noise', params: {}, seed: 8 }],
    };
    const snapshot = {
      ...current,
      composition: { ...current.composition, sourceId: 'pin-source' },
      layers: [{
        ...current.layers[0]!, sourceId: 'pin-source',
        technique: { id: 'tech-pin-export', techniqueId: 'mosaic', enabled: true, params: {} },
      }],
    };
    const pin = createPin(current, snapshot, null)!;
    useProjectStore.getState().loadProject('', { ...current, pinnedLooks: [pin] });
    const renderStill = vi.spyOn(engine, 'renderStill').mockReturnValue(new Uint8Array(1920 * 1080 * 4));
    renderStill.mockClear();

    await exportPngStill(pin.id);

    expect(renderStill).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().project.composition.sourceId).toBeNull();
    expect(useProjectStore.getState().previewProject).toBeNull();
  });
});
