import { EnvelopePreview } from './CurvePreview';
import { selectedLayerOf } from '@shared/schemas/project';
import { useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { ParameterSlider } from '@/components/ParameterSlider';
import { fireManualTrigger } from '@/signals/triggerRuntime';
import { playback } from '@/playback/PlaybackController';
import { uid } from '@/utils/id';
import type { TriggerAction, TriggerMapping } from '@shared/schemas/project';

const SOURCE_OPTIONS = [
  { value: 'beat', label: 'Beat' },
  { value: 'bar', label: 'Bar' },
  { value: 'div:1/2', label: '1/2' },
  { value: 'div:1/4', label: '1/4' },
  { value: 'div:1/8', label: '1/8' },
  { value: 'div:1/16', label: '1/16' },
  { value: 'onset', label: 'Onset' },
  { value: 'manual', label: 'Manual (live)' },
];

const ACTION_OPTIONS: { value: TriggerAction; label: string }[] = [
  { value: 'pulse', label: 'Pulse Parameter' },
  { value: 'freeze', label: 'Freeze' },
  { value: 'unfreeze', label: 'Unfreeze' },
  { value: 'toggleFreeze', label: 'Toggle Freeze' },
  { value: 'pinLook', label: 'Pin Current Look' },
  { value: 'applyLook', label: 'Apply Look N' },
  { value: 'morphToLook', label: 'Morph to Look N' },
  { value: 'nextLook', label: 'Next Look' },
  { value: 'prevLook', label: 'Previous Look' },
  { value: 'resetParam', label: 'Reset Parameter' },
  { value: 'toggleMapping', label: 'Toggle Mapping' },
];

const QUANTIZE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'beat', label: 'Next Beat' },
  { value: 'bar', label: 'Next Bar' },
  { value: '2bars', label: '2 Bars' },
  { value: '4bars', label: '4 Bars' },
];

function updateTrigger(id: string, patch: Partial<TriggerMapping>): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    triggers: p.triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
}

function deleteTrigger(id: string): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    triggers: p.triggers.filter((t) => t.id !== id),
  }));
}

function addTrigger(): void {
  const mapping: TriggerMapping = {
    id: uid('trig'),
    enabled: true,
    source: 'beat',
    action: 'pulse',
    targetParam: 'scale',
    targetMappingId: null,
    lookSlot: null,
    quantize: 'off',
    cooldownSec: 0,
    attackSec: 0,
    holdSec: 0.02,
    decaySec: 0.2,
    amount: 0.3,
    curve: 'easeOut',
  };
  useProjectStore.getState().apply((p) => ({ ...p, triggers: [...p.triggers, mapping] }));
}

