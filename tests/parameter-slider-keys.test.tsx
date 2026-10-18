import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ParameterSlider } from '@/components/ParameterSlider';

afterEach(cleanup);

function setup(value = 0.5) {
  const seen: number[] = [];
  const starts: string[] = [];
  const view = render(
    <ParameterSlider
      label="Scale"
      value={value}
      min={0}
      max={1}
      step={0.01}
      defaultValue={0.25}
      onChange={(v) => seen.push(v)}
      onDragStart={() => starts.push('s')}
      onDragEnd={() => starts.push('e')}
    />,
  );
  const slider = view.getByRole('slider');
  return { seen, starts, slider, ...view };
}

describe('ParameterSlider precise input', () => {
  it('is a focusable slider that exposes its value', () => {
    const { slider } = setup(0.5);
    expect(slider).toHaveAttribute('tabindex', '0');
    expect(slider).toHaveAttribute('aria-valuenow', '0.5');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '1');
  });

  it('arrows move by one step, shift by a tenth of it, alt by ten', () => {
    const { slider, seen } = setup(0.5);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(seen.at(-1)).toBeCloseTo(0.51, 6);
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(seen.at(-1)).toBeCloseTo(0.51, 6);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(seen.at(-1)).toBeCloseTo(0.49, 6);
    fireEvent.keyDown(slider, { key: 'ArrowDown', altKey: true });
    expect(seen.at(-1)).toBeCloseTo(0.4, 6);
  });

  it('shift+arrow is fine: a tenth of a step lands on a finer grid than the step', () => {
    const { slider, seen } = setup(0.5);
    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true });
    expect(seen.at(-1)).toBeCloseTo(0.501, 6);
  });

  it('clamps at the ends and Home/End jump to them', () => {
    const { slider, seen } = setup(1);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(seen.at(-1)).toBe(1);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(seen.at(-1)).toBe(0);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(seen.at(-1)).toBe(1);
  });

  it('Backspace/Delete resets to the default', () => {
    const { slider, seen } = setup(0.9);
    fireEvent.keyDown(slider, { key: 'Backspace' });
    expect(seen.at(-1)).toBe(0.25);
  });

  it('each key press is its own undo gesture', () => {
    const { slider, starts } = setup(0.5);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(starts).toEqual(['s', 'e']);
  });

  it('wheel adjusts only while the slider is focused', () => {
    const { slider, seen } = setup(0.5);
    fireEvent.wheel(slider, { deltaY: -100 });
    expect(seen).toHaveLength(0);
    slider.focus();
    fireEvent.wheel(slider, { deltaY: -100 });
    expect(seen.at(-1)).toBeCloseTo(0.51, 6);
    fireEvent.wheel(slider, { deltaY: 100 });
    expect(seen.at(-1)).toBeCloseTo(0.49, 6);
  });

  it('pastes a number, ignores text, and copies the current value', () => {
    const { slider, seen } = setup(0.5);
    const copied: string[] = [];
    fireEvent.paste(slider, { clipboardData: { getData: () => '0.8' } });
    expect(seen.at(-1)).toBe(0.8);
    fireEvent.paste(slider, { clipboardData: { getData: () => 'hello' } });
    expect(seen.at(-1)).toBe(0.8);
    fireEvent.copy(slider, {
      clipboardData: { setData: (_t: string, v: string) => copied.push(v) },
    });
    expect(copied).toEqual(['0.50']);
  });

  it('typing in the value field does not trigger slider shortcuts', () => {
    const { container, seen, getByText } = setup(0.5);
    fireEvent.click(getByText('0.50'));
    const input = container.querySelector('.param-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(seen).toHaveLength(0);
  });
});

describe('ParameterSlider readout', () => {
  it('shows a fine value that falls between grid points', () => {
    const { getByText } = setup(0.501);
    expect(getByText('0.501')).toBeInTheDocument();
  });
});
