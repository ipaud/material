import { useCallback, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique, listTechniques } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import { ParameterSlider } from '@/components/ParameterSlider';
import { BUILTIN_MATERIALS } from '@/materials/builtins';
import { PresetBar } from './PresetBar';
import { ModulationSection } from './ModulationSection';
import { TriggersSection } from './TriggersSection';
import { MidiSection } from './MidiSection';
import { MidiParamWrap } from './MidiParamWrap';
import type { ParamDef } from '@/techniques/types';
import { uid } from '@/utils/id';
import type { ParamValue } from '@shared/schemas/project';
import '@/components/parameter-slider.css';

export function InspectorPanel() {
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const material = useProjectStore((s) => s.project.material);
  const hasSource = useProjectStore((s) => s.project.composition.sourceId !== null);
  const modulations = useProjectStore((s) => s.project.modulations);
  const apply = useProjectStore((s) => s.apply);
  const beginTransient = useProjectStore((s) => s.beginTransient);
  const commitTransient = useProjectStore((s) => s.commitTransient);

  const setParam = useCallback(
    (paramId: string, value: ParamValue) => {
      apply((p) => {
        const active = p.techniques.find((t) => t.enabled);
        if (!active) return p;
        return {
          ...p,
          techniques: p.techniques.map((t) =>
            t.id === active.id ? { ...t, params: { ...t.params, [paramId]: value } } : t,
          ),
        };
      });
    },
    [apply],
  );

  const setMaterial = useCallback(
    (patch: Partial<typeof material>) => {
      apply((p) => ({ ...p, material: { ...p.material, ...patch } }));
    },
    [apply],
  );

  const definition = technique ? getTechnique(technique.techniqueId) : null;
  // Parameter ids currently driven by an enabled mapping.
  const modulatedTargets = new Set(
    modulations.filter((m) => m.enabled).map((m) => m.target),
  );

  return (
    <>
      <div className="panel-header">
        <span className="label">{definition ? definition.name : 'Inspector'}</span>
      </div>
      <div className="panel-body">
        {!hasSource && (
          <div style={{ padding: 'var(--sp-5) var(--sp-4)', color: 'var(--text-2)', fontSize: 'var(--text-sm)' }}>
            Import a source to begin
          </div>
        )}
        {hasSource && definition && technique && (
          <>
            <PresetBar />
            <div className="inspector-section">
              <div className="param-row">
                <span className="param-label">Technique</span>
                <div className="param-control">
                  <select
                    className="select"
                    value={technique.techniqueId}
                    onChange={(e) => {
                      const next = getTechnique(e.target.value);
                      if (!next) return;
                      apply((p) => ({
                        ...p,
                        techniques: [
                          {
                            id: uid('tech'),
                            techniqueId: next.id,
                            enabled: true,
                            params: defaultParams(next),
                          },
                        ],
                        // Mappings target technique params; a switch invalidates them.
                        modulations: [],
                      }));
                    }}
                  >
                    {listTechniques().map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <ModulationSection />
            <TriggersSection />
            <MidiSection />
            <div className="inspector-section">
              <div className="inspector-section-header">
                <span className="label">Material</span>
              </div>
              <div className="param-row">
                <span className="param-label">Shape</span>
                <div className="param-control">
                  <select
                    className="select"
                    value={material.materialId}
                    onChange={(e) => setMaterial({ materialId: e.target.value })}
                  >
                    {BUILTIN_MATERIALS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                    {material.assetPath && (
                      <option value="custom">
                        Custom: {material.assetPath.split('/').pop()}
                      </option>
                    )}
                  </select>
                </div>
              </div>
              <div className="param-row">
                <span className="param-label">Color</span>
                <div className="param-control">
                  <select
                    className="select"
                    value={material.colorMode}
                    onChange={(e) =>
                      setMaterial({ colorMode: e.target.value as typeof material.colorMode })
                    }
                  >
                    <option value="source">From Source</option>
                    <option value="mono">Monochrome</option>
                    {material.materialId === 'custom' && (
                      <>
                        <option value="original">Original</option>
                        <option value="sourceColor">Source Tint</option>
                      </>
                    )}
                  </select>
                </div>
              </div>
              <ParameterSlider
                label="Aspect"
                value={typeof material.params.aspect === 'number' ? material.params.aspect : 1}
                min={0.1}
                max={4}
                step={0.01}
                defaultValue={1}
                onChange={(v) => setMaterial({ params: { ...material.params, aspect: v } })}
                onDragStart={beginTransient}
                onDragEnd={commitTransient}
              />
            </div>
            {definition.sections.map((section) => (
              <CollapsibleSection
                key={section.label}
                label={section.label}
                count={section.params.filter((p) => modulatedTargets.has(p.id)).length}
              >
                {section.params.map((param) => (
                  <MidiParamWrap key={param.id} paramId={param.id}>
                    <ParamControl
                      def={param}
                      value={technique.params[param.id] ?? param.default}
                      modulated={modulatedTargets.has(param.id)}
                      onChange={(v) => setParam(param.id, v)}
                      onDragStart={beginTransient}
                      onDragEnd={commitTransient}
                    />
                  </MidiParamWrap>
                ))}
              </CollapsibleSection>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function CollapsibleSection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="inspector-section">
      <button className="inspector-section-header" onClick={() => setOpen(!open)}>
        <span className={`section-chevron${open ? '' : ' collapsed'}`}>▼</span>
        <span className="label">{label}</span>
        {count > 0 && <span className="section-count">{count} MOD</span>}
      </button>
      {open && children}
    </div>
  );
}

function ParamControl({
  def,
  value,
  modulated,
  onChange,
  onDragStart,
  onDragEnd,
}: {
  def: ParamDef;
  value: ParamValue;
  modulated?: boolean;
  onChange: (value: ParamValue) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  if (def.type === 'number') {
    return (
      <ParameterSlider
        label={def.label}
        value={typeof value === 'number' ? value : def.default}
        min={def.min}
        max={def.max}
        step={def.step}
        defaultValue={def.default}
        {...(def.unit !== undefined ? { unit: def.unit } : {})}
        {...(modulated ? { modulated: true } : {})}
        onChange={onChange}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
    );
  }
  if (def.type === 'boolean') {
    const on = value === true;
    return (
      <div className="param-row">
        <span className="param-label">{def.label}</span>
        <div className="param-control">
          <button
            className={`toggle${on ? ' on' : ''}`}
            role="switch"
            aria-checked={on}
            aria-label={def.label}
            onClick={() => onChange(!on)}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="param-row">
      <span className="param-label">{def.label}</span>
      <div className="param-control">
        <select
          className="select"
          value={typeof value === 'string' ? value : def.default}
          onChange={(e) => onChange(e.target.value)}
        >
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
