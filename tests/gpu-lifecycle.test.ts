import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CE1H §63 — GPU object lifecycle.
 *
 * A 10-minute creative soak (1296 iterations of source switches, preset
 * applies, morphs across all ten transition styles, freeze cycles) held heap,
 * textures, programs and every render target bounded — and grew GEOMETRIES
 * monotonically from 0 to 4323.
 *
 * Full-screen-quad passes each allocate a PlaneGeometry, and seven of them
 * disposed only their materials and targets. A leaked geometry is small
 * enough that heap pressure never reveals it, so nothing else in the soak
 * moved. After the fix the same churn holds geometries at 3-9, tracking the
 * active technique.
 *
 * Every offscreen pass owner must dispose what it allocated.
 */
const OWNERS: [string, string[]][] = [
  ['src/rendering/simulation/SimulationRunner.ts', ['seedScene', 'stepScene']],
  ['src/rendering/flow/OpticalFlowField.ts', ['lumaScene', 'lkScene', 'blurScene']],
  ['src/rendering/transition/TransitionCompositor.ts', ['scene']],
  ['src/rendering/feedback/feedbackStep.ts', ['scene']],
  ['src/rendering/temporal/TemporalFrameProvider.ts', ['scene']],
  ['src/sources/generators/GeneratorSource.ts', ['scene', 'simScene']],
];

describe('every offscreen pass disposes its geometry (§63)', () => {
  for (const [path, scenes] of OWNERS) {
    it(`${path.split('/').pop()} releases ${scenes.join(', ')}`, () => {
      const source = readFileSync(join(__dirname, '..', path), 'utf8');
      expect(source).toContain('disposeSceneGeometry');
      for (const scene of scenes) {
        expect(
          source.includes(`disposeSceneGeometry(this.${scene})`),
          `${path} never releases ${scene}`,
        ).toBe(true);
      }
    });
  }

  it('the feedback technique releases its bloom pass too', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'techniques', 'feedback', 'FeedbackRenderer.ts'),
      'utf8',
    );
    // The view mesh was disposed; the bloom scene's quad was not.
    expect(source).toContain('this.mesh.geometry.dispose()');
    expect(source).toContain('disposeSceneGeometry(this.bloomScene)');
  });

  it('the helper walks the whole scene rather than one known mesh', () => {
    const helper = readFileSync(
      join(__dirname, '..', 'src', 'rendering', 'disposeScene.ts'),
      'utf8',
    );
    expect(helper).toContain('traverse');
  });
});
