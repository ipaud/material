import { useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { ParameterSlider } from '@/components/ParameterSlider';
import { addMacro, deleteMacro, renameMacro, setMacroValue } from '@/performance/performanceActions';
import type { Macro, MacroMapping } from '@shared/schemas/project';

/**
 * Macro design surface (BUILD). Perform shows the big controls; here
 * the fan-out is defined: which parameters, how much, which shape.
 */
export function MacrosSection() {
  const macros = useProjectStore((s) => s.project.macros);
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const definition = technique ? getTechnique(technique.techniqueId) : null;
  if (!definition) return null;
  const targets = allParams(definition).filter((p) => p.type === 'number' && p.modulatable);

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span className="label">Macros</span>
        <span className="section-count">
          {macros.length < 8 && (
            <button className="vp-btn" onClick={() => addMacro(`MACRO ${macros.length + 1}`)}>
              + ADD
            </button>
          )}
        </span>
      </div>
      {macros.map((macro) => {
        const isOpen = expanded === macro.id;
        return (
          <div key={macro.id} className="mod-row-wrap">
            <div className="mod-row">
              <input
                className="macro-name-input mono"
                value={macro.name}
                onChange={(e) => renameMacro(macro.id, e.target.value)}
                aria-label="Macro name"
              />
              <span className="mod-amount mono">{macro.value.toFixed(2)}</span>
              <span className="mod-amount mono" style={{ opacity: 0.6 }}>
                {macro.mappings.filter((m) => m.enabled).length}→
              </span>
              <button className="vp-btn" onClick={() => setExpanded(isOpen ? null : macro.id)}>
                {isOpen ? '−' : '⋯'}
              </button>
            </div>
            {isOpen && (
              <div className="mod-detail">
                <ParameterSlider
                  label="Value"
                  value={macro.value}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0}
                  onChange={(v) => setMacroValue(macro.id, v)}
                />
                {macro.mappings.map((mapping, index) => (
                  <MacroMappingRow
                    key={index}
                    macro={macro}
                    mapping={mapping}
                    index={index}
                    targets={targets.map((t) => ({ id: t.id, label: t.label }))}
                  />
                ))}
                <div className="mod-actions">
                  <button
                    className="vp-btn"
                    onClick={() => updateMacro(macro.id, (m) => ({
                      ...m,
                      mappings: [
                        ...m.mappings,
                        {
                          targetParam: targets[0]?.id ?? 'scale',
                          amount: 0.5,
                          min: 0,
                          max: 1,
                          invert: false,
                          curve: 'linear' as const,
                          enabled: true,
                        },
                      ],
                    }))}
                  >
                    + TARGET
                  </button>
                  <button className="vp-btn danger" onClick={() => deleteMacro(macro.id)}>
                    DELETE MACRO
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function updateMacro(id: string, updater: (m: Macro) => Macro): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    macros: p.macros.map((m) => (m.id === id ? updater(m) : m)),
  }));
}

function MacroMappingRow({
  macro,
  mapping,
  index,
  targets,
}: {
  macro: Macro;
  mapping: MacroMapping;
  index: number;
  targets: { id: string; label: string }[];
}) {
  const patch = (change: Partial<MacroMapping>) =>
    updateMacro(macro.id, (m) => ({
      ...m,
      mappings: m.mappings.map((x, i) => (i === index ? { ...x, ...change } : x)),
    }));
  const remove = () =>
    updateMacro(macro.id, (m) => ({
      ...m,
      mappings: m.mappings.filter((_, i) => i !== index),
    }));

  return (
    <div className="mod-row" style={{ paddingLeft: 4 }}>
      <button
        className={`mod-enable${mapping.enabled ? ' on' : ''}`}
        title={mapping.enabled ? 'Disable' : 'Enable'}
        onClick={() => patch({ enabled: !mapping.enabled })}
      />
      <select
        className="select mod-select"
        value={mapping.targetParam}
        onChange={(e) => patch({ targetParam: e.target.value })}
      >
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={mapping.amount}
        style={{ flex: 1 }}
        aria-label="Amount"
        onChange={(e) => patch({ amount: Number(e.target.value) })}
      />
      <span className="mod-amount mono">
        {mapping.amount >= 0 ? '+' : ''}
        {mapping.amount.toFixed(2)}
      </span>
      <button className="vp-btn danger" onClick={remove}>
        ✕
      </button>
    </div>
  );
}
