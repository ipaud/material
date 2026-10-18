import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TakeStrip } from '@/performance/ui/TakeStrip';
import { useProjectStore } from '@/state/projectStore';
import { emptyLayer } from '@shared/schemas/project';

afterEach(cleanup);

beforeEach(() => {
  useProjectStore.getState().newProject();
  useProjectStore.getState().apply((p) => ({
    ...p,
    layers: [p.layers[0]!, { ...emptyLayer('l2', 'Grit'), opacity: 0.5 }],
  }));
});

const takes = () => useProjectStore.getState().project.takes;

describe('keyframe authoring in the Perform strip', () => {
  it('NEW KEYFRAMES makes a Take, + LANE adds a lane, interpolation and keys are editable', () => {
    render(<TakeStrip />);
    fireEvent.click(screen.getByRole('button', { name: /new keyframes/i }));
    expect(takes()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/add lane/i), { target: { value: 'layer:l2:opacity' } });
    expect(takes()[0]!.lanes.map((l) => l.target)).toEqual(['layer:l2:opacity']);

    fireEvent.change(screen.getByLabelText(/interpolation/i), { target: { value: 'smooth' } });
    expect(takes()[0]!.lanes[0]!.interp).toBe('smooth');

    const lane = [...document.querySelectorAll('.perf-take-lane')].at(-1) as HTMLElement;
    Object.defineProperty(lane, 'clientWidth', { value: 100, configurable: true });
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.doubleClick(lane, { clientX: 50, clientY: 20 });
    expect(takes()[0]!.lanes[0]!.samples).toHaveLength(3);
  });

  it('Alt-click on a key deletes it', () => {
    render(<TakeStrip />);
    fireEvent.click(screen.getByRole('button', { name: /new keyframes/i }));
    fireEvent.change(screen.getByLabelText(/add lane/i), { target: { value: 'layer:l2:opacity' } });
    const keys = document.querySelectorAll('.perf-take-point');
    expect(keys).toHaveLength(2);
    fireEvent.pointerDown(keys[0]!, { altKey: true, pointerId: 1 });
    expect(takes()[0]!.lanes[0]!.samples).toHaveLength(1);
  });
});
