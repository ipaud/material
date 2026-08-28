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

function clampStep(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min;
  const fixed = Number(snapped.toFixed(6));
  return Math.min(Math.max(fixed, min), max);
}

function formatValue(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return value.toFixed(decimals);
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

  const fraction = max > min ? (value - min) / (max - min) : 0;
  const modFraction =
    modulated && typeof modulatedValue === 'number' && max > min
      ? Math.min(Math.max((modulatedValue - min) / (max - min), 0), 1)
      : null;

  return (
    <div className={`param-row${modulated ? ' modulated' : ''}`}>
      <span className="param-label" onDoubleClick={onDoubleClick}>
        {label}
        {modulated && <span className="param-mod-dot" title="Driven by modulation" />}
      </span>
      <div
        ref={trackRef}
        className="param-track"
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
