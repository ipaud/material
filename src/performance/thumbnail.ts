import { engine } from '@/rendering/RenderEngine';
import type { ParamRecord, Project } from '@shared/schemas/project';

/**
 * Look / candidate thumbnails (Phase 17 §14).
 *
 * A thumbnail is the frame under the playhead, rendered offscreen — which
 * means pinning during a dark passage yields a dark tile. We do NOT move the
 * playhead or alter visual state to get a prettier picture: the thumbnail
 * tells the truth about what was on screen. Instead the render reports how
 * bright the result was, so the UI can offer a re-thumbnail rather than
 * silently handing back a black rectangle.
 */

const THUMB_WIDTH = 220;
/** Mean luminance below which a thumbnail is worth re-taking. */
export const DARK_THUMBNAIL_THRESHOLD = 0.02;

export interface ThumbnailResult {
  dataUrl: string | null;
  /** Mean luminance 0..1, or null when no render happened. */
  luminance: number | null;
}

export function isDarkThumbnail(luminance: number | null): boolean {
  return luminance !== null && luminance < DARK_THUMBNAIL_THRESHOLD;
}

/**
 * Render a thumbnail for the given technique params against the CURRENT
 * frame. Returns the data URL and its mean luminance.
 */
export function renderThumbnail(project: Project, params: ParamRecord): ThumbnailResult {
  try {
    if (!project.composition.sourceId) return { dataUrl: null, luminance: null };
    const aspect = project.composition.width / project.composition.height;
    const h = Math.max(Math.round(THUMB_WIDTH / aspect), 16);
    const pixels = engine.renderStill(THUMB_WIDTH, h, params);

    let sum = 0;
    const pixelCount = pixels.length / 4;
    for (let i = 0; i < pixelCount; i++) {
      sum +=
        (0.2126 * (pixels[i * 4] as number) +
          0.7152 * (pixels[i * 4 + 1] as number) +
          0.0722 * (pixels[i * 4 + 2] as number)) /
        255;
    }
    const luminance = pixelCount > 0 ? sum / pixelCount : 0;

    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: null, luminance };
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), THUMB_WIDTH, h), 0, 0);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.7), luminance };
  } catch {
    return { dataUrl: null, luminance: null };
  }
}
