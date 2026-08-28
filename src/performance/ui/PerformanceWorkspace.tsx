import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
import { liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime, type MorphDuration } from '@/performance/morphRuntime';
import { isLookDirty } from '@/performance/lookCore';
import { modulationRuntime } from '@/modulation/runtime';
import { musicalPosition } from '@/audio/beatGrid';
import { tapTempoTap } from '@/audio/tempoActions';
import { pinCurrentLook } from '@/projects/lookActions';
import { toggleFreezeAll } from '@/modulation/modulationActions';
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
  setMacroValue,
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

const DURATIONS: { id: '1beat' | '2beats' | '1bar' | '2bars' | '4bars'; label: string; value: MorphDuration }[] = [
  { id: '1beat', label: '1 BEAT', value: { mode: 'beats', beats: 1 } },
  { id: '2beats', label: '2 BEATS', value: { mode: 'beats', beats: 2 } },
  { id: '1bar', label: '1 BAR', value: { mode: 'bars', bars: 1 } },
  { id: '2bars', label: '2 BARS', value: { mode: 'bars', bars: 2 } },
  { id: '4bars', label: '4 BARS', value: { mode: 'bars', bars: 4 } },
];

const PAD_KEYS = ['Z', 'X', 'C', 'V'];

export function PerformanceWorkspace() {
  const hud = useUiStore((s) => s.perfHud);
  return (
    <div className={`perf-strip${hud ? ' hud' : ''}`}>
      <LooksRow />
      <MacrosRow />
      {!hud && <ActionsRow />}
      <CandidateRow />
      <StatusRow compact={hud} />
    </div>
  );
}

// ---- LOOKS ------------------------------------------------------------

