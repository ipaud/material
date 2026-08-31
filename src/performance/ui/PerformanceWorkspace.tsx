import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime, type MorphDuration } from '@/performance/morphRuntime';
import { isLookDirty } from '@/performance/lookCore';
import { pinCurrentLook } from '@/projects/lookActions';
import { performMacroValue, performToggleFreeze } from '@/performance/take/gestures';
import { midiEngine, useMidiStore } from '@/midi/midiEngine';
import { WebMidiTransport } from '@/midi/transport';
import {
  candidateRuntime,
  setMutationIntensity,
  toggleMutationLock,
  useCandidateStore,
} from '@/performance/candidateRuntime';
import type { MutationIntensity, MutationLocks } from '@/performance/mutation';
import {
  applyLookQuantized,
  firePad,
  morphToLookQuantized,
  renameMacro,
  resetMacro,
  setPerformanceQuantize,
} from '@/performance/performanceActions';
import type { Macro, QuantizeMode } from '@shared/schemas/project';
import './performance.css';

const QUANT_LABEL: Record<QuantizeMode, string> = {
  off: 'OFF',
  beat: 'BEAT',
  bar: 'BAR',
  '2bars': '2 BARS',
  '4bars': '4 BARS',
};

const DURATIONS: {
  id: '1beat' | '2beats' | '1bar' | '2bars' | '4bars';
  label: string;
  value: MorphDuration;
}[] = [
  { id: '1beat', label: '1 BEAT', value: { mode: 'beats', beats: 1 } },
  { id: '2beats', label: '2 BEATS', value: { mode: 'beats', beats: 2 } },
  { id: '1bar', label: '1 BAR', value: { mode: 'bars', bars: 1 } },
  { id: '2bars', label: '2 BARS', value: { mode: 'bars', bars: 2 } },
  { id: '4bars', label: '4 BARS', value: { mode: 'bars', bars: 4 } },
];

const PAD_KEYS = ['Z', 'X', 'C', 'V'];

// ---- LOOKS ------------------------------------------------------------

