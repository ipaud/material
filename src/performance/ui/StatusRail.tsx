import { useEffect, useRef } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
import { liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { modulationRuntime } from '@/modulation/runtime';
import { musicalPosition } from '@/audio/beatGrid';
import { tapTempoTap } from '@/audio/tempoActions';
import { useMidiStore } from '@/midi/midiEngine';

/**
 * Right-side status rail: BAR is the biggest readout in PERFORM; below it
 * beat, BPM/TAP, the queue line, the three live signals and MIDI. All
 * per-frame text is written imperatively at UI rate — no React on the
 * audio-rate path.
 */
export function StatusRail() {
  const barRef = useRef<HTMLDivElement>(null);
  const beatRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const bassRef = useRef<HTMLSpanElement>(null);
  const onsetRef = useRef<HTMLSpanElement>(null);
  const beatDotRef = useRef<HTMLSpanElement>(null);

  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const playing = usePlaybackStore((s) => s.playing);
  const midiDevices = useMidiStore((s) => s.devices);
  const midiAvailability = useMidiStore((s) => s.availability);
  const learn = useMidiStore((s) => s.learn);
  const mappingCount = useProjectStore((s) => s.project.midiMappings.length);

  useEffect(() => {
    let lastBeat = -1;
    const timer = setInterval(() => {
      const t = playback.getTime();
      const { project } = useProjectStore.getState();
      const { bpm: liveBpm, beatOffsetSec, beatsPerBar } = project.timeline;

      const barEl = barRef.current;
      const beatEl = beatRef.current;
      if (barEl && beatEl) {
        if (liveBpm) {
          const pos = musicalPosition(t, liveBpm, beatOffsetSec, beatsPerBar);
          barEl.textContent = String(pos.bar).padStart(3, '0');
          beatEl.textContent = `${pos.beat} / ${beatsPerBar}`;
          const absBeat = pos.bar * beatsPerBar + pos.beat;
          if (absBeat !== lastBeat) {
            lastBeat = absBeat;
            beatEl.classList.remove('pulse');
            void beatEl.offsetWidth; // restart CSS animation
            beatEl.classList.add('pulse');
          }
        } else {
          barEl.textContent = '———';
          beatEl.textContent = 'NO GRID';
        }
      }

      // Queue / morph line — copy per §24: WHAT → WHEN.
      const queueEl = queueRef.current;
      if (queueEl) {
        const pendings = liveScheduler.getPending();
        const pending = pendings[0];
        const morph = morphRuntime.current;
        if (pending && liveBpm) {
          const beatsLeft = Math.max(((pending.executeAt - t) * liveBpm) / 60, 0);
          const what =
            pending.mapping.action === 'applyLook'
              ? `LOOK ${pending.mapping.lookSlot ?? '?'}`
              : pending.mapping.action === 'applyCandidate'
                ? 'CANDIDATE'
                : pending.mapping.action.toUpperCase();
          const extra = pendings.length > 1 ? `  +${pendings.length - 1} QUEUED` : '';
          queueEl.textContent = `${what} → ${beatsLeft.toFixed(1)} BEATS${extra}`;
          queueEl.className = 'rail-queue mono queued';
        } else if (morph) {
          const raw = morphRuntime.progressAt(t) ?? 0;
          const remainingSec = Math.max(morph.endTime - t, 0);
          const remainingBars = liveBpm ? (remainingSec * liveBpm) / 60 / 4 : remainingSec;
          const unit = liveBpm ? 'BARS' : 'S';
          queueEl.textContent =
            raw === 0 && t < morph.startTime
              ? `MORPH → ${morph.targetLabel}\nSTARTS IN ${(((morph.startTime - t) * (liveBpm ?? 60)) / 60).toFixed(1)} BEATS`
              : `MORPH → ${morph.targetLabel}\n${Math.round(raw * 100)}% · ${remainingBars.toFixed(1)} ${unit} LEFT`;
          queueEl.className = 'rail-queue mono morphing';
        } else {
          queueEl.textContent = '';
          queueEl.className = 'rail-queue mono';
        }
      }

      // Signals: bass level + onset/beat dots, imperative.
      const v = modulationRuntime.lastSourceValues ?? {};
      const bassEl = bassRef.current;
      if (bassEl) {
        const n = Math.round((v.bass ?? 0) * 8);
        bassEl.textContent = '▮'.repeat(n) + '▯'.repeat(8 - n);
      }
      onsetRef.current?.classList.toggle('on', (v.onset ?? 0) > 0.5);
      // `beat` is not an emitted id — the grid sources are `beat:1/4` etc.,
      // so this dot never lit. The quarter-note phase ramps 0..1, and the
      // dot should read as ON just after the beat.
      beatDotRef.current?.classList.toggle('on', (v['beat:1/4'] ?? 1) < 0.25);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const midiLabel = learn
    ? 'LEARNING…'
    : midiDevices.length > 0
      ? (midiDevices[0]?.name ?? 'DEVICE')
      : midiAvailability === 'ready' && mappingCount > 0
        ? 'OFFLINE'
        : midiAvailability === 'ready'
          ? 'NO DEVICE'
          : '—';
  const midiState = learn ? 'learning' : midiDevices.length > 0 ? 'on' : 'off';

  return (
    <aside className="perf-rail" aria-label="Performance status">
      <div className="rail-block rail-position">
        <span className="rail-mini-label">BAR</span>
        <div ref={barRef} className="rail-bar mono">
          ———
        </div>
        <div ref={beatRef} className="rail-beat mono">
          —
        </div>
      </div>

      <div className="rail-block">
        <div className="rail-bpm-row">
          <span className="rail-bpm mono">{bpm ? `${bpm} BPM` : 'BPM —'}</span>
          <button className="rail-tap" onClick={() => tapTempoTap()} title="Tap tempo">
            TAP
          </button>
          <button
            className="rail-transport"
            onClick={() => playback.toggle()}
            title="Play/Pause (Space)"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
        </div>
      </div>

      <div ref={queueRef} className="rail-queue mono" aria-live="polite" />

      <div className="rail-block rail-signals">
        <span className="rail-mini-label">SIGNALS</span>
        <div className="rail-sig mono">
          <span className="rail-sig-name">BASS</span>
          <span ref={bassRef} className="rail-sig-bar">
            ▯▯▯▯▯▯▯▯
          </span>
        </div>
        <div className="rail-sig mono">
          <span className="rail-sig-name">ONSET</span>
          <span ref={onsetRef} className="rail-sig-dot" />
        </div>
        <div className="rail-sig mono">
          <span className="rail-sig-name">BEAT</span>
          <span ref={beatDotRef} className="rail-sig-dot" />
        </div>
      </div>

      <div className="rail-block rail-midi-block">
        <span className="rail-mini-label">MIDI</span>
        <span
          className={`rail-midi mono ${midiState}`}
          title="Live controls are not recorded — export replays deterministic timeline state only"
        >
          <span className="perf-midi-dot" />
          {midiLabel}
        </span>
        {midiDevices.length === 0 && mappingCount > 0 && (
          <span className="rail-midi-note">MAPPINGS RETAINED</span>
        )}
      </div>
    </aside>
  );
}
