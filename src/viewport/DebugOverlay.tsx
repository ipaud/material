import { useEffect, useState } from 'react';
import { engine, type EngineStats } from '@/rendering/RenderEngine';
import { playback } from '@/playback/PlaybackController';
import { audioEngine } from '@/audio/AudioEngine';

export function DebugOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [times, setTimes] = useState({ clock: 0, video: 0, drift: 0 });

  useEffect(() => {
    const timer = setInterval(() => {
      setStats(engine.getStats());
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
      <div className="debug-renderer">{stats.rendererName}</div>
    </div>
  );
}
