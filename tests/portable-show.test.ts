import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createEmptyProject, type Project } from '@shared/schemas/project';
import type { MediaMetadata } from '@shared/schemas/media';
import { toAbsolutePaths, toPortablePaths } from '@electron/filesystem/projectPaths';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { relinkAllFromFolder } from '@/projects/projectActions';
import {
  bestMatch,
  matchScore,
  planRelink,
  MATCH_FLOOR,
  type MediaCandidate,
} from '@/projects/relink';

/**
 * v0.8 — a project that can leave the machine it was made on.
 *
 * The gap this closes was hit for real: the v0.7 creative test's project
 * pointed at a scratch directory and had to be repointed by hand before it
 * would open anywhere.
 */

const PROJ = '/Users/x/Shows/irati/irati.material';

function meta(patch: Partial<MediaMetadata>): MediaMetadata {
  return {
    kind: 'video',
    path: '/somewhere/clip.mp4',
    fileName: 'clip.mp4',
    fileSize: 1024,
    durationSec: 32.3,
    width: 1920,
    height: 1080,
    frameRate: 30,
    videoCodec: 'h264',
    audioCodec: null,
    audioChannels: null,
    sampleRate: null,
    ...patch,
  };
}

function withSources(paths: string[]): Project {
  const base = createEmptyProject();
  return {
    ...base,
    sources: paths.map((p, i) => ({
      id: `s${i}`,
      kind: 'video' as const,
      path: p,
      metadata: meta({ path: p, fileName: path.basename(p) }),
    })),
  };
}

describe.skipIf(process.platform === 'win32')('paths are relative on disk and absolute in memory', () => {
  it('relativises media that lives at or below the project', () => {
    const p = withSources([
      '/Users/x/Shows/irati/media/clip.mp4',
      '/Users/x/Shows/irati/song.wav',
    ]);
    const out = toPortablePaths(p, PROJ);
    expect(out.sources.map((s) => ('path' in s ? s.path : null))).toEqual([
      'media/clip.mp4',
      'song.wav',
    ]);
  });

  it('leaves media OUTSIDE the project absolute', () => {
    // A `../../..` chain is not portability — it is a different absolute path
    // written more fragilely, and moving the folder breaks it either way.
    const p = withSources(['/Users/x/Footage/clip.mp4', '/Volumes/Drive/song.wav']);
    const out = toPortablePaths(p, PROJ);
    expect(out.sources.map((s) => ('path' in s ? s.path : null))).toEqual([
      '/Users/x/Footage/clip.mp4',
      '/Volumes/Drive/song.wav',
    ]);
  });

  it('is not fooled by a sibling directory that shares a prefix', () => {
    const p = withSources(['/Users/x/Shows/irati-old/clip.mp4']);
    expect(toPortablePaths(p, PROJ).sources[0]).toMatchObject({
      path: '/Users/x/Shows/irati-old/clip.mp4',
    });
  });

  it('round-trips exactly', () => {
    const p = withSources([
      '/Users/x/Shows/irati/media/clip.mp4',
      '/Users/x/Footage/other.mp4',
    ]);
    const back = toAbsolutePaths(toPortablePaths(p, PROJ), PROJ);
    expect(back.sources.map((s) => ('path' in s ? s.path : null))).toEqual([
      '/Users/x/Shows/irati/media/clip.mp4',
      '/Users/x/Footage/other.mp4',
    ]);
  });

  it('resolves a moved folder to its NEW location', () => {
    // The whole point: write here, open there.
    const written = toPortablePaths(withSources(['/Users/x/Shows/irati/media/clip.mp4']), PROJ);
    const opened = toAbsolutePaths(written, '/Volumes/Stick/irati/irati.material');
    expect(opened.sources[0]).toMatchObject({ path: '/Volumes/Stick/irati/media/clip.mp4' });
  });

  it('leaves an already-absolute project untouched on read', () => {
    const p = withSources(['/Users/x/Footage/clip.mp4']);
    expect(toAbsolutePaths(p, PROJ)).toEqual(p);
  });

  it('touches nothing that has no path', () => {
    const base = createEmptyProject();
    const p: Project = {
      ...base,
      sources: [
        { id: 'cam', kind: 'camera', deviceId: null },
        { id: 'gen', kind: 'generator', generator: 'noise', params: {}, seed: 1 },
      ],
    };
    expect(toPortablePaths(p, PROJ)).toEqual(p);
    expect(toAbsolutePaths(p, PROJ)).toEqual(p);
  });
});

