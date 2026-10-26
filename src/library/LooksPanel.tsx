import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { performLookRecall, performMorph } from '@/performance/take/gestures';
import {
  deleteLook,
  duplicateLook,
  endPinPreview,
  makeLook,
  previewPin,
  renameLook,
  rethumbnailLook,
  updateLook,
} from '@/projects/lookActions';
import { isLookDirty } from '@/performance/lookCore';
import { exploreAroundPin } from '@/explore/exploreActions';
import { exportPngStill } from '@/export/exportStill';
import { morphRuntime, type MorphDuration } from '@/performance/morphRuntime';
import {
  TRANSITION_STYLES,
  type TransitionStyle,
} from '@/rendering/transition/TransitionCompositor';
import { playback } from '@/playback/PlaybackController';
import type { MorphCurve, QuantizeMode } from '@shared/schemas/project';
import './looks.css';

const START_OPTIONS: { value: QuantizeMode; label: string }[] = [
  { value: 'off', label: 'Immediate' },
  { value: 'beat', label: 'Next Beat' },
  { value: 'bar', label: 'Next Bar' },
  { value: '2bars', label: '2 Bars' },
  { value: '4bars', label: '4 Bars' },
];

const DURATION_OPTIONS: { id: string; label: string; value: MorphDuration }[] = [
  { id: '1beat', label: '1 Beat', value: { mode: 'beats', beats: 1 } },
  { id: '2beats', label: '2 Beats', value: { mode: 'beats', beats: 2 } },
  { id: '1bar', label: '1 Bar', value: { mode: 'bars', bars: 1 } },
  { id: '2bars', label: '2 Bars', value: { mode: 'bars', bars: 2 } },
  { id: '4bars', label: '4 Bars', value: { mode: 'bars', bars: 4 } },
  { id: '2s', label: '2 s', value: { mode: 'seconds', seconds: 2 } },
  { id: '5s', label: '5 s', value: { mode: 'seconds', seconds: 5 } },
];

const CURVE_OPTIONS: { value: MorphCurve; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'easeIn', label: 'Ease In' },
  { value: 'easeOut', label: 'Ease Out' },
  { value: 'easeInOut', label: 'Ease In Out' },
  { value: 'exponential', label: 'Exponential' },
];

