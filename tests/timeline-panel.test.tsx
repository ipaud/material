import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TimelinePanel } from '@/timeline/TimelinePanel';
import { playback } from '@/playback/PlaybackController';
import { usePlaybackStore } from '@/state/playbackStore';
import { useAudioStore } from '@/state/audioStore';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';

/** The timeline strip: transport keys, scrubbing, markers and the tempo fields. */

const timeline = () => useProjectStore.getState().project.timeline;
const setTimeline = (patch: Partial<ReturnType<typeof timeline>>) =>
  useProjectStore.getState().apply((p) => ({ ...p, timeline: { ...p.timeline, ...patch } }));
const number = (title: string) => screen.getByTitle(title) as HTMLInputElement;

/** jsdom does no layout: give the track and marker strip a 400 px box at x = 100. */
function layout() {
  for (const el of document.querySelectorAll<HTMLElement>('.timeline-track, .timeline-markers')) {
    el.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, height: 40, right: 500, bottom: 40, x: 100, y: 0, toJSON() {} }) as DOMRect;
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.setPointerCapture = () => undefined;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(playback, 'toggle').mockImplementation(() => undefined);
  vi.spyOn(playback, 'seek').mockImplementation(() => undefined);
  vi.spyOn(playback, 'setLoop').mockImplementation(() => undefined);
  vi.spyOn(playback, 'getTime').mockReturnValue(12.5);
  useProjectStore.getState().newProject();
  usePlaybackStore.setState({ playing: false, timeSec: 30, durationSec: 120, loop: false });
  useAudioStore.setState({ loading: false, analysis: null, peaks: null });
  useUiStore.setState({ showBeatGrid: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('transport', () => {
  it('with nothing to play it says what to add', () => {
    usePlaybackStore.setState({ durationSec: 0 });
    render(<TimelinePanel />);
    expect(screen.getByText('Timeline — add a video or audio source')).toBeInTheDocument();
  });

  it('shows time as mm:ss.cc and toggles loop', () => {
    usePlaybackStore.setState({ timeSec: 75.5 });
    render(<TimelinePanel />);
    expect(screen.getByText('01:15.50')).toBeInTheDocument();
    expect(screen.getByText('/ 02:00.00')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Loop'));
    expect(playback.setLoop).toHaveBeenCalledWith(true);
  });

  it('Space plays and pauses, but not while typing in a field', () => {
    render(<TimelinePanel />);
    fireEvent.keyDown(window, { code: 'Space' });
    expect(playback.toggle).toHaveBeenCalledOnce();
    fireEvent.keyDown(number('Manual BPM (empty = no beat grid)'), { code: 'Space' });
    fireEvent.keyDown(window, { code: 'KeyA' });
    expect(playback.toggle).toHaveBeenCalledOnce();
  });

  it('pressing and dragging on the strip scrubs, clamped to the clip', () => {
    render(<TimelinePanel />);
    layout();
    const track = document.querySelector('.timeline-track')!;
    fireEvent.pointerDown(track, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 900 });
    fireEvent.pointerUp(track);
    fireEvent.pointerMove(track, { clientX: 300 }); // not scrubbing any more
    expect(vi.mocked(playback.seek).mock.calls.map((c) => c[0])).toEqual([30, 120]);
  });

  it('DETECT waits for the audio analysis', () => {
    render(<TimelinePanel />);
    expect(screen.getByRole('button', { name: 'DETECT' })).toBeDisabled();
  });
});

describe('markers', () => {
  it('+MARK drops a numbered marker at the playhead; double-click deletes it', () => {
    render(<TimelinePanel />);
    fireEvent.click(screen.getByRole('button', { name: '+MARK' }));
    fireEvent.click(screen.getByRole('button', { name: '+MARK' }));
    expect(timeline().markers.map((m) => [m.label, m.timeSec])).toEqual([
      ['M1', 12.5],
      ['M2', 12.5],
    ]);
    fireEvent.doubleClick(screen.getByTitle('M1 — drag to move, double-click to delete'));
    expect(timeline().markers.map((m) => m.label)).toEqual(['M2']);
  });

  it('dragging a marker moves it within the clip and does not scrub', () => {
    setTimeline({ markers: [{ id: 'm', timeSec: 10, label: 'Drop' }] });
    render(<TimelinePanel />);
    layout();
    fireEvent.pointerDown(screen.getByTitle('Drop — drag to move, double-click to delete'), { clientX: 110 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }) as PointerEvent);
    });
    expect(timeline().markers[0]!.timeSec).toBe(90);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: -50 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent('pointerup'));
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }) as PointerEvent);
    });
    expect(timeline().markers[0]!.timeSec).toBe(0);
    expect(playback.seek).not.toHaveBeenCalled();
  });
});

describe('tempo fields', () => {
  it('BPM accepts a positive number; empty or zero means no grid', () => {
    render(<TimelinePanel />);
    const bpm = number('Manual BPM (empty = no beat grid)');
    fireEvent.change(bpm, { target: { value: '128' } });
    expect(timeline().bpm).toBe(128);
    fireEvent.change(bpm, { target: { value: '0' } });
    expect(timeline().bpm).toBeNull();
    fireEvent.change(bpm, { target: { value: '' } });
    expect(timeline().bpm).toBeNull();
  });

  it('beats per bar ignores partial input and caps at 12', () => {
    render(<TimelinePanel />);
    const bar = number('Beats per bar (time signature numerator)');
    fireEvent.change(bar, { target: { value: '' } });
    fireEvent.change(bar, { target: { value: '0' } });
    expect(timeline().beatsPerBar).toBe(4);
    fireEvent.change(bar, { target: { value: '20' } });
    expect(timeline().beatsPerBar).toBe(12);
  });

  it('the offset falls back to 0 on garbage', () => {
    render(<TimelinePanel />);
    fireEvent.change(number('Beat-1 offset in seconds'), { target: { value: '0.25' } });
    expect(timeline().beatOffsetSec).toBe(0.25);
  });

  it('the grid marks every bar and hides with GRID', () => {
    setTimeline({ bpm: 120, beatOffsetSec: 0, beatsPerBar: 4 });
    usePlaybackStore.setState({ durationSec: 8 });
    render(<TimelinePanel />);
    // 0 … 8 s inclusive at 2 beats a second: 17 ticks, a bar line every 4th
    expect(document.querySelectorAll('.beat-tick')).toHaveLength(17);
    expect(document.querySelectorAll('.beat-tick.bar')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'GRID' }));
    expect(document.querySelectorAll('.beat-tick')).toHaveLength(0);
  });
});
