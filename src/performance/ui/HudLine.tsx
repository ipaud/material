import { useEffect, useRef } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { playback } from '@/playback/PlaybackController';
import { liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { musicalPosition } from '@/audio/beatGrid';
import { toggleFreezeAll } from '@/modulation/modulationActions';
import { useMidiStore } from '@/midi/midiEngine';
import { useCandidateStore } from '@/performance/candidateRuntime';

/**
 * HUD (Tab): the confidence line under an almost-fullscreen output. Look,
 * position, BPM, queue — plus the trust-critical states: FROZEN stays a
 * working control (§32), and candidate audition stays labelled (§33).
 */
export function HudLine() {
  const posRef = useRef<HTMLSpanElement>(null);
  const queueRef = useRef<HTMLSpanElement>(null);
  const project = useProjectStore((s) => s.project);
  const previewing = useCandidateStore((s) => s.previewing);
  const candidate = useCandidateStore((s) => s.candidate);
  const midiDevices = useMidiStore((s) => s.devices);
  const anyFrozen = project.modulations.some((m) => m.frozenValue !== null);
  const activeLook = project.activeLookId
    ? (project.pinnedLooks.find((l) => l.id === project.activeLookId) ?? null)
    : null;

  useEffect(() => {
    const timer = setInterval(() => {
      const t = playback.getTime();
      const { bpm, beatOffsetSec, beatsPerBar } = useProjectStore.getState().project.timeline;
      const posEl = posRef.current;
      if (posEl) {
        if (bpm) {
          const pos = musicalPosition(t, bpm, beatOffsetSec, beatsPerBar);
          posEl.textContent = `BAR ${String(pos.bar).padStart(3, '0')} · ${pos.beat}/${beatsPerBar} · ${bpm} BPM`;
        } else {
          posEl.textContent = 'NO GRID';
        }
      }
      const queueEl = queueRef.current;
      if (queueEl) {
        const pending = liveScheduler.getPending()[0];
        const morph = morphRuntime.current;
        queueEl.textContent = pending
          ? pending.mapping.action === 'applyLook'
            ? `LOOK ${pending.mapping.lookSlot ?? '?'} QUEUED`
            : `${pending.mapping.action === 'applyCandidate' ? 'CANDIDATE' : pending.mapping.action.toUpperCase()} QUEUED`
          : morph
            ? `MORPH → ${morph.targetLabel} ${Math.round((morphRuntime.progressAt(t) ?? 0) * 100)}%`
            : '';
      }
    }, 150);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="hud-line">
      <span className="hud-look mono">
        {activeLook
          ? `${activeLook.slot != null ? `${activeLook.slot} · ` : ''}${activeLook.label}`
          : 'NO LOOK'}
      </span>
      <span ref={posRef} className="hud-pos mono" />
      <span ref={queueRef} className="hud-queue mono" />
      <span className="hud-spacer" />
      {previewing && candidate && (
        <span className="hud-chip preview mono">PREVIEWING CANDIDATE</span>
      )}
      {anyFrozen && (
        <button
          className="hud-chip frozen mono"
          onClick={() => toggleFreezeAll()}
          title="Release all frozen values (F)"
        >
          ■ FROZEN
        </button>
      )}
      <span className={`hud-midi mono${midiDevices.length > 0 ? ' on' : ''}`}>
        <span className="perf-midi-dot" />
        MIDI
      </span>
      <span className="hud-hint mono">TAB EXIT HUD</span>
    </div>
  );
}
