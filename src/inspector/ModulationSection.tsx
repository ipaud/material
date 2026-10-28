import { selectedLayerOf } from '@shared/schemas/project';
import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { MOD_SOURCES } from '@/modulation/sources';
import { targetLayerOf } from '@/modulation/layerRouting';
import { TransferPreview } from './CurvePreview';
import { usePlaybackStore } from '@/state/playbackStore';

/** Grouped once, from the registry's own `group` field — the picker used to
 * hardcode a flat list, which does not survive a growing signal set. */
const GROUP_LABELS: Record<string, string> = {
  audio: 'Audio',
  time: 'Time',
  beat: 'Beat',
  image: 'Image',
  motion: 'Motion',
};
const SOURCE_GROUPS: [string, typeof MOD_SOURCES][] = Object.entries(GROUP_LABELS)
  .map(([g, label]) => [label, MOD_SOURCES.filter((s) => s.group === g)] as [string, typeof MOD_SOURCES])
  .filter(([, defs]) => defs.length > 0);
import { patternSourceKey } from '@/pattern/patternSourceRuntime';
import { patternLabel } from '@/patterns/PatternsSection';
import { performFreeze } from '@/performance/take/gestures';
import {
  addMapping,
  deleteMapping,
  freezeMapping,
  unfreezeMapping,
  updateMapping,
} from '@/modulation/modulationActions';
import { modulationRuntime } from '@/modulation/runtime';
import { getTriggerState } from '@/signals/triggerRuntime';
import { pulseContribution, triggersForLayer } from '@/signals/pulseEngine';
import { playback } from '@/playback/PlaybackController';
import { allParams } from '@/techniques/types';
import { replaceConflicts } from '@/modulation/evaluator';
import type { ModulationMapping } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { ParameterSlider } from '@/components/ParameterSlider';
import './modulation.css';

/**
 * v0.4C — the live value behind a mapping row.
 *
 * A performer needs to see whether a signal is moving before deciding the
 * mapping is wrong. The number comes from the evaluator's last resolved source
 * values, so this costs one lookup and no analysis of its own.
 */