export function TriggersSection() {
  const triggers = useProjectStore((s) => s.project.triggers);
  const markers = useProjectStore((s) => s.project.timeline.markers);
  const modulations = useProjectStore((s) => s.project.modulations);
  const layers = useProjectStore((s) => s.project.layers);
  const technique = useProjectStore((s) => selectedLayerOf(s.project).technique);
  const [expanded, setExpanded] = useState<string | null>(null);

  const definition = technique ? getTechnique(technique.techniqueId) : null;
  if (!definition) return null;
  const numericTargets = allParams(definition).filter(
    (p) => p.type === 'number' && p.modulatable,
  );

  const sourceOptions = [
    ...SOURCE_OPTIONS,
    ...markers.map((m) => ({ value: `marker:${m.id}`, label: `Marker · ${m.label}` })),
    // One option per group (explicit group, else the label): a single trigger for all of them.
    ...[...new Set(markers.map((m) => m.group ?? m.label))].map((g) => ({
      value: `group:${g}`,
      label: `Group · ${g} (${markers.filter((m) => (m.group ?? m.label) === g).length})`,
    })),
  ];

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span className="label">Triggers</span>
      </div>
      {triggers.map((t) => {
        const isOpen = expanded === t.id;
        return (
          <div key={t.id} className="mod-row-wrap">
            <div className="mod-row">
              <button
                className={`mod-enable${t.enabled ? ' on' : ''}`}
                title={t.enabled ? 'Disable' : 'Enable'}
                onClick={() => updateTrigger(t.id, { enabled: !t.enabled })}
              />
              <select aria-label="Trigger source"
                className="select mod-select"
                value={t.source}
                onChange={(e) => updateTrigger(t.id, { source: e.target.value })}
              >
                {sourceOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="mod-arrow">→</span>
              <select aria-label="Trigger action"
                className="select mod-select"
                value={t.action}
                onChange={(e) => updateTrigger(t.id, { action: e.target.value as TriggerAction })}
              >
                {ACTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {t.source === 'manual' && (
                <button
                  className="vp-btn"
                  title="Fire this trigger now (quantization applies)"
                  onClick={() => fireManualTrigger(t.id, playback.getTime())}
                >
                  FIRE
                </button>
              )}
              <button
                className="vp-btn"
                aria-label={isOpen ? 'Collapse trigger' : 'Expand trigger'}
                onClick={() => setExpanded(isOpen ? null : t.id)}
              >
                {isOpen ? '−' : '⋯'}
              </button>
            </div>
            {isOpen && (
              <div className="mod-detail">
                {t.action === 'pulse' && layers.length > 1 && (
                  <div className="param-row">
                    <span className="param-label">Layer</span>
                    <div className="param-control">
                      <select
                        className="select"
                        aria-label="Trigger layer"
                        title="Which layer this pulse drives. Other layers do not react to it."
                        value={t.targetLayerId ?? ''}
                        onChange={(e) => {
                          const targetLayerId = e.target.value;
                          useProjectStore.getState().apply((p) => ({
                            ...p,
                            triggers: p.triggers.map((x) => {
                              if (x.id !== t.id) return x;
                              const { targetLayerId: _drop, ...rest } = x;
                              return targetLayerId ? { ...rest, targetLayerId } : rest;
                            }),
                          }));
                        }}
                      >
                        <option value="">Primary layer</option>
                        {layers.map((l, i) => (
                          <option key={l.id} value={l.id}>
                            {l.name || `Layer ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {(t.action === 'pulse' || t.action === 'resetParam') && (
                  <div className="param-row">
                    <span className="param-label">Target</span>
                    <div className="param-control">
                      <select aria-label="Trigger target"
                        className="select"
                        value={t.targetParam ?? ''}
                        onChange={(e) => updateTrigger(t.id, { targetParam: e.target.value })}
                      >
                        {numericTargets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {(t.action === 'freeze' ||
                  t.action === 'unfreeze' ||
                  t.action === 'toggleFreeze' ||
                  t.action === 'toggleMapping') && (
                  <div className="param-row">
                    <span className="param-label">Mapping</span>
                    <div className="param-control">
                      <select aria-label="Trigger mapping"
                        className="select"
                        value={t.targetMappingId ?? '*'}
                        onChange={(e) => updateTrigger(t.id, { targetMappingId: e.target.value })}
                      >
                        {t.action !== 'toggleMapping' && <option value="*">All mappings</option>}
                        {modulations.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.source} → {m.target}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {(t.action === 'applyLook' || t.action === 'morphToLook') && (
                  <ParameterSlider
                    label="Look Slot"
                    value={t.lookSlot ?? 1}
                    min={1}
                    max={9}
                    step={1}
                    defaultValue={1}
                    onChange={(v) => updateTrigger(t.id, { lookSlot: Math.round(v) })}
                  />
                )}
                <div className="param-row">
                  <span className="param-label">Quantize</span>
                  <div className="param-control">
                    <select aria-label="Trigger quantize"
                      className="select"
                      value={t.quantize}
                      onChange={(e) =>
                        updateTrigger(t.id, { quantize: e.target.value as TriggerMapping['quantize'] })
                      }
                    >
                      {QUANTIZE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <ParameterSlider
                  label="Cooldown"
                  value={t.cooldownSec}
                  min={0}
                  max={4}
                  step={0.01}
                  defaultValue={0}
                  unit="s"
                  onChange={(v) => updateTrigger(t.id, { cooldownSec: v })}
                />
                {t.action === 'pulse' && (
                  <>
                    <ParameterSlider
                      label="Attack"
                      value={t.attackSec}
                      min={0}
                      max={0.5}
                      step={0.005}
                      defaultValue={0}
                      unit="s"
                      onChange={(v) => updateTrigger(t.id, { attackSec: v })}
                    />
                    <ParameterSlider
                      label="Hold"
                      value={t.holdSec}
                      min={0}
                      max={0.5}
                      step={0.005}
                      defaultValue={0.02}
                      unit="s"
                      onChange={(v) => updateTrigger(t.id, { holdSec: v })}
                    />
                    <ParameterSlider
                      label="Decay"
                      value={t.decaySec}
                      min={0}
                      max={2}
                      step={0.005}
                      defaultValue={0.2}
                      unit="s"
                      onChange={(v) => updateTrigger(t.id, { decaySec: v })}
                    />
                    <ParameterSlider
                      label="Amount"
                      value={t.amount}
                      min={-1}
                      max={1}
                      step={0.01}
                      defaultValue={0.3}
                      onChange={(v) => updateTrigger(t.id, { amount: v })}
                    />
                    <div className="param-row">
                      <span className="param-label">Curve</span>
                      <div className="param-control">
                        <select aria-label="Trigger curve"
                          className="select"
                          value={t.curve}
                          onChange={(e) =>
                            updateTrigger(t.id, { curve: e.target.value as TriggerMapping['curve'] })
                          }
                        >
                          <option value="linear">Linear</option>
                          <option value="exponential">Exponential</option>
                          <option value="easeOut">Ease Out</option>
                        </select>
                      </div>
                    </div>
                    <EnvelopePreview trigger={t} />
                  </>
                )}
                <div className="mod-actions">
                  <button className="vp-btn danger" onClick={() => deleteTrigger(t.id)}>
                    DELETE
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="mod-add">
        <button className="vp-btn" onClick={addTrigger} title="Add trigger mapping">
          + ADD TRIGGER
        </button>
      </div>
    </div>
  );
}
