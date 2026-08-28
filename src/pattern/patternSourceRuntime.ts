import type { PatternSource } from '@shared/schemas/project';
import { compilePattern, type CompiledPattern } from './compilePattern';
import type { PatternDefinition, PatternTransform } from './patternTypes';

/**
 * Pattern Engine P4 — compile cache between project state and evalSources.
 *
 * Definitions live in the project (`project.patternSources`); compilation is
 * expensive relative to a frame, so it happens ONLY when a definition
 * changes, never per frame. The cache is keyed by pattern id and validated
 * by content identity:
 *
 *   cache key   = source.id  (stable entity id, uid('pat'))
 *   content key = JSON.stringify({ pattern, transforms })
 *
 * `beatsPerCycle` and `enabled` are deliberately NOT in the content key —
 * they only enter evaluation (clock / handle filtering), so changing them
 * never recompiles. The project seed only enters the evaluation context and
 * never touches this cache either.
 *
 * `resolvePatternHandles` runs at configure time (project subscription /
 * export evaluator construction — the same cadence as
 * modulationRuntime.configure). It prunes ids that disappeared, so project
 * switches, source removal and definition replacement can never leave a
 * stale compiled pattern behind.
 *
 * Compile failure is contained here: the handle carries `error` and a null
 * `compiled`; evalSources emits nothing for it (true modulation-neutral),
 * the render loop never sees a throw, and NaN cannot enter params.
 */

export interface PatternSourceHandle {
  /** Stable pattern id — also the deterministic probability identity. */
  id: string;
  /** Modulation source id: `pattern:<id>` (what mappings reference). */
  sourceKey: string;
  beatsPerCycle: number;
  compiled: CompiledPattern | null;
  error: string | null;
}

interface CacheEntry {
  contentKey: string;
  handle: PatternSourceHandle;
}

const cache = new Map<string, CacheEntry>();
let compileCount = 0;

/**
 * Content fingerprints are memoized by OBJECT IDENTITY (P5 §52 audit): the
 * project store is immutable, so an unchanged PatternSource keeps its object
 * between updates and its fingerprint is computed exactly once. JSON
 * serialization therefore happens only when a source object is actually new
 * (project load, definition edit) — never per configure call, and never
 * anywhere near the frame loop (evalSources does no resolving at all).
 */
const fingerprints = new WeakMap<PatternSource, string>();
let fingerprintCount = 0;

function contentKeyOf(source: PatternSource): string {
  let key = fingerprints.get(source);
  if (key === undefined) {
    fingerprintCount++;
    key = JSON.stringify({ pattern: source.pattern, transforms: source.transforms });
    fingerprints.set(source, key);
  }
  return key;
}

/**
 * The persisted mapping-source format for patterns: `pattern:<id>`.
 *
 * These two helpers are the ONLY place that knows the prefix — nothing else
 * should test `source.startsWith('pattern:')`. Ids from `uid('pat')` are
 * `pat_` + 8 hex characters, so they can never contain a separator; the
 * parser still splits on the FIRST colon only, so an id from a hand-edited
 * project file survives round-tripping unchanged.
 */
const PATTERN_SOURCE_PREFIX = 'pattern:';

export function patternSourceKey(id: string): string {
  return `${PATTERN_SOURCE_PREFIX}${id}`;
}

/** The pattern id behind a mapping source, or null for any other source. */
export function parsePatternSourceKey(source: string): string | null {
  if (!source.startsWith(PATTERN_SOURCE_PREFIX)) return null;
  const id = source.slice(PATTERN_SOURCE_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Resolve enabled pattern sources into evaluation handles, compiling only
 * what changed. Disabled sources are excluded (and pruned from the cache
 * like removed ones — re-enabling recompiles once).
 */
export function resolvePatternHandles(sources: PatternSource[]): PatternSourceHandle[] {
  const seen = new Set<string>();
  const handles: PatternSourceHandle[] = [];

  for (const source of sources) {
    if (!source.enabled) continue;
    seen.add(source.id);
    const contentKey = contentKeyOf(source);
    const cached = cache.get(source.id);
    let handle: PatternSourceHandle;
    if (cached && cached.contentKey === contentKey) {
      handle = cached.handle;
      if (handle.beatsPerCycle !== source.beatsPerCycle) {
        handle = { ...handle, beatsPerCycle: source.beatsPerCycle };
        cache.set(source.id, { contentKey, handle });
      }
    } else {
      compileCount++;
      const result = compilePattern(
        source.pattern as PatternDefinition,
        source.transforms as PatternTransform[],
      );
      handle = {
        id: source.id,
        sourceKey: patternSourceKey(source.id),
        beatsPerCycle: source.beatsPerCycle,
        compiled: result.ok ? result.pattern : null,
        error: result.ok ? null : result.error,
      };
      cache.set(source.id, { contentKey, handle });
    }
    handles.push(handle);
  }

  for (const id of cache.keys()) {
    if (!seen.has(id)) cache.delete(id);
  }
  for (const id of diagnostics.keys()) {
    if (!seen.has(id)) diagnostics.delete(id);
  }
  return handles;
}

/** Test/diagnostic seams. */
export function getPatternCompileCount(): number {
  return compileCount;
}
export function getPatternCacheSize(): number {
  return cache.size;
}
/** How many times a content fingerprint was actually serialized (P5 §52). */
export function getPatternFingerprintCount(): number {
  return fingerprintCount;
}
export function resetPatternRuntime(): void {
  cache.clear();
  compileCount = 0;
  diagnostics.clear();
}

// ---- Dev diagnostics (module-local; never in stores or RuntimeBus) -------
// The event seam (P3 `event`) is preserved here for the future trigger
// phase even though P4 defers trigger firing.

export interface PatternDiagnostic {
  id: string;
  sourceKey: string;
  compiled: boolean;
  error: string | null;
  cycleIndex: number;
  active: boolean;
  event: boolean;
  value: number | boolean | null;
}

const diagnostics = new Map<string, PatternDiagnostic>();

/** Hot path: mutates the existing entry in place — no per-frame allocation. */
export function recordPatternDiagnostic(
  handle: PatternSourceHandle,
  cycleIndex: number,
  result:
    | { active: true; value: number | boolean; event: boolean }
    | { active: false },
): void {
  let d = diagnostics.get(handle.id);
  if (!d) {
    d = {
      id: handle.id,
      sourceKey: handle.sourceKey,
      compiled: false,
      error: null,
      cycleIndex: 0,
      active: false,
      event: false,
      value: null,
    };
    diagnostics.set(handle.id, d);
  }
  d.compiled = handle.compiled !== null;
  d.error = handle.error;
  d.cycleIndex = cycleIndex;
  d.active = result.active;
  d.event = result.active ? result.event : false;
  d.value = result.active ? result.value : null;
}

/** Dev-only snapshot of the last evaluated state of each pattern source. */
export function getPatternDiagnostics(): PatternDiagnostic[] {
  return [...diagnostics.values()];
}
