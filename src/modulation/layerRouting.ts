import type { ModulationMapping, Project } from '@shared/schemas/project';

/**
 * v0.6B — where a mapping reads from and where it writes to.
 *
 * Two ids, both optional, both stored as LAYER IDS and never as indices, so
 * reordering the stack cannot silently re-point a route:
 *
 * - `targetLayerId` — whose technique parameter this mapping drives.
 * - `sourceLayerId` — whose visual signals feed it.
 *
 * The defaults are what make v0.4 and v0.5 projects keep working untouched.
 * A mapping with neither field drives the bottom layer from the bottom
 * layer's own signals, which is exactly what "the project's one technique,
 * driven by the project's one image" meant before layers existed.
 *
 * `targetLayerId` deliberately does NOT fall back to the *selected* layer.
 * Selection is a UI state that changes as the performer clicks around; a
 * stored mapping whose meaning followed it would render differently depending
 * on what happened to be selected when the project was opened.
 */

/** The layer a mapping writes to. Falls back to the bottom layer. */
export function targetLayerOf(project: Project, mapping: ModulationMapping): string {
  const explicit = mapping.targetLayerId;
  if (explicit && project.layers.some((l) => l.id === explicit)) return explicit;
  return project.layers[0]!.id;
}

/**
 * The layer a mapping reads signals from. Defaults to its own target — a
 * layer reacting to itself — which is the only default that needs no UI to
 * be useful.
 */
export function sourceLayerOf(project: Project, mapping: ModulationMapping): string {
  const explicit = mapping.sourceLayerId;
  if (explicit && project.layers.some((l) => l.id === explicit)) return explicit;
  return targetLayerOf(project, mapping);
}

/** Mappings grouped by the layer whose parameters they drive. */
export function mappingsByTarget(project: Project): Map<string, ModulationMapping[]> {
  const out = new Map<string, ModulationMapping[]>();
  for (const layer of project.layers) out.set(layer.id, []);
  for (const m of project.modulations) {
    const id = targetLayerOf(project, m);
    out.get(id)?.push(m);
  }
  return out;
}

/**
 * A route that crosses layers, for the UI to label and for tests to assert.
 * A mapping reading its own layer is not a route — it is the default.
 */
export interface CrossLayerRoute {
  readonly mappingId: string;
  readonly from: string;
  readonly to: string;
  readonly signal: string;
}

export function crossLayerRoutes(project: Project): CrossLayerRoute[] {
  const routes: CrossLayerRoute[] = [];
  for (const m of project.modulations) {
    if (!m.enabled) continue;
    const to = targetLayerOf(project, m);
    const from = sourceLayerOf(project, m);
    if (from === to) continue;
    routes.push({ mappingId: m.id, from, to, signal: m.source });
  }
  return routes;
}

/**
 * Routes cannot form a cycle in the value sense — a mapping's output is a
 * leaf technique parameter and never another mapping's input, exactly as
 * before layers (docs/MODULATION.md). What layers add is a *frame* cycle:
 * layer B reacting to layer A's pixels while A reacts to B's.
 *
 * That is legal and it is one of the reasons to want layers at all. It
 * resolves because visual signals are sampled from frame N-1 on every path,
 * so a loop settles at one frame of latency per hop rather than deadlocking.
 * This exists to report such loops, not to forbid them.
 */
export function feedbackLoops(project: Project): string[][] {
  const edges = new Map<string, Set<string>>();
  for (const r of crossLayerRoutes(project)) {
    if (!edges.has(r.to)) edges.set(r.to, new Set());
    edges.get(r.to)!.add(r.from);
  }
  const loops: string[][] = [];
  const seen = new Set<string>();
  const walk = (node: string, path: string[]): void => {
    const at = path.indexOf(node);
    if (at >= 0) {
      const cycle = path.slice(at);
      const key = [...cycle].sort().join('>');
      if (!seen.has(key)) {
        seen.add(key);
        loops.push(cycle);
      }
      return;
    }
    for (const next of edges.get(node) ?? []) walk(next, [...path, node]);
  };
  for (const node of edges.keys()) walk(node, []);
  return loops;
}
