import { describe, expect, it } from 'vitest';
import { parseCli } from '../electron/cli/args';

describe.skipIf(process.platform === 'win32')('parseCli (POSIX paths)', () => {
  it('returns null when no CLI command is present (normal GUI launch)', () => {
    expect(parseCli([])).toBeNull();
    expect(parseCli(['/Users/me/p.material'])).toBeNull();
  });

  it('parses render with defaults', () => {
    expect(parseCli(['render', '/p/a.material', '--out', '/o/a.mov'])).toEqual({
      command: 'render',
      project: '/p/a.material',
      out: '/o/a.mov',
      codec: 'prores422hq',
      audio: null,
      fps: null,
      range: null,
      jsonProgress: false,
    });
  });

  it('parses every render option', () => {
    const r = parseCli([
      'render', '/p/a.material', '--out', '/o/a.mp4', '--codec', 'h264',
      '--fps', '25', '--range', '10.5:20', '--json-progress',
    ]);
    expect(r).toMatchObject({ codec: 'h264', fps: 25, range: [10.5, 20], jsonProgress: true });
  });

  it('accepts the prores alias and an audio override', () => {
    const r = parseCli(['render', '/p/a.material', '--out', '/o.mov', '--codec', 'prores', '--audio', 'x.wav'], '/w');
    expect(r).toMatchObject({ codec: 'prores422hq', audio: '/w/x.wav' });
  });

  it('accepts --opt=value form', () => {
    const r = parseCli(['render', '/p/a.material', '--out=/o/a.mov', '--fps=24']);
    expect(r).toMatchObject({ out: '/o/a.mov', fps: 24 });
  });

  it.each([
    [['render'], /project/i],
    [['render', '/p/a.material'], /--out/],
    [['render', '/p/a.material', '--out', '/o.mov', '--codec', 'gif'], /codec/i],
    [['render', '/p/a.material', '--out', '/o.mov', '--fps', 'x'], /fps/i],
    [['render', '/p/a.material', '--out', '/o.mov', '--range', '5'], /range/i],
    [['render', '/p/a.material', '--out', '/o.mov', '--range', '9:3'], /range/i],
    [['render', '/p/a.material', '--out', '/o.mov', '--bogus'], /unknown/i],
  ])('rejects bad input %j', (argv, message) => {
    const r = parseCli(argv as string[]);
    expect(r).toMatchObject({ command: 'error' });
    expect((r as { message: string }).message).toMatch(message);
  });

  it('resolves relative paths against the working directory', () => {
    expect(parseCli(['render', 'p/a.material', '--out', 'o/a.mov'], '/work')).toMatchObject({
      project: '/work/p/a.material',
      out: '/work/o/a.mov',
    });
    expect(parseCli(['validate', '../x.material'], '/work/sub')).toEqual({
      command: 'validate',
      project: '/work/x.material',
    });
  });

  it('parses validate and analyze-audio', () => {
    expect(parseCli(['validate', '/p/a.material'])).toEqual({
      command: 'validate',
      project: '/p/a.material',
    });
    expect(parseCli(['analyze-audio', '/a/x.wav', '--json'])).toEqual({
      command: 'analyze-audio',
      audio: '/a/x.wav',
      threshold: null,
    });
    expect(parseCli(['analyze-audio', '/a/x.wav', '--threshold', '0.6'])).toMatchObject({ threshold: 0.6 });
    expect(parseCli(['analyze-audio', '/a/x.wav', '--threshold', '2'])).toMatchObject({ command: 'error' });
  });
});

describe.runIf(process.platform === 'win32')('parseCli (Windows paths)', () => {
  it('keeps absolute Windows paths and resolves relative ones against the working directory', () => {
    const r = parseCli(
      ['render', 'C:\\p\\a.material', '--out', 'D:\\o\\a.mov', '--audio', 'x.wav'],
      'C:\\work',
    );
    expect(r).toMatchObject({
      command: 'render',
      project: 'C:\\p\\a.material',
      out: 'D:\\o\\a.mov',
      audio: 'C:\\work\\x.wav',
    });
  });
  it('parses validate and analyze-audio', () => {
    expect(parseCli(['validate', 'C:\\p\\a.material'])).toEqual({ command: 'validate', project: 'C:\\p\\a.material' });
  });
});
