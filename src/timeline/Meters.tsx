import { useEffect, useRef } from 'react';
import { useAudioStore } from '@/state/audioStore';
import { sampleTrack, type TrackId } from '@/audio/analysis';
import { playback } from '@/playback/PlaybackController';

const METER_TRACKS: { id: TrackId; label: string }[] = [
  { id: 'master', label: 'MST' },
  { id: 'bass', label: 'BAS' },
  { id: 'mids', label: 'MID' },
  { id: 'highs', label: 'HI' },
  { id: 'transients', label: 'TRN' },
];

/** Live signal meters — read the precomputed analysis at the clock time. */
export function Meters() {
  const analysis = useAudioStore((s) => s.analysis);
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!analysis) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = playback.getTime();
      METER_TRACKS.forEach((track, i) => {
        const bar = barsRef.current[i];
        if (bar) {
          const v = sampleTrack(analysis, track.id, t);
          bar.style.transform = `scaleY(${Math.max(v, 0.02)})`;
        }
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analysis]);

  if (!analysis) return null;
  return (
    <div className="meters" title="master / bass / mids / highs / transients">
      {METER_TRACKS.map((track, i) => (
        <div key={track.id} className="meter">
          <div className="meter-well">
            <div
              className="meter-bar"
              ref={(el) => {
                barsRef.current[i] = el;
              }}
            />
          </div>
          <span className="meter-label">{track.label}</span>
        </div>
      ))}
    </div>
  );
}
