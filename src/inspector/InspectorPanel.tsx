import { useCallback, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { getTechnique, listTechniques } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import { groupParams } from './paramGroups';
import { ParameterSlider } from '@/components/ParameterSlider';
import { BUILTIN_MATERIALS } from '@/materials/builtins';
import { PresetBar } from './PresetBar';
import { ModulationSection } from './ModulationSection';
import { SignalScope } from './SignalScope';
import { TriggersSection } from './TriggersSection';
import { MidiSection } from './MidiSection';
import { MacrosSection } from './MacrosSection';
import { PatternsSection } from '@/patterns/PatternsSection';
import { MidiParamWrap } from './MidiParamWrap';
import type { ParamDef } from '@/techniques/types';
import { uid } from '@/utils/id';
import type { ParamValue } from '@shared/schemas/project';
import { techniqueNeedsTemporal } from '@/techniques/registry';
import { isLiveSource } from '@shared/schemas/project';
import { getGenerator } from '@/sources/generators/definitions';
import '@/components/parameter-slider.css';

export function InspectorPanel() {
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const material = useProjectStore((s) => s.project.material);
  const hasSource = useProjectStore((s) => s.project.composition.sourceId !== null);
  const liveSource = useProjectStore((s) => {
    const src = s.project.sources.find((x) => x.id === s.project.composition.sourceId);
    return src !== undefined && isLiveSource(src);
  });
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
  const generatorSource = useProjectStore((s) => {
    const src = s.project.sources.find((x) => x.id === s.project.composition.sourceId);
    return src && src.kind === 'generator' ? src : null;
  });
  const generatorDef = generatorSource ? getGenerator(generatorSource.generator) : null;
  // 18D: cameras deliver only the current frame — temporal techniques need
  // frame history that live capture does not accumulate yet (18F).
  const temporalOnLive =
    liveSource && technique !== null && techniqueNeedsTemporal(technique.techniqueId, technique.params);
  // Parameter ids currently driven by an enabled mapping.
  const modulatedTargets = new Set(modulations.filter((m) => m.enabled).map((m) => m.target));

  return (
    <>
      <div className="panel-header inspector-header">
        <span className="label">System</span>
        <span className="inspector-system-name">{definition ? definition.name : '—'}</span>
        <button
          className="inspector-browse"
          onClick={() => useUiStore.getState().toggleTechniques()}
          title="Browse techniques"
        >
          BROWSE
        </button>
      </div>
      <div className="panel-body">
        {temporalOnLive && (
          <div className="inspector-live-note">
            LIVE SOURCE — frame history accumulates in realtime from now.
            Not seekable; export stays disabled.
          </div>
        )}
        {!hasSource && (
          <div
            style={{
              padding: 'var(--sp-5) var(--sp-4)',
              color: 'var(--text-2)',
              fontSize: 'var(--text-sm)',
            }}
          >
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

            {/* CE1F: SOURCE parameters — a generator is a source, so its
                params get their own group, never blended into the technique's. */}
            {generatorSource && generatorDef && (
              <CollapsibleSection
                label="Source"
                count={
                  generatorDef.params.filter((p) => modulatedTargets.has(`source.${p.id}`)).length
                }
              >
                {generatorDef.params.map((param) => (
                  <ParamControl
                    key={param.id}
                    def={param}
                    value={generatorSource.params[param.id] ?? param.default}
                    modulated={modulatedTargets.has(`source.${param.id}`)}
                    onChange={(v) =>
                      useProjectStore.getState().apply((p) => ({
                        ...p,
                        sources: p.sources.map((s) =>
                          s.id === generatorSource.id && s.kind === 'generator'
                            ? { ...s, params: { ...s.params, [param.id]: v } }
                            : s,
                        ),
                      }))
                    }
                    onDragStart={beginTransient}
                    onDragEnd={commitTransient}
                  />
                ))}
              </CollapsibleSection>
            )}

            {groupParams(definition).map((group) => (
              <CollapsibleSection
                key={group.label}
                label={group.label}
                count={group.params.filter((p) => modulatedTargets.has(p.id)).length}
              >
                {group.params.map((param) => (
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

            <CollapsibleSection label="Signals" count={modulatedTargets.size}>
              <div className="inspector-group">
                <ModulationSection />
                <PatternsSection />
                <TriggersSection />
                <MacrosSection />
                <MidiSection />
              </div>
            </CollapsibleSection>

            {/* Closed by default on purpose: an open scope registers analysis
                demand of its own, so leaving it open would keep the GPU
                reducer running for a panel nobody is reading. */}
            <CollapsibleSection label="Signal Scope" count={0} defaultOpen={false}>
              <SignalScope />
            </CollapsibleSection>

            <CollapsibleSection label="Material" count={0}>
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
                      <option value="custom">Custom: {material.assetPath.split('/').pop()}</option>
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
            </CollapsibleSection>
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
  defaultOpen = true,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
