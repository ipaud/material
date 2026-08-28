import { useEffect, useRef } from 'react';
import { getPatternDiagnostics } from '@/pattern/patternSourceRuntime';

/** Diagnostics refresh rate. The engine still evaluates at full frame rate. */
const UI_HZ = 20;

/**
 * Live step readout. The playhead moves at up to 120 Hz; React does not.
 *
 * This component renders ONCE per definition change and then writes the
 * moving parts straight to DOM refs on a 20 Hz timer — zero React commits,
 * zero store writes, zero project dirtying while a pattern animates. The
 * dots themselves are `aria-hidden`: a screen reader must not be told the
 * step changed twenty times a second.
 */
export function PatternStepPreview({
  patternId,
  pulses,
}: {
  patternId: string;
  /** Per-step pulse flags for Euclidean; omit for a plain step row. */
  pulses?: boolean[];
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const row = rowRef.current;
    const readout = readoutRef.current;
    if (!row || !readout) return;
    let lastStep = -2;
    const tick = () => {
      const diagnostic = getPatternDiagnostics().find((d) => d.id === patternId);
      const step = diagnostic?.active ? diagnostic.stepIndex : -1;
      if (step !== lastStep) {
        const previous = row.children[lastStep] as HTMLElement | undefined;
        previous?.classList.remove('at');
        const current = row.children[step] as HTMLElement | undefined;
        current?.classList.add('at');
        lastStep = step;
      }
      const total = diagnostic?.stepCount ?? 0;
      readout.textContent =
        step < 0 || total === 0
          ? '—'
          : `${String(step + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}` +
            (diagnostic && typeof diagnostic.value === 'number'
              ? `   ${diagnostic.value.toFixed(2)}`
              : '');
    };
    tick();
    const id = setInterval(tick, 1000 / UI_HZ);
    return () => clearInterval(id);
  }, [patternId, pulses?.length]);

  return (
    <div className="pat-steps">
      <div className="pat-step-row" ref={rowRef} aria-hidden="true">
        {(pulses ?? []).map((pulse, i) => (
          <span key={i} className={`pat-step${pulse ? ' pulse' : ''}`} />
        ))}
      </div>
      <div className="pat-step-readout">
        <span className="pat-num-label">step</span>
        <span className="mono" ref={readoutRef}>
          —
        </span>
      </div>
    </div>
  );
}
