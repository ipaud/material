import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { MOD_SOURCES } from '@/modulation/sources';

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
import {
  addMapping,
  clearAllFreezes,
  deleteMapping,
  freezeAll,
  freezeMapping,
  unfreezeMapping,
  updateMapping,
} from '@/modulation/modulationActions';
import { modulationRuntime } from '@/modulation/runtime';
import { getTriggerState } from '@/signals/triggerRuntime';
import { pulseContribution } from '@/signals/pulseEngine';
import { playback } from '@/playback/PlaybackController';
import { allParams } from '@/techniques/types';
import type { ModulationMapping } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { ParameterSlider } from '@/components/ParameterSlider';
import './modulation.css';

export function ModulationSection() {
  const mappings = useProjectStore((s) => s.project.modulations);
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const patternSources = useProjectStore((s) => s.project.patternSources);
  const [expanded, setExpanded] = useState<string | null>(null);

  const definition = technique ? getTechnique(technique.techniqueId) : null;
  if (!definition) return null;
  const targets = allParams(definition).filter((p) => p.type === 'number' && p.modulatable);

  const anyFrozen = mappings.some((m) => m.frozenValue !== null);

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span className="label">Modulation</span>
        <span className="section-count" style={{ display: 'flex', gap: 4 }}>
          <button
            className="vp-btn"
            title="Freeze all modulated targets at their current values (F)"
            onClick={() => freezeAll()}
          >
            FREEZE ALL
          </button>
          {anyFrozen && (
            <button className="vp-btn active" title="Clear all frozen values" onClick={() => clearAllFreezes()}>
              CLEAR
            </button>
          )}
        </span>
      </div>
      {mappings.map((m) => {
        const isOpen = expanded === m.id;
        const targetDef = targets.find((t) => t.id === m.target);
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
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span
                className="mod-amount mono"
                title={targetDef ? `Amount of ${targetDef.label} range` : 'Amount'}
              >
                {m.amount >= 0 ? '+' : ''}
                {m.amount.toFixed(2)}
              </span>
              <button className="vp-btn" onClick={() => setExpanded(isOpen ? null : m.id)}>
                {isOpen ? '−' : '⋯'}
              </button>
            </div>
            {isOpen && (
              <div className="mod-detail">
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
                  label="Min"
                  value={m.min}
                  min={-1}
                  max={1}
                  step={0.01}
                  defaultValue={0}
                  onChange={(v) => updateMapping(m.id, { min: v })}
                />
                <ParameterSlider
                  label="Max"
                  value={m.max}
                  min={-1}
                  max={1}
                  step={0.01}
                  defaultValue={1}
                  onChange={(v) => updateMapping(m.id, { max: v })}
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
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);

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
      for (const trig of triggers) {
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
  }, [mapping, technique]);

  return <div ref={ref} className="mod-breakdown mono" />;
}
