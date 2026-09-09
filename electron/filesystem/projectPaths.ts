import path from 'node:path';
import type { Project } from '../../shared/schemas/project';

/**
 * v0.8 — a project that can leave the machine it was made on.
 *
 * Media paths are stored RELATIVE when the file lives at or below the
 * project's own directory, and absolute otherwise. The in-memory project
 * always holds absolute paths: this pair converts only at the disk boundary,
 * so nothing in the renderer — `material://` approval, probing, relinking —
 * has to know that relative paths exist at all.
 *
 * Only descendants are relativised. A `../../..` chain out of the project's
 * directory is not portability, it is a different absolute path written in a
 * more fragile way, and moving the project folder would break it just as
 * thoroughly while looking like it should work.
 */

/** True when `target` is at or below `dir` — not merely prefixed by it. */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Absolute → relative-where-possible, for writing. */
export function toPortablePaths(project: Project, projectPath: string): Project {
  const dir = path.dirname(projectPath);
  return {
    ...project,
    sources: project.sources.map((s) => {
      if (!('path' in s) || !path.isAbsolute(s.path) || !isInside(dir, s.path)) return s;
      // POSIX separators on disk: a project written on macOS and opened on
      // another POSIX machine should not depend on which one wrote it.
      const rel = path.relative(dir, s.path).split(path.sep).join('/');
      return { ...s, path: rel };
    }),
  };
}

/** Relative → absolute, for reading. Absolute paths pass through untouched. */
export function toAbsolutePaths(project: Project, projectPath: string): Project {
  const dir = path.dirname(projectPath);
  return {
    ...project,
    sources: project.sources.map((s) => {
      if (!('path' in s) || s.path === '' || path.isAbsolute(s.path)) return s;
      return { ...s, path: path.resolve(dir, s.path) };
    }),
  };
}
