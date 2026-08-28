import { euclideanMask } from '@/pattern/euclidean';
import { updatePatternSource } from '@/pattern/patternSourceActions';
import type { PatternSource } from '@shared/schemas/project';
import { NumberField } from './NumberField';
import { PatternStepPreview } from './PatternStepPreview';

interface EuclideanDefinition {
  type: 'euclidean';
  pulses: number;
  steps: number;
  rotation: number;
  activeValue: number | boolean;
  inactiveValue: number | boolean;
}

/**
 * Structured Euclidean controls plus a plain DOM dot row — no canvas, no
 * WebGL, one small span per step. The mask comes from the same
 * `euclideanMask` the engine compiles with, so what you see is what plays.
 *
 * A semantically invalid combination (pulses > steps) is still shown and
 * editable: P6 lets such a project open, so the editor must let the user
 * fix it rather than refuse to render.
 */
export function EuclideanEditor({
  source,
  definition,
}: {
  source: PatternSource;
  definition: EuclideanDefinition;
}) {
  const { pulses, steps, rotation } = definition;
  const set = (patch: Partial<EuclideanDefinition>) =>
    updatePatternSource(source.id, { pattern: { ...definition, ...patch } });

  const valid = steps >= 1 && pulses >= 0 && pulses <= steps;
  const mask = valid ? euclideanMask(pulses, steps) : [];
  const rotated = mask.map((_, i) => mask[(((i - rotation) % steps) + steps) % steps] === true);

  return (
    <div className="pat-block">
      <div className="pat-block-head">
        <span className="label">Euclidean</span>
        <span className="pat-hint">
          {pulses} of {steps}
        </span>
      </div>
      <div className="pat-fields">
        <NumberField
          label="pulses"
          value={pulses}
          integer
          validate={(v) => v >= 0}
          onCommit={(v) => set({ pulses: v })}
        />
        <NumberField
          label="steps"
          value={steps}
          integer
          validate={(v) => v >= 1}
          onCommit={(v) => set({ steps: v })}
        />
        <NumberField
          label="rotate"
          value={rotation}
          integer
          onCommit={(v) => set({ rotation: v })}
        />
      </div>
      <div className="pat-fields">
        <NumberField
          label="active"
          value={typeof definition.activeValue === 'number' ? definition.activeValue : 1}
          onCommit={(v) => set({ activeValue: v })}
        />
        <NumberField
          label="rest"
          value={typeof definition.inactiveValue === 'number' ? definition.inactiveValue : 0}
          onCommit={(v) => set({ inactiveValue: v })}
        />
      </div>
      {valid ? (
        <PatternStepPreview patternId={source.id} pulses={rotated} />
      ) : (
        <div className="pat-error">
          <span className="pat-error-title">Invalid</span>
          <span className="pat-error-detail">Pulses cannot exceed steps</span>
        </div>
      )}
    </div>
  );
}
