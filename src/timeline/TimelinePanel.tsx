import { useCallback, useEffect, useRef } from 'react';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
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
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  // Space = play/pause (ignored while typing in an input).
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

  if (durationSec === 0) {
    return (
      <div className="timeline-empty">
        <span className="label">Timeline — select a video source</span>
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
        <div className="timeline-playhead" style={{ left: `${frac * 100}%` }} />
      </div>
    </div>
  );
}
