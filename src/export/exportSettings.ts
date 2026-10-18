import { z } from 'zod';
import type { Project } from '@shared/schemas/project';

/** What the export dialog remembers, per project (keyed by file path, else name). */
export const exportSettingsSchema = z.object({
  format: z.enum(['png-still', 'png-sequence', 'h264', 'prores422', 'prores4444']),
  resolution: z.enum(['source', '1080', '2160']),
  fps: z.number().min(1).max(120),
  includeAudio: z.boolean(),
  alpha: z.boolean(),
});
export type ExportSettings = z.infer<typeof exportSettingsSchema>;

const PREFIX = 'material.export.';

function storageKey(projectKey: string): string {
  return `${PREFIX}${projectKey}`;
}

export function loadExportSettings(projectKey: string): ExportSettings | null {
  try {
    const raw = localStorage.getItem(storageKey(projectKey));
    if (!raw) return null;
    const parsed = exportSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveExportSettings(projectKey: string, settings: ExportSettings): void {
  try {
    localStorage.setItem(storageKey(projectKey), JSON.stringify(settings));
  } catch {
    // storage unavailable: the dialog just falls back to defaults next time
  }
}

/**
 * Snap a probed frame rate to the choices we offer. A 25 fps source must default
 * to 25, never a silently resampled 30; a rate that is not a standard choice
 * (23.976, 29.97) is kept as-is instead of being rounded away.
 */
export function defaultFps(sourceFps: number | null, options: readonly number[]): number {
  if (sourceFps === null || !Number.isFinite(sourceFps) || sourceFps < 1 || sourceFps > 120) {
    return 30;
  }
  const exact = options.find((o) => Math.abs(o - sourceFps) < 0.001);
  return exact ?? Math.round(sourceFps * 1000) / 1000;
}

/** Frame rate of the footage the composition is showing, or null (generator, still, unreadable). */
export async function probeSourceFps(project: Project): Promise<number | null> {
  const source = project.sources.find((x) => x.id === project.composition.sourceId);
  if (!source || source.kind !== 'video') return null;
  try {
    return (await window.material.probeMedia(source.path)).frameRate;
  } catch {
    return null;
  }
}
