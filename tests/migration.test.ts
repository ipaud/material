import { describe, expect, test } from 'vitest';
import { createEmptyProject, parseProject } from '@shared/schemas/project';

/**
 * Phase 17 §9: v1 → v2 migration is a release commitment. These fixtures are
 * shaped like real v0.1 files — the whole point is that a project made before
 * the musical/performance systems existed still opens, still looks the same,
 * and gains empty (not invented) v0.2 state.
 */

/** A v0.1 project as v0.1 actually wrote it: no v0.2 fields anywhere. */
function v1Project(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'V1 Project',
    sources: [
      {
        id: 'src-1',
        kind: 'video',
        path: '/Users/someone/Movies/clip.mp4',
        metadata: {
          kind: 'video',
          path: '/Users/someone/Movies/clip.mp4',
          fileName: 'clip.mp4',
          fileSize: 1234,
          durationSec: 30,
          width: 1920,
          height: 1080,
          frameRate: 25,
          videoCodec: 'h264',
          audioCodec: 'aac',
          audioChannels: 2,
          sampleRate: 48000,
        },
      },
    ],
    composition: {
      sourceId: 'src-1',
      audioSourceId: null,
      width: 1920,
      height: 1080,
      background: '#000000',
    },
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { columns: 32, rows: 18, scale: 1.2 } },
    ],
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [
      {
        id: 'mod-1',
        enabled: true,
        source: 'bass',
        target: 'scale',
        amount: 0.6,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0.3,
        curve: 'linear',
        frozenValue: null,
      },
    ],
    timeline: { inSec: null, outSec: null, loop: true, bpm: 110, beatOffsetSec: 0.05 },
    pinnedLooks: [],
    explore: { lockedParams: [], lastSeed: 42 },
    ...patch,
  };
}

/** A v0.1 pinned look: no note/slot/seed/thumbnail/triggers. */
function v1Look(): Record<string, unknown> {
  return {
    id: 'look-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    label: 'LOOK 01',
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { columns: 64, scale: 0.8 } },
    ],
    material: { materialId: 'circle', colorMode: 'mono', params: {}, assetPath: null },
    modulations: [],
  };
}

