import type { BlendMode } from '@shared/schemas/project';

/**
 * v0.6 — what the host needs to know about a layer in order to render it.
 *
 * Deliberately not the project's `Layer`: this is the resolved, per-frame view
 * — opacity may have been modulated, `enabled` may have been solo'd — and the
 * host must never read project state directly.
 */
export interface LayerRenderState {
  id: string;
  enabled: boolean;
  opacity: number;
  blendMode: BlendMode;
  selected: boolean;
}
