import { useCallback, useEffect, useRef, useState } from 'react';
import './parameter-slider.css';

interface ParameterSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit?: string;
  /** Tooltip on the label: what this control does, in a sentence. */
  hint?: string;
  /** Marks the row as driven by a modulation mapping. */
  modulated?: boolean;
  /** Live modulated value, shown alongside the base value. */
  modulatedValue?: number;
  /** Fired continuously during a drag. */
  onChange: (value: number) => void;
  /** Gesture boundaries — used to coalesce undo history. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

const FINE_FACTOR = 0.1;
/** Alt+arrow jumps this many steps. */
const COARSE_STEPS = 10;

function clampStep(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min;
  const fixed = Number(snapped.toFixed(6));
  return Math.min(Math.max(fixed, min), max);
}

function formatValue(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const base = value.toFixed(decimals);
  // A fine (Shift) value sits between grid points: show it instead of rounding it away.
  if (Math.abs(Number(base) - value) < 1e-9) return base;
  return String(Number(value.toFixed(4)));
}

/**
 * Compact drag-slider: horizontal drag to change, shift for fine control,
 * double-click to reset, click the value to type an exact number.
 */
export function ParameterSlider({
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  unit,
  hint,
  modulated,
  modulatedValue,
  onChange,
  onDragStart,
  onDragEnd,
}: ParameterSliderProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startValue: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (editing || e.button !== 0) return;
      drag.current = { startX: e.clientX, startValue: value, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      onDragStart?.();
    },
    [editing, value, onDragStart],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current || !trackRef.current) return;
      const dx = e.clientX - drag.current.startX;
      if (Math.abs(dx) > 2) drag.current.moved = true;
      const width = trackRef.current.clientWidth;
      const range = max - min;
      const fine = e.shiftKey ? FINE_FACTOR : 1;
      const next = clampStep(drag.current.startValue + (dx / width) * range * fine, min, max, step);
      if (next !== value) onChange(next);
    },
    [max, min, step, value, onChange],
  );

  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    onDragEnd?.();
  }, [onDragEnd]);

  const onDoubleClick = useCallback(() => {
    onDragStart?.();
    onChange(clampStep(defaultValue, min, max, step));
    onDragEnd?.();
  }, [defaultValue, min, max, step, onChange, onDragStart, onDragEnd]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const parsed = Number(editText);
    if (Number.isFinite(parsed)) {
      onDragStart?.();
      onChange(clampStep(parsed, min, max, step));
      onDragEnd?.();
    }
  }, [editText, min, max, step, onChange, onDragStart, onDragEnd]);

  /** One undo-able nudge from the keyboard or wheel; `fine` snaps to a tenth of the step. */
  const nudge = useCallback(
    (direction: 1 | -1, mods: { shiftKey: boolean; altKey: boolean }) => {
      const size = mods.altKey ? step * COARSE_STEPS : mods.shiftKey ? step * FINE_FACTOR : step;
      const grid = mods.shiftKey ? step * FINE_FACTOR : step;
      const next = clampStep(value + direction * size, min, max, grid);
      onDragStart?.();
      onChange(next);
      onDragEnd?.();
    },
    [value, min, max, step, onChange, onDragStart, onDragEnd],
  );

  const setExact = useCallback(
    (next: number) => {
      onDragStart?.();
      onChange(clampStep(next, min, max, step));
      onDragEnd?.();
    },
    [min, max, step, onChange, onDragStart, onDragEnd],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.metaKey || e.ctrlKey) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        nudge(1, e);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        nudge(-1, e);
        break;
      case 'Home':
        setExact(min);
        break;
      case 'End':
        setExact(max);
        break;
      case 'Backspace':
      case 'Delete':
        setExact(defaultValue);
        break;
      case 'Enter':
        setEditText(formatValue(value, step));
        setEditing(true);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Native listener: React's wheel is passive and could not stop the panel scrolling.
  const wheelRef = useRef(nudge);
  wheelRef.current = nudge;
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el || e.deltaY === 0) return;
      e.preventDefault();
      wheelRef.current(e.deltaY < 0 ? 1 : -1, e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const parsed = Number(e.clipboardData.getData('text').trim());
    if (e.clipboardData.getData('text').trim() === '' || !Number.isFinite(parsed)) return;
    e.preventDefault();
    setExact(parsed);
  };

  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    e.clipboardData.setData('text/plain', formatValue(value, step));
    e.preventDefault();
  };

  const fraction = max > min ? (value - min) / (max - min) : 0;
  const modFraction =
    modulated && typeof modulatedValue === 'number' && max > min
      ? Math.min(Math.max((modulatedValue - min) / (max - min), 0), 1)
      : null;

  return (
    <div className={`param-row${modulated ? ' modulated' : ''}`}>
      <span className="param-label" title={hint} onDoubleClick={onDoubleClick}>
        {label}
        {modulated && <span className="param-mod-dot" title="Driven by modulation" />}
      </span>
      <div
        ref={trackRef}
        className="param-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCopy={onCopy}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {/* The value readout occupies the track's right gutter (--param-value-w),
            so the rail and every marker measure against the space left over. */}
        <div
          className="param-fill"
          style={{ width: `calc((100% - var(--param-value-w)) * ${fraction})` }}
        />
        {modFraction !== null && (
          <div
            className="param-mod-marker"
            style={{ left: `calc((100% - var(--param-value-w)) * ${modFraction})` }}
          />
        )}
        {editing ? (
          <input
            ref={inputRef}
            className="param-input mono"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span
            className="param-value mono"
            title="Click to type a value · ↑↓ step (Shift fine, Alt ×10) · ⌘C/⌘V copy/paste · Delete resets"
            onClick={(e) => {
              if (drag.current?.moved) return;
              e.stopPropagation();
              setEditText(formatValue(value, step));
              setEditing(true);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {formatValue(value, step)}
            {unit && <span className="param-unit">{unit}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
