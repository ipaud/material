import { useEffect, useState } from 'react';
import { engine, type EngineStats } from '@/rendering/RenderEngine';

export function DebugOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setStats(engine.getStats()), 250);
    return () => clearInterval(timer);
  }, []);

  if (!stats) return null;
  return (
    <div className="debug-overlay mono">
      <div>fps {stats.fps}</div>
      <div>frame {stats.frameTimeMs.toFixed(2)}ms</div>
      <div>instances {stats.instanceCount}</div>
      <div>zoom {(engine.view.zoom * 100).toFixed(0)}%</div>
      <div className="debug-renderer">{stats.rendererName}</div>
    </div>
  );
}
