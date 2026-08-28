import { useCallback, useEffect, useRef, useState } from 'react';
import { engine } from '@/rendering/RenderEngine';
import { startEngineBridge } from '@/rendering/engineBridge';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { DebugOverlay } from './DebugOverlay';
import { SignalMonitor } from './SignalMonitor';
import './viewport.css';

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomPct, setZoomPct] = useState(0);
  const [stats, setStats] = useState({ fps: 0, instances: 0 });
  const [checker, setChecker] = useState(false);
  const panning = useRef<{ x: number; y: number } | null>(null);
  const debugOverlay = useUiStore((s) => s.debugOverlay);
  const showSignalMonitor = useUiStore((s) => s.showSignalMonitor);
  const setShowOriginal = useUiStore((s) => s.setShowOriginal);
  const compWidth = useProjectStore((s) => s.project.composition.width);
  const compHeight = useProjectStore((s) => s.project.composition.height);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engine.init(canvas);
    engine.fit();
    const stopBridge = startEngineBridge();
    const observer = new ResizeObserver(() => engine.invalidate());
    observer.observe(canvas);
    // One low-rate sampler for the status line; the render loop stays untouched.
    const zoomTimer = setInterval(() => {
      setZoomPct(Math.round(engine.view.zoom * 100));
      const s = engine.getStats();
      setStats({ fps: s.fps, instances: s.instanceCount });
    }, 400);
    return () => {
      clearInterval(zoomTimer);
      observer.disconnect();
      stopBridge();
      engine.dispose();
    };
  }, []);

  // Hold ` (backtick) to view the unprocessed source (A/B compare).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === '`' && !e.repeat) setShowOriginal(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === '`') setShowOriginal(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [setShowOriginal]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-e.deltaY * 0.0022);
    engine.zoomAround(factor, cx, cy);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // Middle-drag or space is unavailable here; use left-drag to pan.
    if (e.button === 0 || e.button === 1) {
      panning.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panning.current) return;
    engine.panBy(e.clientX - panning.current.x, -(e.clientY - panning.current.y));
    panning.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback(() => {
    panning.current = null;
  }, []);

  const toggleChecker = useCallback(() => {
    setChecker((prev) => {
      engine.setCheckerboard(!prev);
      return !prev;
    });
  }, []);

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className={`viewport-canvas${checker ? ' checker' : ''}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => engine.fit()}
      />
      <div className="viewport-status">
        <div className="vp-zoom">
          <button className="vp-btn" onClick={() => engine.fit()} title="Fit (double-click)">
            FIT
          </button>
          <button className="vp-btn" onClick={() => engine.zoomTo(1)} title="Actual size">
            100%
          </button>
          <span className="vp-readout mono">{zoomPct}%</span>
        </div>
        <span className="vp-status-spacer" />
        <span className="vp-readout mono">
          {compWidth}×{compHeight}
        </span>
        {stats.fps > 0 && <span className="vp-readout mono">{stats.fps} FPS</span>}
        {stats.instances > 0 && (
          <span className="vp-readout mono" title="Rendered instances">
            {stats.instances} INST
          </span>
        )}
        <button
          className={`vp-btn${checker ? ' active' : ''}`}
          onClick={toggleChecker}
          title="Checkerboard background"
        >
          CHK
        </button>
        <button
          className="vp-btn"
          onPointerDown={() => setShowOriginal(true)}
          onPointerUp={() => setShowOriginal(false)}
          onPointerLeave={() => setShowOriginal(false)}
          title="Hold to view original (or hold `)"
        >
          A/B
        </button>
      </div>
      {debugOverlay && <DebugOverlay />}
      {showSignalMonitor && <SignalMonitor />}
    </div>
  );
}