function LooksRow() {
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
        const look = looks.find((l) => l.id === activeLookId && l.slot === slot) ??
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
            <span className="perf-look-num mono">{slot}</span>
            {look?.thumbnail ? (
              <img src={look.thumbnail} alt="" draggable={false} />
            ) : (
              <span className="perf-look-blank" />
            )}
            <span className="perf-look-name">
              {look?.label ?? '—'}
              {isActive && dirty && <span className="perf-dirty" title="Modified since apply"> ●</span>}
            </span>
            {isQueued && <span className="perf-look-tag mono">QUEUED</span>}
            {isMorphTarget && !isQueued && <span className="perf-look-tag morph mono">MORPH</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- MACROS -----------------------------------------------------------

function MacrosRow() {
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

  return (
    <div className="perf-macro" onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}>
      <div className="perf-macro-head">
        {renaming ? (
          <input
            className="perf-macro-rename mono"
            defaultValue={macro.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={(e) => { renameMacro(macro.id, e.target.value); setRenaming(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { renameMacro(macro.id, (e.target as HTMLInputElement).value); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="perf-macro-name" onDoubleClick={() => setRenaming(true)}>
            {macro.name}
          </span>
        )}
        <span className="perf-macro-value mono">{macro.value.toFixed(2)}</span>
        {midiMapping && (
          <span className={`perf-macro-midi mono${midiStatus === 'waiting' ? ' waiting' : ''}`}>
            CC{midiMapping.control}
            {midiStatus === 'waiting' ? ' ◌' : ''}
          </span>
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
        onChange={(e) => setMacroValue(macro.id, Number(e.target.value))}
        onDoubleClick={() => resetMacro(macro.id)}
      />
      {menuOpen && (
        <>
          <div className="midi-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="midi-menu perf-macro-menu">
            <button onClick={() => void learn()}>MIDI Learn</button>
            <button onClick={() => { setRenaming(true); setMenuOpen(false); }}>Rename</button>
            <button onClick={() => { resetMacro(macro.id); setMenuOpen(false); }}>Reset to 0</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- ACTIONS ----------------------------------------------------------

function ActionsRow() {
  const anyFrozen = useProjectStore((s) => s.project.modulations.some((m) => m.frozenValue !== null));
  const quantize = useProjectStore((s) => s.project.performanceQuantize);
  const looks = useProjectStore((s) => s.project.pinnedLooks);
  const pads = useProjectStore((s) => s.project.performancePads);
  const morphTargetId = useUiStore((s) => s.perfMorphTargetId);
  const durationId = useUiStore((s) => s.perfMorphDuration);
  const morphTarget = looks.find((l) => l.id === morphTargetId) ?? null;

  const launchMorph = () => {
    if (!morphTarget) return;
    const duration = DURATIONS.find((d) => d.id === durationId)?.value ?? { mode: 'bars' as const, bars: 1 };
    morphToLookQuantized(morphTarget.id, duration);
  };

  return (
    <div className="perf-actions">
      <button
        className={`perf-big-btn${anyFrozen ? ' engaged' : ''}`}
        onClick={() => toggleFreezeAll()}
        title="Freeze/release all modulated values (F)"
      >
        {anyFrozen ? '■ FROZEN' : 'FREEZE'}
      </button>
      <button className="perf-big-btn" onClick={() => void pinCurrentLook()} title="Pin current state as a Look (P)">
        PIN
      </button>

      <div className="perf-morph-group">
        <select
          className="select"
          value={morphTargetId ?? ''}
          onChange={(e) => useUiStore.getState().setPerfMorphTarget(e.target.value || null)}
          aria-label="Morph target look"
        >
          <option value="">MORPH TO…</option>
          {looks.map((l) => (
            <option key={l.id} value={l.id}>
              {l.slot ? `[${l.slot}] ` : ''}
              {l.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={durationId}
          onChange={(e) => useUiStore.getState().setPerfMorphDuration(e.target.value as typeof durationId)}
          aria-label="Morph duration"
        >
          {DURATIONS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <button className="perf-big-btn" disabled={!morphTarget} onClick={launchMorph} title="Launch morph (M)">
          MORPH
        </button>
      </div>

      <div className="perf-pads">
        {pads.slice(0, 4).map((pad, i) => (
          <button
            key={pad.id}
            className="perf-pad"
            disabled={!pad.trigger}
            onClick={() => firePad(pad.id)}
            title={pad.trigger ? `${pad.label} (${PAD_KEYS[i]})` : 'Unassigned — set in BUILD'}
          >
            <span className="perf-pad-key mono">{PAD_KEYS[i]}</span>
            {pad.label}
          </button>
        ))}
      </div>

      <MutateButton />
      <div className="perf-quant" role="group" aria-label="Performance quantization">
        <span className="perf-quant-label">QUANT</span>
        {(Object.keys(QUANT_LABEL) as QuantizeMode[]).map((mode) => (
          <button
            key={mode}
            className={`perf-quant-btn${quantize === mode ? ' active' : ''}`}
            onClick={() => setPerformanceQuantize(mode)}
          >
            {QUANT_LABEL[mode]}
          </button>
        ))}
      </div>

    </div>
  );
}

// ---- STATUS -----------------------------------------------------------

function StatusRow({ compact }: { compact: boolean }) {
  const anyFrozen = useProjectStore((s) => s.project.modulations.some((m) => m.frozenValue !== null));
  const beatRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const metersRef = useRef<HTMLDivElement>(null);
  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const playing = usePlaybackStore((s) => s.playing);
  const midiDevices = useMidiStore((s) => s.devices);
  const midiAvailability = useMidiStore((s) => s.availability);
  const learn = useMidiStore((s) => s.learn);
  const offlineMappings = useProjectStore((s) => s.project.midiMappings.length);

  // Imperative UI-rate updates: beat readout + pulse, queue line, meters.
  useEffect(() => {
    let lastBeat = -1;
    const timer = setInterval(() => {
      const t = playback.getTime();
      const { project } = useProjectStore.getState();
      const { bpm: liveBpm, beatOffsetSec, beatsPerBar } = project.timeline;

      const beatEl = beatRef.current;
      if (beatEl) {
        if (liveBpm) {
          const pos = musicalPosition(t, liveBpm, beatOffsetSec, beatsPerBar);
          beatEl.textContent = `BAR ${String(pos.bar).padStart(3, '0')} · BEAT ${pos.beat} / ${beatsPerBar}`;
          const absBeat = pos.bar * beatsPerBar + pos.beat;
          if (absBeat !== lastBeat) {
            lastBeat = absBeat;
            beatEl.classList.remove('pulse');
            void beatEl.offsetWidth; // restart CSS animation
            beatEl.classList.add('pulse');
          }
        } else {
          beatEl.textContent = 'NO GRID — set BPM';
        }
      }

      const queueEl = queueRef.current;
      if (queueEl) {
        const pending = liveScheduler.getPending()[0];
        const morph = morphRuntime.current;
        if (pending && liveBpm) {
          const beatsLeft = ((pending.executeAt - t) * liveBpm) / 60;
          const what =
            pending.mapping.action === 'applyLook'
              ? `LOOK ${pending.mapping.lookSlot ?? '?'}`
              : pending.mapping.action.toUpperCase();
          queueEl.textContent = `${what} QUEUED → ${Math.max(beatsLeft, 0).toFixed(1)} BEATS`;
          queueEl.className = 'perf-queue mono queued';
        } else if (morph) {
          const raw = morphRuntime.progressAt(t) ?? 0;
          const remainingSec = Math.max(morph.endTime - t, 0);
          const remainingBars = liveBpm ? (remainingSec * liveBpm) / 60 / 4 : remainingSec;
          const blocks = Math.round(raw * 10);
          const unit = liveBpm ? 'BARS' : 'S';
          queueEl.textContent =
            raw === 0 && t < morph.startTime
              ? `MORPH → ${morph.targetLabel} STARTS IN ${(((morph.startTime - t) * (liveBpm ?? 60)) / 60).toFixed(1)} BEATS`
              : `MORPH → ${morph.targetLabel}  ${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${Math.round(raw * 100)}%  ${remainingBars.toFixed(1)} ${unit}`;
          queueEl.className = 'perf-queue mono morphing';
        } else {
          queueEl.textContent = '';
          queueEl.className = 'perf-queue mono';
        }
      }

      const metersEl = metersRef.current;
      if (metersEl) {
        const v = modulationRuntime.lastSourceValues;
        const bass = Math.round((v.bass ?? 0) * 8);
        const onset = (v.onset ?? 0) > 0.5;
        const beatOn = (v.beat ?? 0) > 0.5;
        metersEl.textContent = `BASS ${'▮'.repeat(bass)}${'▯'.repeat(8 - bass)}  ONSET ${onset ? '●' : '○'}  BEAT ${beatOn ? '●' : '○'}`;
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const midiLabel = learn
    ? 'LEARNING'
    : midiDevices.length > 0
      ? midiDevices[0]?.name
      : midiAvailability === 'ready' && offlineMappings > 0
        ? 'OFFLINE'
        : midiAvailability === 'ready'
          ? 'READY'
          : '—';
  const midiState = learn ? 'learning' : midiDevices.length > 0 ? 'on' : 'off';

  return (
    <div className={`perf-status${compact ? ' compact' : ''}`}>
      <button
        className="perf-transport"
        onClick={() => playback.toggle()}
        title="Play/Pause (Space)"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div ref={beatRef} className="perf-beat mono" />
      <span className="perf-bpm mono">
        {bpm ? `${bpm} BPM` : 'BPM —'}
        <button className="perf-tap" onClick={() => tapTempoTap()} title="Tap tempo">
          TAP
        </button>
      </span>
      <div ref={queueRef} className="perf-queue mono" />
      <div ref={metersRef} className="perf-meters mono" />
      {compact && anyFrozen && (
        <button className="perf-big-btn engaged perf-frozen-mini" onClick={() => toggleFreezeAll()}>
          ■ FROZEN
        </button>
      )}
      <span className={`perf-midi mono ${midiState}`} title="Live controls are not recorded — export replays deterministic timeline state only">
        MIDI <span className="perf-midi-dot" /> {midiLabel}
      </span>
    </div>
  );
}

// ---- CANDIDATE (Phase 16) ---------------------------------------------

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
  { key: 'signals', label: 'SIGNALS' },
];

function MutateButton() {
  const candidate = useCandidateStore((s) => s.candidate);
  const morphing = morphRuntime.current !== null;
  return (
    <button
      className="perf-big-btn"
      onClick={() => candidateRuntime.generate()}
      disabled={morphing}
      title={morphing ? 'MUTATE unavailable during Morph' : 'Generate a candidate from CURRENT (G)'}
    >
      {candidate ? 'REGENERATE' : 'MUTATE'}
    </button>
  );
}

function CandidateRow() {
  const candidate = useCandidateStore((s) => s.candidate);
  const previewing = useCandidateStore((s) => s.previewing);
  const queuedId = useCandidateStore((s) => s.queuedId);
  const intensity = useCandidateStore((s) => s.intensity);
  const locks = useCandidateStore((s) => s.locks);
  const activeLookId = useProjectStore((s) => s.project.activeLookId);
  const looks = useProjectStore((s) => s.project.pinnedLooks);
  const currentLabel = looks.find((l) => l.id === activeLookId)?.label ?? 'CURRENT STATE';

  if (!candidate) {
    return (
      <div className="perf-candidate empty">
        <span className="perf-cand-settings">
          <span className="perf-quant-label">MUTATION</span>
          {INTENSITIES.map((i) => (
            <button
              key={i.value}
              className={`perf-quant-btn${intensity === i.value ? ' active' : ''}`}
              onClick={() => setMutationIntensity(i.value)}
            >
              {i.label}
            </button>
          ))}
          <span className="perf-quant-label" style={{ marginLeft: 10 }}>LOCK</span>
          {LOCK_KEYS.map((l) => (
            <button
              key={l.key}
              className={`perf-quant-btn${locks[l.key] ? ' active' : ''}`}
              onClick={() => toggleMutationLock(l.key)}
              title={locks[l.key] ? `${l.label} locked — mutation skips it` : `Lock ${l.label}`}
            >
              {locks[l.key] ? '■ ' : ''}
              {l.label}
            </button>
          ))}
        </span>
      </div>
    );
  }

  const queued = queuedId === candidate.id;

  return (
    <div className={`perf-candidate${previewing ? ' previewing' : ''}`}>
      <div className="perf-cand-side">
        <span className="perf-cand-role mono">CURRENT</span>
        <span className="perf-cand-name">{currentLabel}</span>
      </div>

      <span className="perf-cand-arrow">→</span>

      <div className="perf-cand-card">
        {candidate.thumbnail ? (
          <img src={candidate.thumbnail} alt="" draggable={false} />
        ) : (
          <span className="perf-look-blank" />
        )}
        <div className="perf-cand-meta">
          <span className="perf-cand-role mono">CANDIDATE</span>
          <span className="perf-cand-name">{candidate.label}</span>
          <span className="perf-cand-seed mono">
            seed {candidate.seed} · gen {candidate.metadata.generation} ·{' '}
            {candidate.metadata.changedParams}p/{candidate.metadata.changedModulations}m
          </span>
        </div>
      </div>

      <div className="perf-cand-actions">
        <button
          className={`perf-big-btn${previewing ? ' engaged' : ''}`}
          onPointerDown={() => candidateRuntime.setPreview(true)}
          onPointerUp={() => candidateRuntime.setPreview(false)}
          onPointerLeave={() => candidateRuntime.setPreview(false)}
          title="Hold to audition the candidate on output (hold B)"
        >
          {previewing ? '◉ PREVIEWING' : 'PREVIEW'}
        </button>
        <button className="perf-big-btn" onClick={() => candidateRuntime.apply()}>
          APPLY
        </button>
        <button className="perf-big-btn" onClick={() => candidateRuntime.generate({ fromCandidate: true })} title="Mutate again from this candidate (Shift+M)">
          MUTATE AGAIN
        </button>
        <button className="perf-big-btn" onClick={() => candidateRuntime.pin()} title="Pin as a Look without changing output">
          PIN
        </button>
        <button
          className={`perf-big-btn${candidate.darkThumbnail ? ' engaged' : ''}`}
          onClick={() => candidateRuntime.rethumbnail()}
          title={
            candidate.darkThumbnail
              ? 'Thumbnail captured on a very dark frame — re-render from the current frame'
              : 'Re-render the thumbnail from the current frame'
          }
        >
          ⟳
        </button>
        <button className="perf-big-btn danger" onClick={() => candidateRuntime.discard()} title="Discard candidate (Backspace)">
          ✕
        </button>
      </div>

      {(previewing || queued) && (
        <span className={`perf-cand-state mono${previewing ? ' preview' : ' queued'}`}>
          {previewing ? 'PREVIEWING CANDIDATE' : 'CANDIDATE QUEUED'}
        </span>
      )}
    </div>
  );
}