describe('v1 → v2 migration', () => {
  test('a plain v1 project opens and keeps its visual state', () => {
    const migrated = parseProject(v1Project());
    expect(migrated.version).toBe(2);
    expect(migrated.techniques[0]!.params).toEqual({ columns: 32, rows: 18, scale: 1.2 });
    expect(migrated.material.materialId).toBe('square');
    expect(migrated.modulations[0]).toMatchObject({ source: 'bass', target: 'scale', amount: 0.6 });
    expect(migrated.composition.sourceId).toBe('src-1');
    expect(migrated.explore.lastSeed).toBe(42);
  });

  test('musical fields gain honest defaults, never invented values', () => {
    const migrated = parseProject(v1Project());
    expect(migrated.timeline.bpm).toBe(110); // preserved, not re-detected
    expect(migrated.timeline.beatOffsetSec).toBe(0.05);
    expect(migrated.timeline.beatsPerBar).toBe(4);
    expect(migrated.timeline.markers).toEqual([]);
  });

  test('every v0.2 system starts empty', () => {
    const migrated = parseProject(v1Project());
    expect(migrated.triggers).toEqual([]);
    expect(migrated.midiMappings).toEqual([]);
    expect(migrated.macros).toEqual([]);
    expect(migrated.performancePads).toEqual([]);
    expect(migrated.morphEvents).toEqual([]);
    expect(migrated.activeLookId).toBeNull();
    expect(migrated.performanceQuantize).toBe('bar');
  });

  test('v1 pinned looks migrate with defaulted identity fields', () => {
    const migrated = parseProject(v1Project({ pinnedLooks: [v1Look()] }));
    const look = migrated.pinnedLooks[0]!;
    expect(look.label).toBe('LOOK 01');
    expect(look.techniques[0]!.params).toEqual({ columns: 64, scale: 0.8 });
    expect(look.material.materialId).toBe('circle');
    expect(look.note).toBe('');
    expect(look.slot).toBeNull();
    expect(look.seed).toBe(1);
    expect(look.thumbnail).toBeNull();
    expect(look.triggers).toEqual([]);
  });

  test('custom material with an asset path survives', () => {
    const migrated = parseProject(
      v1Project({
        material: {
          materialId: 'custom',
          colorMode: 'original',
          params: { aspect: 1.5 },
          assetPath: '/Users/someone/art/mark.svg',
        },
      }),
    );
    expect(migrated.material.assetPath).toBe('/Users/someone/art/mark.svg');
    expect(migrated.material.colorMode).toBe('original');
    expect(migrated.material.params.aspect).toBe(1.5);
  });

  test('temporal params ride through untouched', () => {
    const migrated = parseProject(
      v1Project({
        techniques: [
          {
            id: 'tech-1',
            techniqueId: 'mosaic',
            enabled: true,
            params: { tileMode: 'tile', offsetMode: 'radial', maxOffsetSec: 1.5, falloff: 1.8 },
          },
        ],
      }),
    );
    expect(migrated.techniques[0]!.params).toMatchObject({
      tileMode: 'tile',
      offsetMode: 'radial',
      maxOffsetSec: 1.5,
      falloff: 1.8,
    });
  });

  test('image-only and audio-only projects migrate', () => {
    const imageOnly = parseProject(
      v1Project({
        sources: [{ id: 's', kind: 'image', path: '/x/a.png', metadata: null }],
        composition: {
          sourceId: 's',
          audioSourceId: null,
          width: 1080,
          height: 1080,
          background: '#000000',
        },
      }),
    );
    expect(imageOnly.sources[0]!.kind).toBe('image');
    const audioOnly = parseProject(
      v1Project({
        sources: [{ id: 'a', kind: 'audio', path: '/x/t.mp3', metadata: null }],
        composition: {
          sourceId: null,
          audioSourceId: 'a',
          width: 1920,
          height: 1080,
          background: '#000000',
        },
      }),
    );
    expect(audioOnly.composition.audioSourceId).toBe('a');
  });

  test('migration is idempotent: migrated v2 reopens identically', () => {
    const once = parseProject(v1Project({ pinnedLooks: [v1Look()] }));
    const twice = parseProject(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  test('the v1 input object is never mutated in place', () => {
    const raw = v1Project({ pinnedLooks: [v1Look()] });
    const snapshot = JSON.parse(JSON.stringify(raw));
    parseProject(raw);
    expect(raw).toEqual(snapshot);
  });

  test('a future version is refused rather than silently coerced', () => {
    expect(() => parseProject({ ...createEmptyProject(), version: 99 })).toThrow(/version/i);
  });

  test('malformed v1 content is refused, not half-migrated', () => {
    expect(() => parseProject({ version: 1, name: 42 })).toThrow();
    expect(() => parseProject({ version: 1 })).toThrow();
  });
});

describe('v2 round-trip', () => {
  test('a full v0.2 project survives serialization unchanged', () => {
    const project = {
      ...createEmptyProject('Round Trip'),
      techniques: [
        { id: 't', techniqueId: 'mosaic', enabled: true, params: { columns: 20, scale: 1.4 } },
      ],
      timeline: {
        ...createEmptyProject().timeline,
        bpm: 78.03,
        beatOffsetSec: 0.021,
        beatsPerBar: 3,
        markers: [{ id: 'm1', timeSec: 12.5, label: 'DROP' }],
      },
      performanceQuantize: '2bars' as const,
      macros: [
        {
          id: 'mac',
          name: 'MEMORY',
          value: 0.7,
          mappings: [
            {
              targetParam: 'maxOffsetSec',
              amount: 0.8,
              min: 0,
              max: 1,
              invert: false,
              curve: 'linear' as const,
              enabled: true,
            },
          ],
        },
      ],
    };
    const back = parseProject(JSON.parse(JSON.stringify(project)));
    expect(back).toEqual(project);
  });
});