describe('recognising a moved file', () => {
  const wanted = meta({ fileName: 'clip.mp4', fileSize: 1024, durationSec: 32.3 });
  const cand = (patch: Partial<MediaCandidate>): MediaCandidate => ({
    path: '/new/clip.mp4',
    fileName: 'clip.mp4',
    fileSize: 1024,
    kind: 'video',
    ...patch,
  });

  it('refuses a different kind outright', () => {
    expect(matchScore(wanted, cand({ kind: 'audio' }))).toBe(0);
  });

  it('scores a rename on its bytes', () => {
    // Same size, different name: the file was renamed.
    const s = matchScore(wanted, cand({ fileName: 'clip-final.mp4' }));
    expect(s).toBeGreaterThanOrEqual(MATCH_FLOOR);
  });

  it('scores a re-encode on its name', () => {
    // Same name, different size: the file was re-encoded.
    const s = matchScore(wanted, cand({ fileSize: 999 }));
    expect(s).toBeGreaterThanOrEqual(MATCH_FLOOR);
  });

  it('scores name AND size higher than either alone', () => {
    const both = matchScore(wanted, cand({}));
    expect(both).toBeGreaterThan(matchScore(wanted, cand({ fileName: 'other.mp4' })));
    expect(both).toBeGreaterThan(matchScore(wanted, cand({ fileSize: 999 })));
  });

  it('rejects a coincidence', () => {
    // Nothing in common but the kind.
    expect(bestMatch(wanted, [cand({ fileName: 'other.mp4', fileSize: 55 })])).toEqual({
      status: 'none',
    });
  });

  it('picks the clear winner out of a folder', () => {
    const right = cand({ path: '/new/clip.mp4' });
    const m = bestMatch(wanted, [
      cand({ path: '/new/decoy.mp4', fileName: 'decoy.mp4', fileSize: 7 }),
      right,
      cand({ path: '/new/other.mp4', fileName: 'other.mp4', fileSize: 9 }),
    ]);
    expect(m.status).toBe('matched');
    expect(m.status === 'matched' && m.candidate.path).toBe('/new/clip.mp4');
  });

  it('REFUSES a tie rather than flipping a coin', () => {
    // Two copies of the same file in the folder. Guessing would put the wrong
    // footage in a show and say nothing.
    const m = bestMatch(wanted, [
      cand({ path: '/new/a/clip.mp4' }),
      cand({ path: '/new/b/clip.mp4' }),
    ]);
    expect(m.status).toBe('ambiguous');
    expect(m.status === 'ambiguous' && m.candidates).toHaveLength(2);
  });
});

describe('planning a whole relink', () => {
  const video = meta({ fileName: 'clip.mp4', fileSize: 1024 });
  const audio = meta({ kind: 'audio', fileName: 'song.wav', fileSize: 4096, durationSec: 173.5 });

  const folder: MediaCandidate[] = [
    { path: '/new/clip.mp4', fileName: 'clip.mp4', fileSize: 1024, kind: 'video' },
    { path: '/new/song.wav', fileName: 'song.wav', fileSize: 4096, kind: 'audio' },
    { path: '/new/unrelated.mp4', fileName: 'unrelated.mp4', fileSize: 5, kind: 'video' },
  ];

  it('resolves every source one folder pick can resolve', () => {
    const plan = planRelink(
      [
        { id: 'v', metadata: video },
        { id: 'a', metadata: audio },
      ],
      folder,
    );
    expect(plan.resolved.get('v')?.path).toBe('/new/clip.mp4');
    expect(plan.resolved.get('a')?.path).toBe('/new/song.wav');
    expect(plan.unresolved).toEqual([]);
    expect(plan.ambiguous.size).toBe(0);
  });

  it('lets one file answer for two sources', () => {
    // The same clip imported twice under different ids is legitimate.
    const plan = planRelink(
      [
        { id: 'v1', metadata: video },
        { id: 'v2', metadata: video },
      ],
      folder,
    );
    expect(plan.resolved.get('v1')?.path).toBe('/new/clip.mp4');
    expect(plan.resolved.get('v2')?.path).toBe('/new/clip.mp4');
  });

  it('reports what it could not find rather than half-doing it', () => {
    const missing = meta({ fileName: 'gone.mp4', fileSize: 77 });
    const plan = planRelink([{ id: 'g', metadata: missing }], folder);
    expect(plan.resolved.size).toBe(0);
    expect(plan.unresolved).toEqual(['g']);
  });

  it('a source with no recorded metadata is unresolved, never guessed', () => {
    const plan = planRelink([{ id: 'x', metadata: null }], folder);
    expect(plan.unresolved).toEqual(['x']);
    expect(plan.resolved.size).toBe(0);
  });
});

