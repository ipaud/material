import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectMediaBeside, scanFolderForMedia } from '@electron/filesystem/mediaFolder';
import { planRelink } from '@/projects/relink';
import type { MediaMetadata } from '@shared/schemas/media';

/**
 * v0.8 — the filesystem half of a show that travels, against a real disk.
 *
 * The matcher is covered purely in `portable-show.test.ts`; this covers the
 * parts that only fail when there is an actual directory: bounded walks,
 * name collisions, and a collect that has to survive an offline file.
 */

let root = '';
const write = async (rel: string, bytes: number) => {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 7));
  return full;
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'material-v08-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scanning a folder the user pointed at', () => {
  it('finds media, ignores everything else, and reports real sizes', async () => {
    await write('scan/clip.mp4', 1024);
    await write('scan/song.wav', 2048);
    await write('scan/notes.txt', 10);
    await write('scan/.hidden.mp4', 10);
    const found = await scanFolderForMedia(path.join(root, 'scan'));
    expect(found.map((f) => f.fileName).sort()).toEqual(['clip.mp4', 'song.wav']);
    expect(found.find((f) => f.fileName === 'clip.mp4')).toMatchObject({
      fileSize: 1024,
      kind: 'video',
    });
    expect(found.find((f) => f.fileName === 'song.wav')?.kind).toBe('audio');
  });

  it('descends into a media/ layout but not forever', async () => {
    await write('deep/a/b/near.mp4', 8);
    await write('deep/a/b/c/d/far.mp4', 8);
    const found = await scanFolderForMedia(path.join(root, 'deep'));
    expect(found.map((f) => f.fileName)).toContain('near.mp4');
    expect(found.map((f) => f.fileName)).not.toContain('far.mp4');
  });

  it('an unreadable subtree is empty, not fatal', async () => {
    const dir = await write('locked/inner/x.mp4', 4);
    await fs.chmod(path.dirname(dir), 0o000);
    await expect(scanFolderForMedia(path.join(root, 'locked'))).resolves.toBeInstanceOf(Array);
    await fs.chmod(path.dirname(dir), 0o755);
  });

  it('refuses a relative root', async () => {
    await expect(scanFolderForMedia('some/where')).rejects.toThrow(/absolute/i);
  });
});

describe('scan feeds the relink plan', () => {
  it('a moved folder resolves both sources in one pick', async () => {
    await write('moved/clip.mp4', 1024);
    await write('moved/song.wav', 2048);
    const candidates = await scanFolderForMedia(path.join(root, 'moved'));
    const meta = (patch: Partial<MediaMetadata>): MediaMetadata => ({
      kind: 'video',
      path: '/old/clip.mp4',
      fileName: 'clip.mp4',
      fileSize: 1024,
      durationSec: null,
      width: null,
      height: null,
      frameRate: null,
      videoCodec: null,
      audioCodec: null,
      audioChannels: null,
      sampleRate: null,
      ...patch,
    });
    const plan = planRelink(
      [
        { id: 'v', metadata: meta({}) },
        { id: 'a', metadata: meta({ kind: 'audio', fileName: 'song.wav', fileSize: 2048 }) },
      ],
      candidates,
    );
    expect(plan.unresolved).toEqual([]);
    expect(plan.resolved.get('v')?.fileName).toBe('clip.mp4');
    expect(plan.resolved.get('a')?.fileName).toBe('song.wav');
  });
});

describe('collecting media beside the project', () => {
  it('copies outside media in and leaves inside media alone', async () => {
    const outside = await write('elsewhere/far.mp4', 512);
    const inside = await write('proj/already/here.mp4', 256);
    const projectPath = path.join(root, 'proj', 'show.material');
    const result = await collectMediaBeside(projectPath, [outside, inside]);
    expect(result.moved[outside]).toBe(path.join(root, 'proj', 'media', 'far.mp4'));
    expect(result.moved[inside]).toBeUndefined(); // already travels
    expect(result.bytesCopied).toBe(512);
    expect(result.missing).toEqual([]);
    await expect(fs.stat(result.moved[outside] as string)).resolves.toBeTruthy();
  });

  it('gives two different files with one name separate copies', async () => {
    const a = await write('collide/a/take.mp4', 100);
    const b = await write('collide/b/take.mp4', 200);
    const projectPath = path.join(root, 'collide-proj', 'show.material');
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    const result = await collectMediaBeside(projectPath, [a, b]);
    const targets = Object.values(result.moved);
    expect(new Set(targets).size).toBe(2);
    expect(targets.map((t) => path.basename(t)).sort()).toEqual(['take-1.mp4', 'take.mp4']);
    expect((await fs.stat(targets[0] as string)).size).toBe(100);
    expect((await fs.stat(targets[1] as string)).size).toBe(200);
  });

  it('re-collecting the same show copies nothing twice', async () => {
    const src = await write('again/clip.mp4', 300);
    const projectPath = path.join(root, 'again-proj', 'show.material');
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    const first = await collectMediaBeside(projectPath, [src]);
    expect(first.bytesCopied).toBe(300);
    const second = await collectMediaBeside(projectPath, [src]);
    expect(second.bytesCopied).toBe(0);
    expect(second.moved[src]).toBe(first.moved[src]);
  });

  it('collects what it can and REPORTS what is offline', async () => {
    // The first version threw on the first missing file and aborted, leaving
    // an empty media/ behind — the least useful outcome available. Found by
    // collecting a real project whose video had been deleted.
    const present = await write('partial/there.mp4', 64);
    const gone = path.join(root, 'partial', 'gone.mp4');
    const projectPath = path.join(root, 'partial-proj', 'show.material');
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    const result = await collectMediaBeside(projectPath, [present, gone]);
    expect(Object.keys(result.moved)).toEqual([present]);
    expect(result.missing).toEqual([gone]);
  });

  it('leaves no empty media/ behind when nothing could be collected', async () => {
    const projectPath = path.join(root, 'nothing-proj', 'show.material');
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    const result = await collectMediaBeside(projectPath, [path.join(root, 'nope.mp4')]);
    expect(result.moved).toEqual({});
    expect(result.missing).toHaveLength(1);
    await expect(fs.stat(path.join(root, 'nothing-proj', 'media'))).rejects.toThrow();
  });
});
