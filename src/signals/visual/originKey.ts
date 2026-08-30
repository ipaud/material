import type { SourceRef } from '@shared/schemas/project';

/**
 * v0.4A A5 — calibration is keyed by PIXEL ORIGIN, not by source record.
 *
 * Neither existing handle is right. `source.id` is too stable: it survives a
 * camera device swap, so a webcam and a capture card would share a range.
 * `engineBridge`'s `sourceKey` answers a different question ("when do I rebuild
 * the runtime") and is too volatile for files — it is `kind:path` with no id,
 * yet two project entries pointing at the same camera should share calibration.
 *
 * So: drop the record id, keep whatever actually determines the pixels.
 */
export interface LiveOriginIds {
  activeCameraDeviceId?: string | null;
  chosenWindowId?: string | null;
}

export function pixelOriginKey(source: SourceRef | null, live: LiveOriginIds = {}): string | null {
  if (!source) return null;
  switch (source.kind) {
    case 'generator':
      // Params excluded: a param tweak re-adapts in a few seconds and is the
      // same material. Kind and seed are what make it different material.
      return `gen:${source.generator}:${source.seed}`;
    case 'camera':
      return `cam:${source.deviceId ?? live.activeCameraDeviceId ?? 'default'}`;
    case 'screen':
      return `screen:${source.displayId ?? 'primary'}`;
    case 'window':
      // The OS target the user actually picked — `source.id` excludes it
      // entirely, and that is exactly the case where the pixels DO change.
      return `window:${live.chosenWindowId ?? source.titleHint ?? source.id}`;
    default:
      return `file:${source.kind}:${source.path}`;
  }
}