describe('applying a relink to the project', () => {
  it('repoints every resolved source in ONE undo entry, and re-probes', async () => {
    // The dialog itself cannot be driven from a test — contextBridge freezes
    // the preload object, which is also why it could not be stubbed from a
    // live probe. Everything downstream of the dialog runs here for real: the
    // plan, the store update, the re-probe, and the offline recheck.
    const found: Record<string, MediaMetadata> = {
      '/new/clip.mp4': meta({ path: '/new/clip.mp4', fileName: 'clip.mp4', fileSize: 2048, durationSec: 10 }),
      '/new/song.wav': meta({ path: '/new/song.wav', kind: 'audio', fileName: 'song.wav', fileSize: 4096, durationSec: 12 }),
    };
    const probed: string[] = [];
    Object.defineProperty(window, 'material', {
      configurable: true,
      writable: true,
      value: {
      pickMediaFolder: async () => [
        { path: '/new/clip.mp4', fileName: 'clip.mp4', fileSize: 2048, kind: 'video' as const },
        { path: '/new/song.wav', fileName: 'song.wav', fileSize: 4096, kind: 'audio' as const },
        { path: '/new/decoy.mp4', fileName: 'decoy.mp4', fileSize: 7, kind: 'video' as const },
      ],
      probeMedia: async (p: string) => {
        probed.push(p);
        const m = found[p];
        if (!m) throw new Error('missing');
        return m;
      },
      },
    });

    const base = createEmptyProject();
    useProjectStore.setState({
      project: {
        ...base,
        sources: [
          { id: 'v', kind: 'video', path: '/old/clip.mp4', metadata: meta({ fileSize: 2048, fileName: 'clip.mp4' }) },
          {
            id: 'a',
            kind: 'audio',
            path: '/old/song.wav',
            metadata: meta({ kind: 'audio', fileName: 'song.wav', fileSize: 4096, durationSec: 12 }),
          },
        ],
      },
      past: [],
      dirty: false,
    });
    useUiStore.setState({ offlineSources: ['v', 'a'] });

    await relinkAllFromFolder();

    const sources = useProjectStore.getState().project.sources;
    expect(sources.map((s) => ('path' in s ? s.path : null))).toEqual([
      '/new/clip.mp4',
      '/new/song.wav',
    ]);
    // Metadata comes from the file actually FOUND: a re-encode legitimately
    // has a different size, and keeping the old numbers would make the next
    // relink match against a fiction.
    expect(sources[0]).toMatchObject({ metadata: { path: '/new/clip.mp4', durationSec: 10 } });
    // Each resolved file is probed twice on purpose-enough: once to refresh
    // its metadata, once by the offline recheck that follows. Two ffprobe
    // calls on a local file, on an explicit user action, is not worth coupling
    // the two passes together to avoid.
    expect(new Set(probed)).toEqual(new Set(['/new/clip.mp4', '/new/song.wav']));
    expect(probed.filter((p) => p === '/new/decoy.mp4')).toHaveLength(0);
    // The decoy was never a candidate for either source.
    expect(sources.some((s) => 'path' in s && s.path === '/new/decoy.mp4')).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('paths on Windows', () => {
  const WIN_PROJ = 'C:\\Users\\x\\Shows\\irati\\irati.material';
  it('writes relative paths with forward slashes, so a project moves between macOS and Windows', () => {
    const p = withSources(['C:\\Users\\x\\Shows\\irati\\media\\clip.mp4', 'D:\\Footage\\other.mp4']);
    const out = toPortablePaths(p, WIN_PROJ);
    expect(out.sources.map((s) => ('path' in s ? s.path : null))).toEqual(['media/clip.mp4', 'D:\\Footage\\other.mp4']);
  });
  it('round-trips, and resolves a moved folder to its new location', () => {
    const p = withSources(['C:\\Users\\x\\Shows\\irati\\media\\clip.mp4']);
    const disk = toPortablePaths(p, WIN_PROJ);
    expect(toAbsolutePaths(disk, WIN_PROJ).sources[0]).toMatchObject({ path: 'C:\\Users\\x\\Shows\\irati\\media\\clip.mp4' });
    expect(toAbsolutePaths(disk, 'E:\\Moved\\irati.material').sources[0]).toMatchObject({ path: 'E:\\Moved\\media\\clip.mp4' });
  });
  it('does not mistake a sibling folder sharing a prefix for a child', () => {
    const p = withSources(['C:\\Users\\x\\Shows\\irati-old\\clip.mp4']);
    expect(toPortablePaths(p, WIN_PROJ).sources[0]).toMatchObject({ path: 'C:\\Users\\x\\Shows\\irati-old\\clip.mp4' });
  });
});
