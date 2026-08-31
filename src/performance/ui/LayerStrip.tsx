import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { engine } from '@/rendering/RenderEngine';
import {
  selectLayer,
  setLayerBlend,
  setLayerOpacity,
  toggleLayerEnabled,
  toggleLayerSolo,
} from '@/projects/layerActions';
import { blendModeSchema, type BlendMode, type Layer } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';

const BLEND_MODES = blendModeSchema.options as readonly BlendMode[];
const BLEND_LABEL: Record<BlendMode, string> = {
  normal: 'NRM',
  add: 'ADD',
  screen: 'SCR',
  multiply: 'MUL',
  difference: 'DIF',
  lighten: 'LTN',
  darken: 'DRK',
};

/**
 * v0.6D — the stack, as an instrument reads it.
 *
 * Bottom layer FIRST, left to right, because that is the order the compositor
 * blends in: what you see on the left is underneath. A vertical list ordered
 * top-down would read the opposite way round from the picture.
 *
 * The fader shows two numbers when a signal is driving opacity: the resting
 * value the performer set, and the value the signal is actually producing.
 * Showing only the stored one makes a modulated layer look broken; showing
 * only the live one makes the fader impossible to aim.
 */
export function LayerStrip() {
  const layers = useProjectStore((s) => s.project.layers);
  const selectedId = useProjectStore((s) => s.project.selectedLayerId);
  const anySolo = layers.some((l) => l.solo);

  return (
    <div className="perf-layers" role="group" aria-label="Layer stack">
      {layers.map((layer, i) => (
        <LayerCell
          key={layer.id}
          layer={layer}
          index={i}
          selected={layer.id === selectedId}
          dimmed={anySolo && !layer.solo}
        />
      ))}
    </div>
  );
}

function LayerCell({
  layer,
  index,
  selected,
  dimmed,
}: {
  layer: Layer;
  index: number;
  selected: boolean;
  dimmed: boolean;
}) {
  const [live, setLive] = useState<number | null>(null);
  const dragging = useRef(false);
  const techniqueLabel = layer.technique
    ? (getTechnique(layer.technique.techniqueId)?.name ?? layer.technique.techniqueId)
    : 'NO SYSTEM';

  // Resolved opacity, polled at UI rate. Null while nothing is driving it, so
  // an unmodulated fader shows one number rather than two identical ones.
  useEffect(() => {
    const timer = setInterval(() => {
      const resolved = engine.resolvedOpacity(layer.id);
      setLive((prev) => {
        const next =
          resolved === null || Math.abs(resolved - layer.opacity) < 0.005 ? null : resolved;
        if (prev === null && next === null) return prev;
        return prev !== null && next !== null && Math.abs(prev - next) < 0.005 ? prev : next;
      });
    }, 120);
    return () => clearInterval(timer);
  }, [layer.id, layer.opacity]);

  const setFromPointer = (e: { currentTarget: HTMLElement; clientX: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setLayerOpacity(layer.id, Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1));
  };

  return (
    <div
      className={
        'perf-layer' +
        (selected ? ' selected' : '') +
        (layer.enabled ? '' : ' muted') +
        (layer.solo ? ' soloed' : '') +
        (dimmed ? ' dimmed' : '')
      }
    >
      <button
        className="perf-layer-head"
        onClick={() => selectLayer(layer.id)}
        title="Select this layer — the Inspector, Looks and Explore all follow it"
      >
        <span className="perf-layer-num mono">{index + 1}</span>
        <span className="perf-layer-name">{layer.name || `Layer ${index + 1}`}</span>
        <span className="perf-layer-tech mono">{techniqueLabel}</span>
      </button>

      <div
        className="perf-layer-fader"
        role="slider"
        tabIndex={0}
        aria-label={`${layer.name || `Layer ${index + 1}`} opacity`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(layer.opacity.toFixed(2))}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setFromPointer(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) setFromPointer(e);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.01 : 0.05;
          if (e.key === 'ArrowLeft') setLayerOpacity(layer.id, Math.max(layer.opacity - step, 0));
          if (e.key === 'ArrowRight') setLayerOpacity(layer.id, Math.min(layer.opacity + step, 1));
        }}
      >
        <span className="perf-layer-fill" style={{ width: `${layer.opacity * 100}%` }} />
        {live !== null && (
          <span className="perf-layer-live" style={{ width: `${live * 100}%` }} />
        )}
        <span className="perf-layer-value mono">
          {layer.opacity.toFixed(2)}
          {live !== null && <em> {live.toFixed(2)}</em>}
        </span>
      </div>

      <div className="perf-layer-controls">
        <button
          className={'perf-layer-btn' + (layer.enabled ? '' : ' on')}
          onClick={() => toggleLayerEnabled(layer.id)}
          title={
            layer.enabled
              ? 'Mute — stops rendering this layer entirely, so its feedback or simulation stops advancing too'
              : 'Unmute'
          }
        >
          M
        </button>
        <button
          className={'perf-layer-btn' + (layer.solo ? ' on' : '')}
          onClick={() => toggleLayerSolo(layer.id)}
          title="Solo — a view, not a change: releasing it restores every other layer exactly"
        >
          S
        </button>
        <select
          className="perf-layer-blend mono"
          value={layer.blendMode}
          onChange={(e) => setLayerBlend(layer.id, e.target.value as BlendMode)}
          aria-label={`${layer.name || `Layer ${index + 1}`} blend mode`}
          title="Blend mode — how this layer combines with everything beneath it"
        >
          {BLEND_MODES.map((m) => (
            <option key={m} value={m}>
              {BLEND_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
