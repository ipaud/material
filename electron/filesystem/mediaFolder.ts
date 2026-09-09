import { promises as fs, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import { approveMediaPath, kindForExtension } from './mediaRegistry';
import type { MediaKind } from '../../shared/schemas/media';

/**
 * v0.8 — the folder side of relinking and collecting.
 *
 * The renderer never names a directory: the channels that use this open a
 * dialog first, so the only folders ever walked are ones a person pointed at
 * in Finder. That keeps a new capability from becoming a new way to enumerate
 * the disk.
 */

export interface FolderMediaEntry {
  path: string;
  fileName: string;
  fileSize: number;
  kind: MediaKind;
}

/** Deep enough for a `media/video` layout, shallow enough not to walk a home
 * directory by accident. */
const MAX_DEPTH = 3;
/** A folder with more media than this is not the one they meant. */
const MAX_ENTRIES = 2000;

export async function scanFolderForMedia(root: string): Promise<FolderMediaEntry[]> {
  if (!path.isAbsolute(root)) throw new Error('Folder must be absolute');
  const out: FolderMediaEntry[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree is not an error, it just has nothing in it
    }
    for (const entry of entries) {
      if (out.length >= MAX_ENTRIES) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      // Follow no symlinks: a link can point anywhere, and "the folder the
      // user picked" should mean the folder the user picked.
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = kindForExtension(path.extname(entry.name));
      if (!kind) continue;
      try {
        const stat = await fs.stat(full);
        out.push({ path: full, fileName: entry.name, fileSize: stat.size, kind });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  };

  await walk(root, 0);
  // Anything offered as a relink target has to be streamable afterwards.
  for (const entry of out) approveMediaPath(entry.path);
  return out;
}

export interface CollectResult {
  /** Original absolute path → its new absolute path inside the project. */
  moved: Record<string, string>;
  /** Bytes actually copied (files already in place are skipped). */
  bytesCopied: number;
  /** Paths that could not be read. Collect does what it can and says so. */
  missing: string[];
}

/**
 * Copy every named file into `<project dir>/media/`, so the project's folder
 * becomes the whole show.
 *
 * A file already at or below the project directory is left exactly where it
 * is: it already travels, and moving it would break a layout the user chose.
 * Name collisions between different files get a numeric suffix rather than
 * one silently overwriting the other.
 *
 * A file that cannot be read is REPORTED, not thrown. Collecting a show with
 * one offline clip should gather the other three and tell you about the
 * fourth — the first version aborted the whole operation and left an empty
 * `media/` behind, which is the least useful of the available outcomes.
 */
export async function collectMediaBeside(
  projectPath: string,
  sourcePaths: readonly string[],
): Promise<CollectResult> {
  if (!path.isAbsolute(projectPath)) throw new Error('Project path must be absolute');
  const projectDir = path.dirname(projectPath);
  const mediaDir = path.join(projectDir, 'media');
  const moved: Record<string, string> = {};
  const missing: string[] = [];
  let bytesCopied = 0;
  let made = false;

  const taken = new Set<string>();
  for (const source of sourcePaths) {
    if (!path.isAbsolute(source)) continue;
    const rel = path.relative(projectDir, source);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) continue; // already travels

    // Stat FIRST, so a run in which nothing is readable does not leave an
    // empty `media/` directory behind as its only trace.
    let stat: Stats;
    try {
      stat = await fs.stat(source);
    } catch {
      missing.push(source);
      continue;
    }
    if (!made) {
      await fs.mkdir(mediaDir, { recursive: true });
      made = true;
    }
    const ext = path.extname(source);
    const stem = path.basename(source, ext);
    let name = `${stem}${ext}`;
    let n = 1;
    while (taken.has(name)) name = `${stem}-${n++}${ext}`;
    taken.add(name);

    const target = path.join(mediaDir, name);
    // An identical file already sitting there is the same file: skip the copy
    // and point at it, so re-collecting a show is cheap instead of doubling it.
    let already = false;
    try {
      already = (await fs.stat(target)).size === stat.size;
    } catch {
      /* not there yet */
    }
    if (!already) {
      try {
        await fs.copyFile(source, target);
      } catch {
        missing.push(source);
        continue;
      }
      bytesCopied += stat.size;
    }
    approveMediaPath(target);
    moved[source] = target;
  }
  return { moved, bytesCopied, missing };
}