export function LooksPanel() {
  const looks = useProjectStore((s) => s.project.pinnedLooks);
  const activeLookId = useProjectStore((s) => s.project.activeLookId);
  const project = useProjectStore((s) => s.project);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const previewLabel = useProjectStore((s) => s.previewLabel);
  const [comparingId, setComparingId] = useState<string | null>(null);

  if (looks.length === 0) return null;
  const activeLook = looks.find((l) => l.id === activeLookId) ?? null;
  const dirty = activeLook ? isLookDirty(project, activeLook) : false;

  return (
    <div className="looks-section">
      <div className="panel-header looks-header">
        <span className="label">Pins / Looks</span>
        {activeLook && (
          <span className="looks-active-label mono">
            {activeLook.label}
            {dirty && <span className="looks-dirty" title="Current state differs from this look"> ●</span>}
          </span>
        )}
      </div>
      <div className="looks-grid">
        {looks.map((look) => {
          const isActive = look.id === activeLookId;
          return (
            <div
              key={look.id}
              className={`look-card${isActive ? ' active' : ''}`}
            >
              <button
                className="look-apply"
                type="button"
                aria-label={`Apply ${look.label}${look.slot ? ` (key ${look.slot})` : ''}`}
                onClick={() => performLookRecall(look.id)}
              >
                <div className="look-thumb">
                  {look.thumbnail ? (
                    <img src={look.thumbnail} alt="" draggable={false} />
                  ) : (
                    <div className="look-thumb-empty" />
                  )}
                  {look.slot && <span className="look-slot mono">{look.slot}</span>}
                  {isActive && <span className={`look-active-dot${dirty ? ' dirty' : ''}`} />}
                </div>
                {renaming === look.id ? null : (
                  <span
                    className="look-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenaming(look.id);
                    }}
                  >
                    {look.label}
                  </span>
                )}
              </button>
              {renaming === look.id ? (
                <RenameInput
                  initial={look.label}
                  onDone={(label) => {
                    if (label) renameLook(look.id, label);
                    setRenaming(null);
                  }}
                />
              ) : null}
              <button
                className="look-menu-btn"
                type="button"
                aria-label={`Actions for ${look.label}`}
                aria-expanded={menuFor === look.id}
                onClick={() => setMenuFor(menuFor === look.id ? null : look.id)}
              >
                ⋯
              </button>
              {menuFor === look.id && (
                <div className="look-menu" onClick={(e) => e.stopPropagation()}>
                  {look.slot === null && (
                    <>
                      <button onClick={() => { exploreAroundPin(look); setMenuFor(null); }}>
                        Explore Around
                      </button>
                      <button
                        onClick={() => {
                          makeLook(look.id);
                          setMenuFor(null);
                        }}
                      >Make Look</button>
                    </>
                  )}
                  <button
                    aria-pressed={previewLabel === `Compare ${look.label}` && comparingId === look.id}
                    onPointerDown={() => {
                      if (previewPin(look.id)) setComparingId(look.id);
                    }}
                    onPointerUp={() => { endPinPreview(); setComparingId(null); }}
                    onPointerLeave={() => { endPinPreview(); setComparingId(null); }}
                    onPointerCancel={() => { endPinPreview(); setComparingId(null); }}
                    onBlur={() => { endPinPreview(); setComparingId(null); }}
                    onKeyDown={(event) => {
                      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat && previewPin(look.id)) {
                        setComparingId(look.id);
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.key === ' ' || event.key === 'Enter') {
                        endPinPreview();
                        setComparingId(null);
                      }
                    }}
                  >
                    HOLD TO COMPARE
                  </button>
                  <button onClick={() => { setMenuFor(null); void exportPngStill(look.id); }}>
                    Export Still
                  </button>
                  {isActive && dirty && (
                    <button
                      onClick={() => {
                        updateLook(look.id);
                        setMenuFor(null);
                      }}
                    >
                      Update with current
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setRenaming(look.id);
                      setMenuFor(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => {
                      rethumbnailLook(look.id);
                      setMenuFor(null);
                    }}
                  >
                    Re-thumbnail
                  </button>
                  <button
                    onClick={() => {
                      duplicateLook(look.id);
                      setMenuFor(null);
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      deleteLook(look.id);
                      setMenuFor(null);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <MorphPanel />
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (label: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="look-rename mono"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}

/** Compact morph launcher (§20) + live progress with cancel. */
function MorphPanel() {
  const looks = useProjectStore((s) => s.project.pinnedLooks);
  const bpm = useProjectStore((s) => s.project.timeline.bpm);
  const [targetId, setTargetId] = useState('');
  const [start, setStart] = useState<QuantizeMode>('off');
  const [durationId, setDurationId] = useState('1bar');
  const [curve, setCurve] = useState<MorphCurve>('easeInOut');
  const [style, setStyle] = useState<TransitionStyle>('smooth');
  const progressRef = useRef<HTMLDivElement>(null);

  // Live progress readout — imperative, morph state lives outside React.
  useEffect(() => {
    const timer = setInterval(() => {
      const el = progressRef.current;
      if (!el) return;
      const active = morphRuntime.current;
      if (!active) {
        el.textContent = '';
        el.parentElement?.classList.remove('morphing');
        return;
      }
      el.parentElement?.classList.add('morphing');
      const raw = morphRuntime.progressAt(playback.getTime()) ?? 0;
      const stats = morphRuntime.stats;
      el.textContent =
        `MORPHING → ${active.targetLabel} · ${Math.round(raw * 100)}%` +
        (stats ? ` · ${stats.interpolated} lerped / ${stats.switched} switched` : '');
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const musicalDisabled = !bpm;

  return (
    <div className="morph-panel">
      <div className="panel-header">
        <span className="label">Morph</span>
      </div>
      <div className="morph-controls">
        <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="" disabled>
            To look…
          </option>
          {looks.map((l) => (
            <option key={l.id} value={l.id}>
              {l.slot ? `[${l.slot}] ` : ''}
              {l.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={start}
          onChange={(e) => setStart(e.target.value as QuantizeMode)}
          title="Start"
        >
          {START_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} disabled={o.value !== 'off' && musicalDisabled}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={durationId}
          onChange={(e) => setDurationId(e.target.value)}
          title="Duration"
        >
          {DURATION_OPTIONS.map((o) => (
            <option key={o.id} value={o.id} disabled={o.value.mode !== 'seconds' && musicalDisabled}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={curve}
          onChange={(e) => setCurve(e.target.value as MorphCurve)}
          title="Curve"
        >
          {CURVE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {/* CE1G: the visual transition STYLE — a performance control, not
            Look content. 'Smooth' is v0.3 behaviour exactly. */}
        <select
          className="select"
          value={style}
          onChange={(e) => {
            const next = e.target.value as TransitionStyle;
            setStyle(next);
            morphRuntime.setTransition({ style: next });
          }}
          title="Transition style"
        >
          {TRANSITION_STYLES.map((s) => (
            <option key={s} value={s}>
              {s === 'smooth' ? 'Smooth' : s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <button
          className="titlebar-action"
          disabled={!targetId}
          onClick={() => {
            const duration = DURATION_OPTIONS.find((o) => o.id === durationId)?.value;
            if (targetId && duration) {
              performMorph(targetId, duration, curve, start);
            }
          }}
        >
          MORPH
        </button>
        <button className="vp-btn" onClick={() => morphRuntime.cancelKeep()} title="Cancel & keep current state">
          ✕
        </button>
      </div>
      <div ref={progressRef} className="morph-progress mono" />
    </div>
  );
}
