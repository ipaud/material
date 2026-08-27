import path from 'node:path';
import { statSync } from 'node:fs';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_SVG_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
} from '../../shared/constants/app';
import type { MediaKind } from '../../shared/schemas/media';

const ALL_EXTENSIONS = new Set<string>([
  ...SUPPORTED_IMAGE_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS,
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_SVG_EXTENSIONS,
]);

/** Absolute paths the renderer is allowed to stream via the material:// protocol. */
const approvedPaths = new Set<string>();

export function kindForExtension(ext: string): MediaKind | null {
  const clean = ext.replace(/^\./, '').toLowerCase();
  if ((SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(clean)) return 'image';
  if ((SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(clean)) return 'video';
  if ((SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(clean)) return 'audio';
  if ((SUPPORTED_SVG_EXTENSIONS as readonly string[]).includes(clean)) return 'svg';
  return null;
}

/**
 * Validate a media path: absolute, supported extension, exists, is a file.
 * Throws with a user-meaningful message on failure.
 */
export function validateMediaPath(filePath: string): { kind: MediaKind; size: number } {
  if (!path.isAbsolute(filePath)) throw new Error('Media path must be absolute');
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) throw new Error('Invalid media path');
  const ext = path.extname(normalized).replace(/^\./, '').toLowerCase();
  if (!ALL_EXTENSIONS.has(ext)) throw new Error(`Unsupported file type: .${ext}`);
  const kind = kindForExtension(ext);
  if (!kind) throw new Error(`Unsupported file type: .${ext}`);
  const stats = statSync(normalized);
  if (!stats.isFile()) throw new Error('Path is not a file');
  return { kind, size: stats.size };
}

export function approveMediaPath(filePath: string): void {
  approvedPaths.add(path.normalize(filePath));
}

export function isApprovedMediaPath(filePath: string): boolean {
  return approvedPaths.has(path.normalize(filePath));
}
