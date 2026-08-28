import { useEffect, useRef } from 'react';
import { useAudioStore } from '@/state/audioStore';
import { useProjectStore } from '@/state/projectStore';
import { sampleTrack, type TrackId } from '@/audio/analysis';
import { divisionPhase, musicalPosition } from '@/audio/beatGrid';
import { playback } from '@/playback/PlaybackController';

const CONTINUOUS: { id: TrackId; label: string }[] = [
  { id: 'master', label: 'MASTER' },
  { id: 'rms', label: 'RMS' },
  { id: 'peak', label: 'PEAK' },
  { id: 'bass', label: 'BASS' },
  { id: 'mids', label: 'MIDS' },
  { id: 'highs', label: 'HIGHS' },
  { id: 'centroid', label: 'CENTROID' },
  { id: 'flux', label: 'FLUX' },
  { id: 'onset', label: 'ONSET' },
];

/** Live signal monitor (§26) — a creative debugging tool, not decoration. */
export function SignalMonitor() {
  const analysis = useAudioStore((s) => s.analysis);
  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const beatOffsetSec = useProjectStore((s) => s.project.timeline.beatOffsetSec);
  const beatsPerBar = useProjectStore((s) => s.project.timeline.beatsPerBar);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = playback.getTime();
      for (const row of CONTINUOUS) {
        const el = rowRefs.current[row.id];
        if (!el) continue;
        // With no analysis loaded the bars must read zero, not freeze at the
        // previous track's last values.
        const v = analysis ? sampleTrack(analysis, row.id, t) : 0;
        const bar = el.querySelector('.sig-bar-fill') as HTMLElement | null;
        const num = el.querySelector('.sig-value') as HTMLElement | null;
        if (bar) bar.style.transform = `scaleX(${Math.max(v, 0.01)})`;
        if (num) num.textContent = v.toFixed(2);
      }
      if (!bpm) {
        // Clear imperative writes when the grid disappears — React never
        // re-commits these nodes, so stale dots/phase would stick forever.
        rowRefs.current.beat?.classList.remove('on');
        rowRefs.current.bar?.classList.remove('on');
        const phaseEl = rowRefs.current.phase;
        if (phaseEl) phaseEl.textContent = '—';
        const posEl = rowRefs.current.position;
        if (posEl) posEl.textContent = 'SET BPM FOR BEAT SIGNALS';
      }
      if (bpm) {
        const beatEl = rowRefs.current.beat;
        const barEl = rowRefs.current.bar;
        const phaseEl = rowRefs.current.phase;
        const beatPhase = divisionPhase(t, bpm, beatOffsetSec, '1/4', beatsPerBar);
        const barPhase = divisionPhase(t, bpm, beatOffsetSec, 'bar', beatsPerBar);
        if (beatEl) beatEl.classList.toggle('on', beatPhase < 0.15);
        if (barEl) barEl.classList.toggle('on', barPhase < 0.15 / beatsPerBar);
        if (phaseEl) phaseEl.textContent = beatPhase.toFixed(2);
        const posEl = rowRefs.current.position;
        if (posEl) {
          const pos = musicalPosition(t, bpm, beatOffsetSec, beatsPerBar);
          posEl.textContent = `BAR ${pos.bar} · BEAT ${pos.beat}`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analysis, bpm, beatOffsetSec, beatsPerBar]);

  return (
    <div className="signal-monitor mono">
      <div className="label">Signals</div>
      {CONTINUOUS.map((row) => (
        <div
          key={row.id}
          className="sig-row"
          ref={(el) => {
            rowRefs.current[row.id] = el;
          }}
        >
          <span className="sig-label">{row.label}</span>
          <span className="sig-bar">
            <span className="sig-bar-fill" />
          </span>
          <span className="sig-value">0.00</span>
        </div>
      ))}
      <div className="sig-row sig-triggers">
        <span className="sig-label">BEAT</span>
        <span
          className="sig-dot"
          ref={(el) => {
            rowRefs.current.beat = el;
          }}
        />
        <span className="sig-label">BAR</span>
        <span
          className="sig-dot"
          ref={(el) => {
            rowRefs.current.bar = el;
          }}
        />
        <span className="sig-label">PHASE</span>
        <span
          className="sig-value"
          ref={(el) => {
            rowRefs.current.phase = el;
          }}
        >
          —
        </span>
      </div>
      <div
        className="sig-position"
        ref={(el) => {
          rowRefs.current.position = el;
        }}
      >
        {bpm ? '' : 'SET BPM FOR BEAT SIGNALS'}
      </div>
    </div>
  );
}
