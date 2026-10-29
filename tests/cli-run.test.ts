// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../electron/cli/validate';

/**
 * The CLI's main-process side: it waits for the hidden renderer's bridge, runs the job there, and
 * speaks JSON lines on stdout (progress, done, error, result) with an exit code a script can trust.
 */

const probe = vi.hoisted(() => vi.fn(async (_path: string) => ({})));
vi.mock('../electron/media/probe', () => ({ probeMedia: probe }));

const { runAnalyze, runRender } = await import('../electron/cli/run');

const render = {
  command: 'render' as const,
  project: '/shows/a.material',
  out: '/out/a.mov',
  codec: 'prores422hq' as const,
  audio: null,
  fps: 25,
  range: null,
  jsonProgress: true,
};

let stdout: string[];
let stderr: string[];
const events = () => stdout.map((l) => JSON.parse(l) as Record<string, unknown>);

/** A hidden window whose renderer answers the bridge calls from a script. */
function windowWith(answer: (code: string) => unknown) {
  const executeJavaScript = vi.fn(async (code: string) => answer(code));
  return { win: { webContents: { executeJavaScript } } as never, executeJavaScript };
}

beforeEach(() => {
  vi.useFakeTimers();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (stdout.push(String(s).trim()), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (stderr.push(String(s)), true));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  probe.mockClear();
});

describe('render', () => {
  it('waits for the bridge, reports each new frame once, then done', async () => {
    let ready = false;
    let frame = 0;
    let finish!: (v: unknown) => void;
    const { win, executeJavaScript } = windowWith((code) => {
      if (code.startsWith('typeof')) return ready;
      if (code.includes('.render(')) return new Promise((r) => (finish = r));
      if (code.includes('.status()')) return { phase: 'running', frame, totalFrames: 50 };
      return null;
    });

    const exit = runRender(win, render);
    await vi.advanceTimersByTimeAsync(250); // bridge not up yet
    ready = true;
    await vi.advanceTimersByTimeAsync(100);
    const job = executeJavaScript.mock.calls.find((c) => c[0].includes('.render('))![0];
    expect(JSON.parse(job.slice(job.indexOf('(') + 1, -1))).toEqual({
      project: '/shows/a.material',
      out: '/out/a.mov',
      codec: 'prores422hq',
      audio: null,
      fps: 25,
      range: null,
    });

    frame = 10;
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500); // same frame: not repeated
    frame = 20;
    await vi.advanceTimersByTimeAsync(500);
    finish({ out: '/out/a.mov', frames: 50 });
    await vi.advanceTimersByTimeAsync(500);

    expect(await exit).toBe(EXIT.ok);
    expect(events()).toEqual([
      { event: 'progress', frame: 10, totalFrames: 50 },
      { event: 'progress', frame: 20, totalFrames: 50 },
      { event: 'done', out: '/out/a.mov', frames: 50 },
    ]);
  });

  it('without --json-progress only the final line is printed', async () => {
    const { win } = windowWith((code) => (code.startsWith('typeof') ? true : code.includes('.render(') ? { out: '/o', frames: 1 } : { phase: 'running', frame: 1, totalFrames: 1 }));
    const exit = runRender(win, { ...render, jsonProgress: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await exit).toBe(EXIT.ok);
    expect(events()).toEqual([{ event: 'done', out: '/o', frames: 1 }]);
  });

  it('a failed render exits non-zero with the reason on stdout and stderr', async () => {
    const { win } = windowWith((code) => {
      if (code.startsWith('typeof')) return true;
      if (code.includes('.render(')) return Promise.reject(new Error('Invalid project:\n  bad layer'));
      return { phase: 'idle', frame: 0, totalFrames: 0 };
    });
    const exit = runRender(win, render);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await exit).toBe(EXIT.failed);
    expect(events()).toEqual([{ event: 'error', message: 'Invalid project:\n  bad layer' }]);
    expect(stderr.join('')).toContain('bad layer');
  });

  it('a replacement soundtrack is checked before anything renders', async () => {
    probe.mockRejectedValueOnce(new Error('not an audio file'));
    const { win, executeJavaScript } = windowWith(() => true);
    await expect(runRender(win, { ...render, audio: '/x.txt' })).rejects.toThrow('not an audio file');
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('gives up when the renderer never exposes the bridge', async () => {
    const { win } = windowWith(() => false);
    const exit = runRender(win, render);
    const settled = exit.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(((await settled) as Error).message).toBe('The renderer never exposed the CLI bridge');
  });
});

describe('analyze-audio', () => {
  it('prints one result line', async () => {
    const { win } = windowWith((code) => (code.startsWith('typeof') ? true : { bpm: 128, onsets: [0.5] }));
    const exit = runAnalyze(win, { command: 'analyze-audio', audio: '/m/song.wav', threshold: 0.4 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await exit).toBe(EXIT.ok);
    expect(probe).toHaveBeenCalledWith('/m/song.wav');
    expect(events()).toEqual([{ event: 'result', bpm: 128, onsets: [0.5] }]);
  });

  it('an unreadable file is an error line and a failing exit', async () => {
    probe.mockRejectedValueOnce(new Error('no such file'));
    const { win } = windowWith(() => true);
    expect(await runAnalyze(win, { command: 'analyze-audio', audio: '/nope.wav', threshold: null })).toBe(EXIT.failed);
    expect(events()).toEqual([{ event: 'error', message: 'no such file' }]);
  });
});
