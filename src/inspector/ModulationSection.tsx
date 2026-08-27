import { useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { MOD_SOURCES } from '@/modulation/sources';
import {
  addMapping,
  deleteMapping,
  freezeMapping,
  unfreezeMapping,
  updateMapping,
} from '@/modulation/modulationActions';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { ParameterSlider } from '@/components/ParameterSlider';
import './modulation.css';

export function ModulationSection() {
  const mappings = useProjectStore((s) => s.project.modulations);
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const definition = technique ? getTechnique(technique.techniqueId) : null;
  if (!definition) return null;
  const targets = allParams(definition).filter((p) => p.type === 'number' && p.modulatable);

  return (
    <div className="inspector-section">
      <div className="inspector-section-header">
        <span className="label">Modulation</span>
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
                {MOD_SOURCES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
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
                <ParameterSlider
                  label="Min"
                  value={m.min}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0}
                  onChange={(v) => updateMapping(m.id, { min: v })}
                />
                <ParameterSlider
                  label="Max"
                  value={m.max}
                  min={0}
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
