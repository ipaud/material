import { selectedLayerOf } from '@shared/schemas/project';
import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { midiEngine, useMidiStore, type MappingStatus } from '@/midi/midiEngine';
import { WebMidiTransport } from '@/midi/transport';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import type { MidiMapping, TriggerAction } from '@shared/schemas/project';
import './midi.css';

const NOTE_ACTIONS: { value: TriggerAction; label: string }[] = [
  { value: 'toggleFreeze', label: 'Freeze (toggle)' },
  { value: 'freeze', label: 'Freeze' },
  { value: 'unfreeze', label: 'Unfreeze' },
  { value: 'pinLook', label: 'Pin Look' },
  { value: 'applyLook', label: 'Apply Look N' },
  { value: 'morphToLook', label: 'Morph to Look N' },
  { value: 'nextLook', label: 'Next Look' },
  { value: 'prevLook', label: 'Prev Look' },
];

const STATUS_LABEL: Record<MappingStatus, string> = {
  live: 'LIVE',
  waiting: 'PICKUP',
  frozen: 'FROZEN',
  morph: 'MORPH',
  offline: 'OFFLINE',
  idle: '',
};

export function MidiSection() {
  const availability = useMidiStore((s) => s.availability);
  const devices = useMidiStore((s) => s.devices);
  const learn = useMidiStore((s) => s.learn);
  const statusById = useMidiStore((s) => s.status);
  const mappings = useProjectStore((s) => s.project.midiMappings);
  const macros = useProjectStore((s) => s.project.macros);

  // ESC cancels an armed learn (§5).
  useEffect(() => {
    if (!learn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') midiEngine.cancelLearn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [learn]);

  if (availability === 'idle' && mappings.length === 0) {
    return (
      <div className="inspector-section">
        <div className="inspector-section-header" style={{ cursor: 'default' }}>
          <span className="label">MIDI</span>
        </div>
        <div className="midi-enable-row">
          <button
            className="vp-btn"
            onClick={() => void midiEngine.start(new WebMidiTransport())}
          >
            ENABLE MIDI
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span className="label">MIDI</span>
        {availability === 'unavailable' && <span className="midi-unavailable">UNAVAILABLE</span>}
      </div>

      {devices.map((d) => (
        <div key={d.id} className="midi-device-row">
          <span className="midi-dot connected" />
          <span className="midi-device-name">{d.manufacturer ? `${d.manufacturer} · ` : ''}{d.name}</span>
        </div>
      ))}
      {devices.length === 0 && availability === 'ready' && (
        <div className="midi-device-row">
          <span className="midi-dot" />
          <span className="midi-device-name dim">No controller connected</span>
        </div>
      )}

      {learn && (
        <div className="midi-learn-banner mono">
          LEARNING {learn.label} — move a control / press a pad · ESC cancels
        </div>
      )}

      {mappings.map((m) => (
        <MappingRow
          key={m.id}
          mapping={m}
          status={statusById[m.id] ?? 'idle'}
          macroName={macros.find((macro) => macro.id === m.targetParam)?.name}
        />
      ))}

      <NoteLearnRow />
      <Diagnostics />
    </div>
  );
}

function mappingSourceLabel(m: MidiMapping): string {
  const ch = m.channel === null ? '' : ` ch${m.channel + 1}`;
  return m.messageType === 'cc' ? `CC ${m.control}${ch}` : `NOTE ${m.control}${ch}`;
}

function mappingTargetLabel(m: MidiMapping, macroName?: string): string {
  if (m.targetType === 'param') {
    const project = useProjectStore.getState().project;
    const layer = m.targetLayerId
      ? project.layers.find((entry) => entry.id === m.targetLayerId)
      : selectedLayerOf(project);
    const stage = m.targetStageId ? layer?.techniqueChain.find((entry) => entry.id === m.targetStageId) : null;
    const technique = stage ?? layer?.technique;
    const definition = technique ? getTechnique(technique.techniqueId) : null;
    const def = definition ? allParams(definition).find((p) => p.id === m.targetParam) : null;
    const stageLabel = stage ? `Stage ${(layer?.techniqueChain.findIndex((entry) => entry.id === stage.id) ?? -1) + 2} · ` : '';
    return `${stageLabel}${def?.label ?? m.targetParam ?? '?'}`;
  }
  if (m.targetType === 'macro') {
    return macroName ?? m.targetParam ?? '?';
  }
  const action = NOTE_ACTIONS.find((a) => a.value === m.action)?.label ?? m.action ?? '?';
  return m.lookSlot ? `${action.replace(' N', ` ${m.lookSlot}`)}` : action;
}

function MappingRow({
  mapping,
  status,
  macroName,
}: {
  mapping: MidiMapping;
  status: MappingStatus;
  macroName: string | undefined;
}) {
  const valueRef = useRef<HTMLSpanElement>(null);

  // Live activity, imperative at UI rate (§14) — no React churn per event.
  useEffect(() => {
    const timer = setInterval(() => {
      const el = valueRef.current;
      if (!el) return;
      const v = midiEngine.getLiveValue(mapping.id);
      el.textContent = v === null ? '' : v.toFixed(2);
      el.classList.toggle('active', v !== null);
    }, 120);
    return () => clearInterval(timer);
  }, [mapping.id]);

  const relearn = () => {
    void midiEngine.startLearn(
      mapping.targetType === 'param'
        ? {
            targetType: 'param',
            targetParam: mapping.targetParam ?? '',
            ...(mapping.targetLayerId ? { targetLayerId: mapping.targetLayerId } : {}),
            ...(mapping.targetStageId ? { targetStageId: mapping.targetStageId } : {}),
          }
        : mapping.targetType === 'macro'
          ? { targetType: 'macro', targetParam: mapping.targetParam ?? '' }
          : {
              targetType: 'triggerAction',
              action: mapping.action ?? 'toggleFreeze',
              lookSlot: mapping.lookSlot,
              targetMappingId: mapping.targetMappingId,
              quantize: mapping.quantize,
            },
      mappingTargetLabel(mapping, macroName),
    );
  };

  const remove = () => {
    useProjectStore.getState().apply((p) => ({
      ...p,
      midiMappings: p.midiMappings.filter((x) => x.id !== mapping.id),
    }));
  };

  const toggle = () => {
    useProjectStore.getState().apply((p) => ({
      ...p,
      midiMappings: p.midiMappings.map((x) =>
        x.id === mapping.id ? { ...x, enabled: !x.enabled } : x,
      ),
    }));
  };

  return (
    <div className={`midi-row${mapping.enabled ? '' : ' disabled'}`}>
      <button
        className={`mod-enable${mapping.enabled ? ' on' : ''}`}
        title={mapping.enabled ? 'Disable' : 'Enable'}
        onClick={toggle}
      />
      <span className="midi-src mono">{mappingSourceLabel(mapping)}</span>
      <span className="midi-arrow">→</span>
      <span className="midi-target">{mappingTargetLabel(mapping, macroName)}</span>
      <span ref={valueRef} className="midi-value mono" />
      <span className={`midi-status mono s-${status}`}>{STATUS_LABEL[status]}</span>
      <button className="vp-btn" title="Relearn" onClick={relearn}>
        ⟲
      </button>
      <button className="vp-btn danger" title="Delete mapping" onClick={remove}>
        ✕
      </button>
    </div>
  );
}

/** Bind a pad/note to a trigger action: pick the action, then press a pad. */
function NoteLearnRow() {
  const [action, setAction] = useState<TriggerAction>('toggleFreeze');
  const [lookSlot, setLookSlot] = useState(1);
  const [quantize, setQuantize] = useState<MidiMapping['quantize']>('off');
  const needsSlot = action === 'applyLook' || action === 'morphToLook';

  const arm = async () => {
    if (!midiEngine.isRunning) {
      const ok = await midiEngine.start(new WebMidiTransport());
      if (!ok) return;
    }
    const label = NOTE_ACTIONS.find((a) => a.value === action)?.label ?? action;
    await midiEngine.startLearn(
      {
        targetType: 'triggerAction',
        action,
        lookSlot: needsSlot ? lookSlot : null,
        targetMappingId: action === 'freeze' || action === 'unfreeze' || action === 'toggleFreeze' ? '*' : null,
        quantize,
      },
      label,
    );
  };

  return (
    <div className="midi-note-learn">
      <select className="select" value={action} onChange={(e) => setAction(e.target.value as TriggerAction)}>
        {NOTE_ACTIONS.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
      {needsSlot && (
        <select className="select midi-slot" value={lookSlot} onChange={(e) => setLookSlot(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
      <select
        className="select"
        value={quantize}
        onChange={(e) => setQuantize(e.target.value as MidiMapping['quantize'])}
        title="Quantize"
      >
        <option value="off">Immediate</option>
        <option value="beat">Next Beat</option>
        <option value="bar">Next Bar</option>
        <option value="2bars">2 Bars</option>
        <option value="4bars">4 Bars</option>
      </select>
      <button className="vp-btn" onClick={() => void arm()}>
        LEARN NOTE
      </button>
    </div>
  );
}

function Diagnostics() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const d = midiEngine.getDiagnostics();
      const cc = d.lastCc ? `CC${d.lastCc.control}=${d.lastCc.value}` : 'CC —';
      const note = d.lastNote ? `NOTE ${d.lastNote.note} v${d.lastNote.velocity}` : 'NOTE —';
      el.textContent = `${d.eventsPerSec}/s · ${cc} · ${note}${d.learnArmed ? ' · LEARN' : ''}`;
    }, 250);
    return () => clearInterval(timer);
  }, []);
  return <div ref={ref} className="midi-diag mono" />;
}
