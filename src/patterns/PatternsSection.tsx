import { useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import {
  addPatternSource,
  duplicatePatternSource,
  removePatternSource,
  setPatternSourceEnabled,
  updatePatternSource,
} from '@/pattern/patternSourceActions';
import { patternSourceKey, resolvePatternHandles } from '@/pattern/patternSourceRuntime';
import type { PatternSource } from '@shared/schemas/project';
import { SequenceEditor } from './SequenceEditor';
import { EuclideanEditor } from './EuclideanEditor';
import { TransformList } from './TransformList';
import { PatternStepPreview } from './PatternStepPreview';
import { NumberField } from './NumberField';
import './patterns.css';

/**
 * PATTERNS — project-global temporal signals, living in the Inspector's
 * SIGNALS group beside modulation, triggers, macros and MIDI. A pattern is
 * a source: it is mapped onto parameters through the existing modulation
 * system, never through a pattern-specific routing of its own.
 *
 * Display labels are positional (PAT 01…); the stable id stays hidden
 * because it is creative identity, not something to read or type.
 */

export function patternLabel(index: number): string {
  return `PAT ${String(index + 1).padStart(2, '0')}`;
}

const DEFAULT_SEQUENCE: PatternSource['pattern'] = { type: 'sequence', values: [0, 1] };
const DEFAULT_ALTERNATE: PatternSource['pattern'] = { type: 'alternate', values: [0, 0.5, 1] };
const DEFAULT_EUCLIDEAN: PatternSource['pattern'] = {
  type: 'euclidean',
  pulses: 3,
  steps: 8,
  rotation: 0,
  activeValue: 1,
  inactiveValue: 0,
};

export function PatternsSection() {
  const sources = useProjectStore((s) => s.project.patternSources);
  const modulations = useProjectStore((s) => s.project.modulations);
  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const selected = sources.find((s) => s.id === selectedId) ?? null;
  const targetsOf = (id: string) =>
    modulations.filter((m) => m.source === patternSourceKey(id) && m.enabled);
  // Compile errors come from the same resolve the runtime uses.
  const errorOf = (source: PatternSource) =>
    resolvePatternHandles([{ ...source, enabled: true }])[0]?.error ?? null;

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span className="label">Patterns</span>
        <span className="section-count">
          <button
            className="vp-btn"
            onClick={() => {
              const created = addPatternSource({
                enabled: true,
                pattern: DEFAULT_SEQUENCE,
                transforms: [],
                beatsPerCycle: 4,
              });
              setSelectedId(created.id);
            }}
          >
            + ADD
          </button>
        </span>
      </div>

      {sources.length === 0 && (
        <div className="pat-empty">Temporal sequences and rhythmic modulation.</div>
      )}

      {sources.map((source, index) => {
        const targets = targetsOf(source.id);
        const error = errorOf(source);
        const open = source.id === selectedId;
        return (
          <div key={source.id} className={`pat-row-wrap${open ? ' open' : ''}`}>
            <div className="pat-row">
              <button
                className={`mod-enable${source.enabled ? ' on' : ''}`}
                role="switch"
                aria-checked={source.enabled}
                aria-label={`${patternLabel(index)} enabled`}
                title={source.enabled ? 'Disable' : 'Enable'}
                onClick={() => setPatternSourceEnabled(source.id, !source.enabled)}
              />
              <button
                className="pat-row-main"
                aria-expanded={open}
                onClick={() => setSelectedId(open ? null : source.id)}
              >
                <span className="pat-row-name mono">{patternLabel(index)}</span>
                <span className="pat-row-summary">{summarize(source)}</span>
              </button>
              <span className="pat-row-status">
                {statusOf(source, error, bpm, targets.length)}
              </span>
            </div>
            {open && (
              <div className="pat-editor">
                <PatternEditor source={source} index={index} targets={targets.length} />
                <div className="pat-actions">
                  <button
                    className="vp-btn"
                    onClick={() => {
                      const copy = duplicatePatternSource(source.id);
                      if (copy) setSelectedId(copy.id);
                    }}
                  >
                    DUPLICATE
                  </button>
                  {confirmingDelete === source.id ? (
                    <span className="pat-confirm">
                      <span className="pat-confirm-text">
                        {targets.length > 0
                          ? `Remove ${patternLabel(index)}? ${targets.length} mapping${
                              targets.length === 1 ? '' : 's'
                            } will also be removed.`
                          : `Remove ${patternLabel(index)}?`}
                      </span>
                      <button
                        className="vp-btn danger"
                        onClick={() => {
                          removePatternSource(source.id);
                          setConfirmingDelete(null);
                          setSelectedId(null);
                        }}
                      >
                        REMOVE
                      </button>
                      <button className="vp-btn" onClick={() => setConfirmingDelete(null)}>
                        CANCEL
                      </button>
                    </span>
                  ) : (
                    <button className="vp-btn" onClick={() => setConfirmingDelete(source.id)}>
                      DELETE
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {selected === null && sources.length > 0 && (
        <div className="pat-hint pat-list-hint">Select a pattern to edit it</div>
      )}
    </div>
  );
}

function PatternEditor({
  source,
  index,
  targets,
}: {
  source: PatternSource;
  index: number;
  targets: number;
}) {
  const definition = source.pattern;
  return (
    <>
      <div className="pat-fields pat-top-fields">
        <label className="pat-num">
          <span className="pat-num-label">type</span>
          <select
            className="select"
            aria-label={`${patternLabel(index)} type`}
            value={definition.type}
            onChange={(e) => {
              // Switching type replaces the definition; transforms, cycle,
              // enabled state, id and mappings all survive, and one undo
              // brings the old definition back.
              const next =
                e.target.value === 'euclidean'
                  ? DEFAULT_EUCLIDEAN
                  : e.target.value === 'constant'
                    ? ({ type: 'constant', value: 1 } as const)
                    : e.target.value === 'alternate'
                      ? DEFAULT_ALTERNATE
                      : DEFAULT_SEQUENCE;
              updatePatternSource(source.id, { pattern: next });
            }}
          >
            <option value="sequence">Sequence</option>
            <option value="alternate">Alternate</option>
            <option value="euclidean">Euclidean</option>
            <option value="constant">Constant</option>
          </select>
        </label>
        <NumberField
          label="cycle"
          suffix="beats"
          width={40}
          value={source.beatsPerCycle}
          validate={(v) => v > 0}
          onCommit={(v) => updatePatternSource(source.id, { beatsPerCycle: v })}
        />
        <span className="pat-targets">
          {targets === 0 ? 'unmapped' : `${targets} target${targets === 1 ? '' : 's'}`}
        </span>
      </div>

      {(definition.type === 'sequence' || definition.type === 'alternate') && (
        <SequenceEditor source={source} definition={definition} />
      )}
      {definition.type === 'euclidean' && (
        <EuclideanEditor source={source} definition={definition} />
      )}
      {definition.type === 'constant' && (
        <div className="pat-block">
          <div className="pat-block-head">
            <span className="label">Constant</span>
          </div>
          <div className="pat-fields">
            <NumberField
              label="value"
              value={definition.type === 'constant' && typeof definition.value === 'number' ? definition.value : 1}
              onCommit={(v) => updatePatternSource(source.id, { pattern: { type: 'constant', value: v } })}
            />
          </div>
        </div>
      )}
      {definition.type !== 'euclidean' && <PatternStepPreview patternId={source.id} />}

      <TransformList source={source} />
    </>
  );
}

function summarize(source: PatternSource): string {
  const d = source.pattern;
  const transforms = source.transforms.length > 0 ? ` · ${source.transforms.length}T` : '';
  if (d.type === 'sequence') return `SEQ · ${d.values.length} steps${transforms}`;
  if (d.type === 'alternate') return `ALT · ${d.values.length} cycles${transforms}`;
  if (d.type === 'euclidean') return `EUCLID · ${d.pulses}/${d.steps}${transforms}`;
  return `CONST · ${String(d.value)}${transforms}`;
}

function statusOf(
  source: PatternSource,
  error: string | null,
  bpm: number | null,
  targets: number,
): string {
  if (!source.enabled) return 'DISABLED';
  if (error) return 'INVALID';
  if (bpm === null || bpm <= 0) return 'NO BPM';
  if (targets === 0) return 'UNMAPPED';
  return 'LIVE';
}
