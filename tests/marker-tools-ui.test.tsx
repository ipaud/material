import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRACK_IDS, type AudioAnalysis } from '@/audio/analysis';
import { MarkerTools } from '@/timeline/MarkerTools';
import { useAudioStore } from '@/state/audioStore';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';

afterEach(cleanup);

function analysis(): AudioAnalysis {
  const tracks = Object.fromEntries(TRACK_IDS.map((id) => [id, new Float32Array(500)])) as AudioAnalysis['tracks'];
  tracks.onset[100] = 0.9;
  tracks.onset[200] = 0.4;
  return { sampleRate: 44100, hopSec: 0.01, frameCount: 500, durationSec: 5, tracks };
}

beforeEach(() => {
  useProjectStore.getState().newProject();
  useAudioStore.setState({ analysis: analysis() });
  useUiStore.setState({ toasts: [] });
});

const markers = () => useProjectStore.getState().project.timeline.markers;
const lastToast = () => useUiStore.getState().toasts.at(-1)?.message ?? '';

describe('MarkerTools', () => {
  it('imports a CSV file into the timeline and says how many', async () => {
    render(<MarkerTools />);
    const input = screen.getByLabelText(/import markers file/i) as HTMLInputElement;
    const file = new File(['1,Kick,drums\n2,Snare,drums'], 'm.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(markers()).toHaveLength(2));
    expect(lastToast()).toMatch(/2 markers/i);
  });

  it('a file with no markers is an error toast, not silence', async () => {
    render(<MarkerTools />);
    const input = screen.getByLabelText(/import markers file/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['hello'], 'x.txt')] } });
    await waitFor(() => expect(lastToast()).toMatch(/no markers/i));
    expect(markers()).toHaveLength(0);
  });

  it('turns onsets above the chosen threshold into markers, and snaps them', () => {
    render(<MarkerTools />);
    fireEvent.change(screen.getByLabelText(/onset threshold/i), { target: { value: '0.6' } });
    fireEvent.click(screen.getByRole('button', { name: /onsets → markers/i }));
    expect(markers().map((m) => Math.round(m.timeSec))).toEqual([1]);
    fireEvent.click(screen.getByRole('button', { name: /snap to onsets/i }));
    expect(lastToast()).toMatch(/snap/i);
  });
});
