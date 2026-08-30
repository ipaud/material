import { create } from 'zustand';
import type { VisualSignalId } from './types';

/**
 * v0.4A A6 — which signals a diagnostics panel is currently watching.
 *
 * Analysis is demand-driven, so an open scope has to register demand of its
 * own; otherwise watching an unmapped signal would show a permanently empty
 * readout. Closing the panel must give the demand back, or the reducer would
 * keep running for nobody.
 */
interface ScopeState {
  watching: ReadonlySet<VisualSignalId>;
}

export const useScopeStore = create<ScopeState>(() => ({ watching: new Set() }));

export function watchSignal(id: VisualSignalId): void {
  useScopeStore.setState((s) => ({ watching: new Set(s.watching).add(id) }));
}

export function unwatchSignal(id: VisualSignalId): void {
  useScopeStore.setState((s) => {
    const next = new Set(s.watching);
    next.delete(id);
    return { watching: next };
  });
}