export function LooksStrip() {
  const looks = useProjectStore((s) => s.project.pinnedLooks);
  const activeLookId = useProjectStore((s) => s.project.activeLookId);
  const project = useProjectStore((s) => s.project);
  const morphTargetId = useUiStore((s) => s.perfMorphTargetId);
  const [queuedSlot, setQueuedSlot] = useState<number | null>(null);

  // Queued state from the ONE scheduler — polled at UI rate.
  useEffect(() => {
    const timer = setInterval(() => {
      const pending = liveScheduler.getPending().find((p) => p.mapping.action === 'applyLook');
      setQueuedSlot((prev) => {
        const next = pending?.mapping.lookSlot ?? null;
        return prev === next ? prev : next;
      });
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const activeLook = looks.find((l) => l.id === activeLookId) ?? null;
  const dirty = activeLook ? isLookDirty(project, activeLook) : false;
  const morphActive = morphRuntime.current;

  return (
    <div className="perf-looks" role="group" aria-label="Pinned looks">
      {Array.from({ length: 9 }, (_, i) => i + 1).map((slot) => {
        const look =
          looks.find((l) => l.id === activeLookId && l.slot === slot) ??
          looks.find((l) => l.slot === slot);
        const isActive = look != null && look.id === activeLookId;
        const isQueued = queuedSlot === slot;
        const isMorphTarget =
          look != null && (morphActive?.targetLookId === look.id || morphTargetId === look.id);
        return (
          <button
            key={slot}
            className={
              'perf-look' +
              (look ? '' : ' empty') +
              (isActive ? ' active' : '') +
              (isQueued ? ' queued' : '') +
              (isMorphTarget ? ' morph-target' : '')
            }
            disabled={!look}
            onClick={() => applyLookQuantized(slot)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (look) useUiStore.getState().setPerfMorphTarget(look.id);
            }}
            title={
              look
                ? `${look.label} — click applies (quantized), right-click sets morph target`
                : `Slot ${slot} empty — press P to pin`
            }
          >
            {look?.thumbnail ? (
              <img src={look.thumbnail} alt="" draggable={false} />
            ) : look ? (
              <span className="perf-look-blank" />
            ) : null}
            <span className="perf-look-line">
              <span className="perf-look-num mono">{slot}</span>
              <span className="perf-look-name">
                {look?.label ?? ''}
                {isActive && dirty && (
                  <span className="perf-dirty" title="Modified since apply">
                    {' '}
                    ●
                  </span>
                )}
              </span>
              {isQueued && <span className="perf-look-tag mono">QUEUED</span>}
              {isMorphTarget && !isQueued && (
                <span className="perf-look-tag morph mono">MORPH</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- MACROS -----------------------------------------------------------

export function MacrosStrip() {
  const macros = useProjectStore((s) => s.project.macros);
  if (macros.length === 0) {
    return (
      <div className="perf-macros empty-row">
        <span className="perf-hint">No macros — define them in BUILD (Inspector → Macros)</span>
      </div>
    );
  }
  return (
    <div className="perf-macros" role="group" aria-label="Performance macros">
      {macros.slice(0, 8).map((m) => (
        <MacroControl key={m.id} macro={m} />
      ))}
    </div>
  );
}

/** Engine status → performer word. 'waiting' is the pickup gap (§10). */
const MACRO_STATUS_LABEL: Record<string, string> = {
  live: 'LIVE',
  waiting: 'PICKUP',
  frozen: 'FROZEN',
  morph: 'MORPH',
  offline: 'OFFLINE',
};

function MacroControl({ macro }: { macro: Macro }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const midiMapping = useProjectStore((s) =>
    s.project.midiMappings.find((m) => m.targetType === 'macro' && m.targetParam === macro.id),
  );
  const midiStatus = useMidiStore((s) => (midiMapping ? s.status[midiMapping.id] : undefined));
  const dragging = useRef(false);

  const learn = async () => {
    setMenuOpen(false);
    if (!midiEngine.isRunning) {
      const ok = await midiEngine.start(new WebMidiTransport());
      if (!ok) return;
    }
    await midiEngine.startLearn({ targetType: 'macro', targetParam: macro.id }, macro.name);
  };

  const statusText = midiStatus ? (MACRO_STATUS_LABEL[midiStatus] ?? null) : null;

  return (
    <div
      className="perf-macro"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <div className="perf-macro-head">
        {renaming ? (
          <input
            className="perf-macro-rename mono"
            defaultValue={macro.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              renameMacro(macro.id, e.target.value);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                renameMacro(macro.id, (e.target as HTMLInputElement).value);
                setRenaming(false);
              }
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="perf-macro-name" onDoubleClick={() => setRenaming(true)}>
            {macro.name}
          </span>
        )}
        <span className="perf-macro-value mono">{macro.value.toFixed(2)}</span>
      </div>
      <div className="perf-macro-sub mono">
        {midiMapping ? (
          <span className={`perf-macro-midi${midiStatus === 'waiting' ? ' waiting' : ''}`}>
            CC{midiMapping.control}
            {statusText ? ` · ${statusText}` : ''}
            {midiStatus === 'waiting' ? ' ◌' : ''}
          </span>
        ) : (
          <span className="perf-macro-midi none">—</span>
        )}
      </div>
      <input
        type="range"
        className="perf-macro-slider"
        min={0}
        max={1}
        step={0.001}
        value={macro.value}
        aria-label={`Macro ${macro.name}`}
        onPointerDown={() => {
          dragging.current = true;
          useProjectStore.getState().beginTransient();
        }}
        onPointerUp={() => {
          if (dragging.current) {
            dragging.current = false;
            useProjectStore.getState().commitTransient();
          }
        }}
        onChange={(e) => performMacroValue(macro.id, Number(e.target.value))}
        onDoubleClick={() => resetMacro(macro.id)}
      />
      {menuOpen && (
        <>
          <div className="midi-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="midi-menu perf-macro-menu">
            <button onClick={() => void learn()}>MIDI Learn</button>
            <button
              onClick={() => {
                setRenaming(true);
                setMenuOpen(false);
              }}
            >
              Rename
            </button>
            <button
              onClick={() => {
                resetMacro(macro.id);
                setMenuOpen(false);
              }}
            >
              Reset to 0
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- ACTIONS ----------------------------------------------------------

export function ActionsStrip() {
  const anyFrozen = useProjectStore((s) =>
    s.project.modulations.some((m) => m.frozenValue !== null),
  );
  const quantize = useProjectStore((s) => s.project.performanceQuantize);
  const looks = useProjectStore((s) => s.project.pinnedLooks);
  const morphTargetId = useUiStore((s) => s.perfMorphTargetId);
  const durationId = useUiStore((s) => s.perfMorphDuration);
  const morphTarget = looks.find((l) => l.id === morphTargetId) ?? null;

  const launchMorph = () => {
    if (!morphTarget) return;
    const duration = DURATIONS.find((d) => d.id === durationId)?.value ?? {
      mode: 'bars' as const,
      bars: 1,
    };
    morphToLookQuantized(morphTarget.id, duration);
  };

  return (
    <div className="perf-actions">
      <div className="perf-group" role="group" aria-label="State">
        <span className="perf-group-label">STATE</span>
        <div className="perf-group-body">
          <button
            className={`perf-big-btn${anyFrozen ? ' engaged' : ''}`}
            onClick={() => performToggleFreeze()}
            title="Freeze/release all modulated values (F)"
          >
            {anyFrozen ? '■ FROZEN' : 'FREEZE'}
          </button>
          <button
            className="perf-big-btn quiet"
            onClick={() => void pinCurrentLook()}
            title="Pin current state as a Look (P)"
          >
            PIN
          </button>
        </div>
      </div>

      <div className="perf-group" role="group" aria-label="Morph">
        <span className="perf-group-label">MORPH</span>
        <div className="perf-group-body">
          <select
            className="select"
            value={morphTargetId ?? ''}
            onChange={(e) => useUiStore.getState().setPerfMorphTarget(e.target.value || null)}
            aria-label="Morph target look"
          >
            <option value="">TO…</option>
            {looks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.slot ? `${l.slot} · ` : ''}
                {l.label}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={durationId}
            onChange={(e) =>
              useUiStore.getState().setPerfMorphDuration(e.target.value as typeof durationId)
            }
            aria-label="Morph duration"
          >
            {DURATIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button
            className="perf-big-btn"
            disabled={!morphTarget}
            onClick={launchMorph}
            title="Launch morph (M)"
          >
            MORPH
          </button>
        </div>
      </div>

      <div className="perf-group" role="group" aria-label="Trigger pads">
        <span className="perf-group-label">PADS</span>
        <div className="perf-group-body">
          <Pads />
        </div>
      </div>

      <CandidateCluster />

      <div className="perf-group perf-group-sync" role="group" aria-label="Quantization">
        <span className="perf-group-label">SYNC</span>
        <div className="perf-group-body">
          {(Object.keys(QUANT_LABEL) as QuantizeMode[]).map((mode) => (
            <button
              key={mode}
              className={`perf-quant-btn${quantize === mode ? ' active' : ''}`}
              onClick={() => setPerformanceQuantize(mode)}
              title="Quantization for look apply, morph, pads and candidate (Q)"
            >
              {QUANT_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Pads() {
  const pads = useProjectStore((s) => s.project.performancePads);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Fire feedback stays imperative: a class pulse on a DOM event, no state.
  useEffect(() => {
    const onFire = (e: Event) => {
      const el = refs.current[(e as CustomEvent<string>).detail];
      if (!el) return;
      el.classList.remove('fired');
      void el.offsetWidth;
      el.classList.add('fired');
    };
    window.addEventListener('material:pad-fired', onFire);
    return () => window.removeEventListener('material:pad-fired', onFire);
  }, []);

  return (
    <>
      {pads.slice(0, 4).map((pad, i) => (
        <button
          key={pad.id}
          ref={(el) => {
            refs.current[pad.id] = el;
          }}
          className="perf-pad"
          disabled={!pad.trigger}
          onClick={() => firePad(pad.id)}
          aria-label={
            pad.trigger ? `Pad ${PAD_KEYS[i]}: ${pad.label}` : `Pad ${PAD_KEYS[i]} unassigned`
          }
          title={pad.trigger ? `${pad.label} (${PAD_KEYS[i]})` : 'Unassigned — set in BUILD'}
        >
          <span className="perf-pad-key mono">{PAD_KEYS[i]}</span>
          <span className="perf-pad-name">{pad.label}</span>
        </button>
      ))}
    </>
  );
}

// ---- CANDIDATE (compact live shortcut — full workflow lives in EXPLORE) --

const INTENSITIES: { value: MutationIntensity; label: string }[] = [
  { value: 'low', label: 'LOW' },
  { value: 'med', label: 'MED' },
  { value: 'high', label: 'HIGH' },
];

/** Locks the performer actually toggles; material/topology are structural. */
const LOCK_KEYS: { key: keyof MutationLocks; label: string }[] = [
  { key: 'technique', label: 'TECH' },
  { key: 'timing', label: 'TIME' },
  { key: 'color', label: 'COLOR' },
  { key: 'signals', label: 'SIG' },
];

export function CandidateCluster() {
  const candidate = useCandidateStore((s) => s.candidate);
  const previewing = useCandidateStore((s) => s.previewing);
  const queuedId = useCandidateStore((s) => s.queuedId);
  const intensity = useCandidateStore((s) => s.intensity);
  const locks = useCandidateStore((s) => s.locks);
  const morphing = morphRuntime.current !== null;

  if (!candidate) {
    return (
      <div className="perf-group perf-group-cand" role="group" aria-label="Candidate">
        <span className="perf-group-label">CANDIDATE</span>
        <div className="perf-group-body">
          <button
            className="perf-big-btn"
            onClick={() => candidateRuntime.generate()}
            disabled={morphing}
            title={
              morphing ? 'MUTATE unavailable during Morph' : 'Generate a candidate from CURRENT (G)'
            }
          >
            MUTATE
          </button>
          <span className="perf-cand-settings">
            {INTENSITIES.map((i) => (
              <button
                key={i.value}
                className={`perf-mini-btn${intensity === i.value ? ' active' : ''}`}
                onClick={() => setMutationIntensity(i.value)}
              >
                {i.label}
              </button>
            ))}
            <span className="perf-mini-sep" />
            {LOCK_KEYS.map((l) => (
              <button
                key={l.key}
                className={`perf-mini-btn${locks[l.key] ? ' active' : ''}`}
                onClick={() => toggleMutationLock(l.key)}
                title={locks[l.key] ? `${l.label} locked — mutation skips it` : `Lock ${l.label}`}
              >
                {locks[l.key] ? '■ ' : ''}
                {l.label}
              </button>
            ))}
          </span>
        </div>
      </div>
    );
  }

  const queued = queuedId === candidate.id;

  return (
    <div
      className={`perf-group perf-group-cand has-candidate${previewing ? ' previewing' : ''}`}
      role="group"
      aria-label="Candidate"
    >
      <span className="perf-group-label cand">CANDIDATE</span>
      <div className="perf-group-body">
        <span className="perf-cand-id">
          <span className="perf-cand-name mono">{candidate.label}</span>
          <span className="perf-cand-seed mono">
            GEN {candidate.metadata.generation}
            {queued && <span className="perf-cand-queued"> · QUEUED</span>}
            {previewing && <span className="perf-cand-previewing"> · ON OUTPUT</span>}
          </span>
        </span>
        <button
          className={`perf-big-btn cand-preview${previewing ? ' engaged-cand' : ''}`}
          onPointerDown={() => candidateRuntime.setPreview(true)}
          onPointerUp={() => candidateRuntime.setPreview(false)}
          onPointerLeave={() => candidateRuntime.setPreview(false)}
          title="Hold to audition the candidate on output (hold B)"
        >
          {previewing ? '◉ PREVIEWING' : 'B · HOLD'}
        </button>
        <button
          className="perf-big-btn"
          onClick={() => candidateRuntime.apply()}
          title="Apply the candidate (Enter; honors SYNC)"
        >
          APPLY
        </button>
        <button
          className="perf-big-btn quiet"
          onClick={() => candidateRuntime.generate({ fromCandidate: true })}
          title="Mutate again from this candidate (Shift+G)"
        >
          AGAIN
        </button>
        <button
          className="perf-big-btn quiet"
          onClick={() => candidateRuntime.pin()}
          title="Pin as a Look without changing output"
        >
          PIN
        </button>
        <button
          className="perf-big-btn quiet danger"
          onClick={() => candidateRuntime.discard()}
          title="Discard candidate (Backspace)"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
