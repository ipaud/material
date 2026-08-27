import { useEffect, useState } from 'react';
import { engine, type EngineStats } from '@/rendering/RenderEngine';
import { playback } from '@/playback/PlaybackController';
import { audioEngine } from '@/audio/AudioEngine';
import type { TemporalStats } from '@/rendering/temporal/TemporalFrameProvider';

export function DebugOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [times, setTimes] = useState({ clock: 0, video: 0, drift: 0 });
  const [temporal, setTemporal] = useState<TemporalStats | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setStats(engine.getStats());
      setTemporal(engine.getTemporalStats());
      setTimes({
        clock: playback.getTime(),
        video: playback.currentVideo?.currentTime ?? 0,
        drift: playback.avDriftSec,
      });
    }, 250);
    return () => clearInterval(timer);
  }, []);

  if (!stats) return null;
  return (
    <div className="debug-overlay mono">
      <div>fps {stats.fps}</div>
      <div>frame {stats.frameTimeMs.toFixed(2)}ms</div>
      <div>instances {stats.instanceCount}</div>
      <div>zoom {(engine.view.zoom * 100).toFixed(0)}%</div>
      <div>clock {times.clock.toFixed(3)}s{audioEngine.isLoaded ? ' (audio)' : ' (video)'}</div>
      {playback.currentVideo && audioEngine.isLoaded && (
        <div>a/v drift {(times.drift * 1000).toFixed(1)}ms</div>
      )}
      {temporal && (
        <>
          <div className="debug-sep">temporal</div>
          <div>
            frames {temporal.filled}/{temporal.slotCount} · {temporal.cacheMB.toFixed(1)} MB
          </div>
          <div>span {temporal.spanSec.toFixed(2)}s</div>
          <div>anchor {temporal.anchorTime.toFixed(3)}s</div>
          <div>
            hit/miss {temporal.hits}/{temporal.misses} · seeks {temporal.seeks}
          </div>
        </>
      )}
      <div className="debug-renderer">{stats.rendererName}</div>
    </div>
  );
}
