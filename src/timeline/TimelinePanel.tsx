import { useCallback, useEffect, useRef } from 'react';
import { usePlaybackStore } from '@/state/playbackStore';
import { useAudioStore } from '@/state/audioStore';
import { useProjectStore } from '@/state/projectStore';
import { playback } from '@/playback/PlaybackController';
import { beatTimes, musicalPosition } from '@/audio/beatGrid';
import { runTempoDetection, tapTempoTap } from '@/audio/tempoActions';
import { useUiStore } from '@/state/uiStore';
import { Meters } from './Meters';
import './timeline.css';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export function TimelinePanel() {
  const playing = usePlaybackStore((s) => s.playing);
  const timeSec = usePlaybackStore((s) => s.timeSec);
  const durationSec = usePlaybackStore((s) => s.durationSec);
  const loop = usePlaybackStore((s) => s.loop);
  const audioLoading = useAudioStore((s) => s.loading);
  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const beatOffsetSec = useProjectStore((s) => s.project.timeline.beatOffsetSec);
  const beatsPerBar = useProjectStore((s) => s.project.timeline.beatsPerBar);
  const analysisReady = useAudioStore((s) => s.analysis !== null);
  const showBeatGrid = useUiStore((s) => s.showBeatGrid);
  const toggleBeatGrid = useUiStore((s) => s.toggleBeatGrid);
  const showSignalMonitor = useUiStore((s) => s.showSignalMonitor);
  const toggleSignalMonitor = useUiStore((s) => s.toggleSignalMonitor);
  const apply = useProjectStore((s) => s.apply);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)
        return;
      e.preventDefault();
      playback.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const seekToPointer = useCallback(
    (e: React.PointerEvent) => {
      const track = trackRef.current;
      if (!track || durationSec === 0) return;
      const rect = track.getBoundingClientRect();
      const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      playback.seek(frac * durationSec);
    },
    [durationSec],
  );

  if (durationSec === 0 && !audioLoading) {
    return (
      <div className="timeline-empty">
        <span className="label">Timeline — add a video or audio source</span>
      </div>
    );
  }

  const frac = durationSec > 0 ? timeSec / durationSec : 0;

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button className="vp-btn" onClick={() => playback.toggle()} title="Play/Pause (Space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          className={`vp-btn${loop ? ' active' : ''}`}
          onClick={() => playback.setLoop(!loop)}
          title="Loop"
        >
          LOOP
        </button>
        <span className="vp-readout mono">{formatTime(timeSec)}</span>
        <span className="vp-readout mono dim">/ {formatTime(durationSec)}</span>
        {bpm && (
          <span className="vp-readout mono musical-pos">
            {(() => {
              const pos = musicalPosition(timeSec, bpm, beatOffsetSec, beatsPerBar);
              return `BAR ${pos.bar} · BEAT ${pos.beat}`;
            })()}
          </span>
        )}
        {audioLoading && <span className="vp-readout">analyzing audio…</span>}
        <span className="timeline-spacer" />
        <button
          className="vp-btn"
          onClick={() => runTempoDetection()}
          disabled={!analysisReady}
          title="Detect BPM and beat offset from the audio (advisory — you can always type over it)"
        >
          DETECT
        </button>
        <button className="vp-btn" onClick={() => tapTempoTap()} title="Tap tempo — tap on the beat">
          TAP
        </button>
        <button
          className={`vp-btn${showBeatGrid ? ' active' : ''}`}
          onClick={toggleBeatGrid}
          title="Toggle beat grid"
        >
          GRID
        </button>
        <button
          className={`vp-btn${showSignalMonitor ? ' active' : ''}`}
          onClick={toggleSignalMonitor}
          title="Live signal monitor"
        >
          SIG
        </button>
        <span className="label">BPM</span>
        <input
          className="timeline-num mono"
          type="number"
          min={20}
          max={300}
          step={0.1}
          value={bpm ?? ''}
          placeholder="—"
          onChange={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            apply((p) => ({
              ...p,
              timeline: { ...p.timeline, bpm: v !== null && Number.isFinite(v) && v > 0 ? v : null },
            }));
          }}
          title="Manual BPM (empty = no beat grid)"
        />
        <span className="label">OFFSET</span>
        <input
          className="timeline-num mono"
          type="number"
          step={0.01}
          value={beatOffsetSec}
          onChange={(e) => {
            const v = Number(e.target.value);
            apply((p) => ({
              ...p,
              timeline: { ...p.timeline, beatOffsetSec: Number.isFinite(v) ? v : 0 },
            }));
          }}
          title="Beat-1 offset in seconds"
        />
        <span className="label">/BAR</span>
        <input
          className="timeline-num mono timeline-num-narrow"
          type="number"
          min={1}
          max={12}
          step={1}
          value={beatsPerBar}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            apply((p) => ({
              ...p,
              timeline: {
                ...p.timeline,
                beatsPerBar: Number.isFinite(v) ? Math.min(Math.max(v, 1), 12) : 4,
              },
            }));
          }}
          title="Beats per bar (time signature numerator)"
        />
        <Meters />
      </div>
      <div
        ref={trackRef}
        className="timeline-track"
        onPointerDown={(e) => {
          scrubbing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekToPointer(e);
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) seekToPointer(e);
        }}
        onPointerUp={() => {
          scrubbing.current = false;
        }}
      >
        <div className="timeline-progress" style={{ width: `${frac * 100}%` }} />
        <WaveformCanvas />
        <BeatGrid />
        <div className="timeline-playhead" style={{ left: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

function WaveformCanvas() {
  const peaks = useAudioStore((s) => s.peaks);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      if (!peaks) return;
      ctx.fillStyle = 'rgba(152, 152, 159, 0.55)';
      const buckets = peaks.length / 2;
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const b = Math.floor((x / w) * buckets);
        const min = peaks[b * 2] as number;
        const max = peaks[b * 2 + 1] as number;
        const y0 = mid + min * mid * 0.92;
        const y1 = mid + max * mid * 0.92;
        ctx.fillRect(x, y0, 1, Math.max(y1 - y0, 1));
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks]);

  return <canvas ref={canvasRef} className="timeline-waveform" />;
}

function BeatGrid() {
  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const beatOffsetSec = useProjectStore((s) => s.project.timeline.beatOffsetSec);
  const beatsPerBar = useProjectStore((s) => s.project.timeline.beatsPerBar);
  const showBeatGrid = useUiStore((s) => s.showBeatGrid);
  const durationSec = usePlaybackStore((s) => s.durationSec);
  if (!bpm || durationSec === 0 || !showBeatGrid) return null;
  const beats = beatTimes(0, durationSec, bpm, beatOffsetSec);
  // Cap DOM nodes for very long tracks / high BPM.
  const step = Math.max(Math.ceil(beats.length / 400), 1);
  return (
    <div className="timeline-beats">
      {beats
        .filter((_, i) => i % step === 0)
        .map((t, i) => (
          <div
            key={i}
            className={`beat-tick${
              Math.round((t - beatOffsetSec) / (60 / bpm)) % beatsPerBar === 0 ? ' bar' : ''
            }`}
            style={{ left: `${(t / durationSec) * 100}%` }}
          />
        ))}
    </div>
  );
}
