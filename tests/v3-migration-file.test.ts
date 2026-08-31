import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject, MIGRATED_LAYER_ID, selectedLayerOf } from '@shared/schemas/project';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';

describe('v0.6 — a real v3 file on disk', () => {
  // A real file, on disk, in the shape v0.5 actually wrote. Constructing the
  // v3 shape inline in a test would drift with the code that reads it — this
  // cannot.
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'v3-single-layer.material'), 'utf8'),
  ) as unknown;

  it('opens, and becomes exactly one layer carrying everything it had', () => {
    const p = parseProject(raw);
    expect(p.version).toBe(PROJECT_FORMAT_VERSION);
    expect(p.layers).toHaveLength(1);
    const l = selectedLayerOf(p);
    expect(l.id).toBe(MIGRATED_LAYER_ID);
    expect(l.sourceId).toBe('g1');
    expect(l.technique?.techniqueId).toBe('mosaic');
    expect(l.technique?.params.columns).toBe(40);
    expect(l.opacity).toBe(1);
    expect(l.blendMode).toBe('normal');
    expect(l.solo).toBe(false);
    // The composition anchor is kept, not moved.
    expect(p.composition.sourceId).toBe('g1');
  });

  it('its mapping still means what it meant, with no layer ids invented', () => {
    const p = parseProject(raw);
    const m = p.modulations[0]!;
    expect(m.targetLayerId).toBeUndefined();
    expect(m.sourceLayerId).toBeUndefined();
  });

  it('its Look is left as a pre-v0.6 Look, not given a fabricated stack', () => {
    const p = parseProject(raw);
    expect(p.pinnedLooks[0]!.layers).toBeUndefined();
    expect(p.pinnedLooks[0]!.techniques[0]!.techniqueId).toBe('echo');
  });

  it('re-migrating is a no-op, so opening twice cannot drift', () => {
    const once = parseProject(raw);
    const twice = parseProject(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});