function SourceMeter({ source }: { source: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(h);
  }, []);
  const v = modulationRuntime.lastSourceValues?.[source];
  if (v === undefined) {
    return (
      <span className="mod-meter" title="This source is not producing a value right now">
        <span className="mod-meter-fill" style={{ width: 0 }} />
      </span>
    );
  }
  const pct = Math.min(Math.max(v, 0), 1) * 100;
  return (
    <span className="mod-meter" title={`${source} = ${v.toFixed(3)}`}>
      <span className="mod-meter-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function ModulationSection() {
  const mappings = useProjectStore((s) => s.project.modulations);
  const project = useProjectStore((s) => s.project);
  const layers = project.layers;
  const clockSec = usePlaybackStore((s) => s.durationSec);
  const timeRange = Math.max(Math.ceil(clockSec), 60);
  const technique = useProjectStore((s) => selectedLayerOf(s.project).technique);
  const patternSources = useProjectStore((s) => s.project.patternSources);
  const [expanded, setExpanded] = useState<string | null>(null);

  const definition = technique ? getTechnique(technique.techniqueId) : null;
  if (!definition) return null;
  const targets = allParams(definition).filter((p) => p.type === 'number' && p.modulatable);

  const anyFrozen = mappings.some((m) => m.frozenValue !== null);
  // A second REPLACE on one target is inert. Saying so is the difference
  // between a considered rule and a row that silently does nothing.
  const inertReplace = new Set<string>();
  for (const layer of layers) {
    for (const id of replaceConflicts(mappings.filter((mapping) => targetLayerOf(project, mapping) === layer.id))) {
      inertReplace.add(id);
    }
  }

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span className="label">Modulation</span>
        <span className="section-count" style={{ display: 'flex', gap: 4 }}>
          <button
            className="vp-btn"
            title="Freeze all modulated targets at their current values (F)"
            onClick={() => performFreeze(true)}
          >
            FREEZE ALL
          </button>
          {anyFrozen && (
            <button className="vp-btn active" title="Clear all frozen values" onClick={() => performFreeze(false)}>
              CLEAR
            </button>
          )}
        </span>
      </div>
      {mappings.map((m) => {
        const isOpen = expanded === m.id;
        const targetLayer = layers.find((layer) => layer.id === targetLayerOf(project, m));
        const targetInstance = m.targetStageId
          ? targetLayer?.techniqueChain.find((stage) => stage.id === m.targetStageId)
          : targetLayer?.technique;
        const mappingDefinition = targetInstance ? getTechnique(targetInstance.techniqueId) : null;
        const mappingTargets = mappingDefinition ? allParams(mappingDefinition).filter((param) => param.type === 'number' && param.modulatable) : [];
        const targetDef = mappingTargets.find((t) => t.id === m.target);
        return (
          <div key={m.id} className={`mod-row-wrap${m.frozenValue !== null ? ' frozen' : ''}`}>
            <div className="mod-row">
              <button
                className={`mod-enable${m.enabled ? ' on' : ''}`}
                title={m.enabled ? 'Disable' : 'Enable'}
                onClick={() => updateMapping(m.id, { enabled: !m.enabled })}
              />
              <select
                className="select mod-select"
                value={m.source}
                onChange={(e) => updateMapping(m.id, { source: e.target.value })}
              >
                {SOURCE_GROUPS.map(([label, defs]) => (
              <optgroup key={label} label={label}>
                {defs.map((sd) => (
                  <option key={sd.id} value={sd.id}>
                    {sd.label}
                  </option>
                ))}
              </optgroup>
            ))}
            {patternSources.length > 0 && (
                  <optgroup label="Pattern">
                    {patternSources.map((p, i) => (
                      <option key={p.id} value={patternSourceKey(p.id)}>
                        {patternLabel(i)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <span className="mod-arrow">→</span>
              <select
                className="select mod-select"
                value={m.target}
                onChange={(e) => updateMapping(m.id, { target: e.target.value })}
              >
                {mappingTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <SourceMeter source={m.source} />
              {m.mode === 'replace' ? (
                <span
                  className={`mod-mode${inertReplace.has(m.id) ? ' inert' : ''}`}
                  title={
                    inertReplace.has(m.id)
                      ? 'Another Replace mapping already owns this parameter, so this row is inactive'
                      : 'Replace: this signal positions the parameter'
                  }
                >
                  {inertReplace.has(m.id) ? 'INERT' : 'SET'}
                </span>
              ) : null}
              <span
                className="mod-amount mono"
                title={targetDef ? `Amount of ${targetDef.label} range` : 'Amount'}
              >
                {m.amount >= 0 ? '+' : ''}
                {m.amount.toFixed(2)}
              </span>
              <button
                className="vp-btn"
                aria-label={isOpen ? 'Collapse mapping' : 'Expand mapping'}
                onClick={() => setExpanded(isOpen ? null : m.id)}
              >
                {isOpen ? '−' : '⋯'}
              </button>
            </div>
            {isOpen && (
              <div className="mod-detail">
                {layers.length > 1 && (
                  <div className="param-row">
                    <span className="param-label">Layer</span>
                    <div className="param-control">
                      <select
                        className="select"
                        aria-label="Mapping layer"
                        value={targetLayerOf(project, m)}
                        title="Which layer this mapping drives. Other layers do not react to it."
                        onChange={(e) => {
                          const layer = layers.find((entry) => entry.id === e.target.value);
                          const next = layer?.technique ? getTechnique(layer.technique.techniqueId) : null;
                          const valid = next ? allParams(next).find((param) => param.type === 'number' && param.modulatable)?.id : undefined;
                          updateMapping(m.id, { targetLayerId: e.target.value, targetStageId: null, ...(valid ? { target: valid } : {}) });
                        }}
                      >
                        {layers.map((l, i) => (
                          <option key={l.id} value={l.id}>
                            {l.name || `Layer ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {targetLayer && targetLayer.techniqueChain.length > 0 && (
                  <div className="param-row">
                    <span className="param-label">Stage</span>
                    <div className="param-control">
                      <select className="select" aria-label="Mapping stage" value={m.targetStageId ?? ''}
                        onChange={(e) => {
                          const stageId = e.target.value || null;
                          const instance = stageId ? targetLayer.techniqueChain.find((stage) => stage.id === stageId) : targetLayer.technique;
                          const next = instance ? getTechnique(instance.techniqueId) : null;
                          const valid = next ? allParams(next).find((param) => param.type === 'number' && param.modulatable)?.id : undefined;
                          updateMapping(m.id, { targetStageId: stageId, ...(valid ? { target: valid } : {}) });
                        }}>
                        <option value="">Primary stage</option>
                        {targetLayer.techniqueChain.map((stage, index) => <option key={stage.id} value={stage.id}>Stage {index + 2}</option>)}
                      </select>
                    </div>
                  </div>
                )}
                <div className="param-row">
                  <span className="param-label" title="mode in the project file">Mode</span>
                  <div className="param-control">
                    <select
                      className="select"
                      value={m.mode ?? 'add'}
                      onChange={(e) =>
                        updateMapping(m.id, {
                          mode: e.target.value === 'replace' ? 'replace' : 'add',
                        })
                      }
                    >
                      <option value="add">Add — the signal pushes the parameter away from its own value</option>
                      <option value="replace">Set — the signal chooses the value, between Out min and Out max</option>
                    </select>
                  </div>
                </div>
                <ParameterSlider
                  label="Amount"
                  value={m.amount}
                  min={-1}
                  max={1}
                  step={0.01}
                  defaultValue={0.5}
                  onChange={(v) => updateMapping(m.id, { amount: v })}
                />
                <ParameterSlider
                  label="Smoothing"
                  value={m.smoothing}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0.25}
                  onChange={(v) => updateMapping(m.id, { smoothing: v })}
                />
                {/* v0.4A: -1..1, not 0..1. A CENTRED signal like Motion X
                    rests at 0.5, so it needs min -1 / max 1 for "still" to
                    contribute nothing — the output range is where polarity
                    lives, since the evaluator clamps every signal to 0..1. */}
                <ParameterSlider
                  label="Out min"
                  hint="min — the output when the signal is at its lowest (-1…1)"
                  value={m.min}
                  min={-1}
                  max={1}
                  step={0.01}
                  defaultValue={0}
                  onChange={(v) => updateMapping(m.id, { min: v })}
                />
                <ParameterSlider
                  label="Out max"
                  hint="max — the output when the signal is at its highest (-1…1)"
                  value={m.max}
                  min={-1}
                  max={1}
                  step={0.01}
                  defaultValue={1}
                  onChange={(v) => updateMapping(m.id, { max: v })}
                />
                {/* The input window narrows attention to the part of the
                    signal worth reacting to. It is NOT calibration: that
                    adapts a signal to its source automatically, this is a
                    choice about what to react to. */}
                <ParameterSlider
                  label="In min"
                  hint="inMin — the signal level that counts as 'nothing'. Raise it so only strong hits react."
                  value={m.inMin ?? 0}
                  min={0}
                  max={m.source === 'time.sec' ? timeRange : 1}
                  step={m.source === 'time.sec' ? 0.1 : 0.01}
                  {...(m.source === 'time.sec' ? { unit: 's' } : {})}
                  defaultValue={0}
                  onChange={(v) => updateMapping(m.id, { inMin: v })}
                />
                <ParameterSlider
                  label="In max"
                  hint="inMax — the signal level that counts as 'full'."
                  value={m.inMax ?? (m.source === 'time.sec' ? timeRange : 1)}
                  min={0}
                  max={m.source === 'time.sec' ? timeRange : 1}
                  step={m.source === 'time.sec' ? 0.1 : 0.01}
                  {...(m.source === 'time.sec' ? { unit: 's' } : {})}
                  defaultValue={m.source === 'time.sec' ? timeRange : 1}
                  onChange={(v) => updateMapping(m.id, { inMax: v })}
                />
                <div className="param-row">
                  <span className="param-label">Curve</span>
                  <div className="param-control">
                    <select
                      className="select"
                      value={m.curve}
                      onChange={(e) =>
                        updateMapping(m.id, { curve: e.target.value as typeof m.curve })
                      }
                    >
                      <option value="linear">Linear</option>
                      <option value="exponential">Exponential</option>
                      <option value="logarithmic">Logarithmic</option>
                    </select>
                  </div>
                </div>
                <div className="param-row">
                  <span className="param-label">Invert</span>
                  <div className="param-control">
                    <button
                      className={`toggle${m.invert ? ' on' : ''}`}
                      role="switch"
                      aria-checked={m.invert}
                      aria-label="Invert"
                      onClick={() => updateMapping(m.id, { invert: !m.invert })}
                    />
                  </div>
                </div>
                <TransferPreview mapping={m} />
                <ValueBreakdown mapping={m} />
                <div className="mod-actions">
                  {m.frozenValue === null ? (
                    <button className="vp-btn" onClick={() => freezeMapping(m.id)} title="Hold current value">
                      FREEZE
                    </button>
                  ) : (
                    <button className="vp-btn active" onClick={() => unfreezeMapping(m.id)}>
                      FROZEN {(m.frozenValue * 100).toFixed(0)}% — RELEASE
                    </button>
                  )}
                  <button className="vp-btn danger" onClick={() => deleteMapping(m.id)}>
                    DELETE
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="mod-add">
        <button
          className="vp-btn"
          onClick={() => addMapping('bass', targets[0]?.id ?? 'scale')}
          title="Add modulation mapping"
        >
          + ADD MAPPING
        </button>
      </div>
    </div>
  );
}

/**
 * §2 frozen-value inspector: BASE / MOD-or-FROZEN / PULSE / FINAL in the
 * target parameter's own units. Live at UI rate, imperative writes only.
 */
function ValueBreakdown({ mapping }: { mapping: ModulationMapping }) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useProjectStore((s) => s.project);
  const layerId = targetLayerOf(project, mapping);
  const layer = project.layers.find((entry) => entry.id === layerId);
  const technique = mapping.targetStageId
    ? layer?.techniqueChain.find((stage) => stage.id === mapping.targetStageId)
    : layer?.technique;

  useEffect(() => {
    if (!technique) return;
    const definition = getTechnique(technique.techniqueId);
    const def = definition
      ? allParams(definition).find(
          (p) => p.id === mapping.target && p.type === 'number' && p.modulatable,
        )
      : null;
    if (!def || def.type !== 'number') return;
    const span = def.max - def.min;

    const timer = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const t = playback.getTime();
      const base =
        typeof technique.params[mapping.target] === 'number'
          ? (technique.params[mapping.target] as number)
          : def.default;
      const shaped =
        mapping.frozenValue !== null
          ? mapping.frozenValue
          : (modulationRuntime.currentShapedValue(mapping.id) ?? 0);
      const modDelta = mapping.amount * shaped * span;
      const { triggers, ctx } = getTriggerState();
      let pulseDelta = 0;
      for (const trig of mapping.targetStageId ? [] : triggersForLayer(triggers, layerId, selectedLayerOf(useProjectStore.getState().project).id)) {
        if (trig.targetParam === mapping.target) {
          pulseDelta += pulseContribution(trig, t, ctx) * span;
        }
      }
      const final = Math.min(Math.max(base + modDelta + pulseDelta, def.min), def.max);
      const fmt = (v: number) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0));
      const modLabel = mapping.frozenValue !== null ? 'FROZEN' : 'MOD';
      el.textContent =
        `BASE ${fmt(base)}  ·  ${modLabel} ${modDelta >= 0 ? '+' : ''}${fmt(modDelta)}` +
        (pulseDelta !== 0 ? `  ·  PULSE ${pulseDelta >= 0 ? '+' : ''}${fmt(pulseDelta)}` : '') +
        `  ·  FINAL ${fmt(final)}`;
    }, 100);
    return () => clearInterval(timer);
  }, [mapping, technique, layerId]);

  return <div ref={ref} className="mod-breakdown mono" />;
}
