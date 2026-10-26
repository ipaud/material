import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
import { laneValueAt, parseControlTarget } from '@/performance/take/model';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import {
  addPoint,
  deleteEvent,
  deleteLane,
  deletePoint,
  moveEvent,
  movePoint,
  setLaneInterp,
  simplifyTake,
  takeStats,
  trimTake,
} from '@/performance/take/edit';
import { resolveAgainstProject } from '@/performance/take/evaluate';
import { takeRecorder } from '@/performance/take/recorder';
import { takePlayer } from '@/performance/take/player';
import {
  activeTake,
  deleteTake,
  duplicateTake,
  editTake,
  playTake,
  renameTake,
  selectTake,
  stopTake,
  toggleArm,
  addLaneToTake,
  createManualTake,
  keyframeTargets,
} from '@/performance/take/takeActions';
import type { PerformanceTake, Project, TakeEvent, TakeLane } from '@shared/schemas/project';

/**
 * v0.7F — PERFORMANCE CAPTURE, as an instrument reads it.
 *
 * Three controls at the front, because those are the three a performer touches
 * mid-song: REC, PLAY TAKE, STOP. Never in a settings panel (§120).
 *
 * The editor below them is deliberately the smallest thing that makes a Take
 * usable: one horizontal ruler for the Take's own length, a polyline per
 * continuous lane, a tick per discrete event. No media tracks, no waveform, no
 * thumbnails, no curve handles, no per-property lanes for hidden state — the
 * moment this needs a generic timeline, the answer is to reduce what it edits
 * rather than to grow it (§62, §165).
 */

/**
 * Lane geometry.
 *
 * X is normalised: the polyline is drawn in a 0..LANE_VB viewBox that stretches
 * to whatever width the strip has, and points are positioned in percent. A
 * fixed pixel width made a 71-second Take 4.5 px per second, which is legible
 * and unaimable — two Freeze events two bars apart rendered almost touching.
 * `vector-effect` keeps the stroke one pixel however far the box stretches.
 */
const LANE_VB = 1000;
/**
 * 26px was sized for a 320px lane. Fluid width made the box roughly 1300px
 * wide, and the same gesture in the same height reads as a flat wobble at
 * 50:1. Taller is what makes a shape legible once it is allowed to stretch.
 */
const LANE_H = 44;
/**
 * Vertical inset, so a point at the extreme of its range is not clipped by the
 * lane's own border. It has to appear in BOTH directions: the renderer insets
 * and the drag handler did not, so grabbing a point moved it about 4% of its
 * range before the pointer had travelled at all.
 */
const LANE_PAD = 3;
/** Width of the label gutter; the ruler and the tools line up with it. */
const LABEL_W = 120;

/** Composition-time readout at UI rate, not render rate. */
function useUiTime(): number {
  return usePlaybackStore((s) => s.timeSec);
}

function laneLabel(target: string, project: Project): string {
  const parsed = parseControlTarget(target);
  if (!parsed) return 'UNKNOWN';
  if (parsed.kind === 'macro') {
    return project.macros.find((m) => m.id === parsed.macroId)?.name ?? 'MACRO ?';
  }
  const layer = project.layers.find((l) => l.id === parsed.layerId);
  const name = layer?.name || `LAYER ${Math.max(project.layers.indexOf(layer!), 0) + 1}`;
  if (parsed.kind === 'layerOpacity') return `${name} · OPACITY`;
  if (parsed.stageId) {
    const index = layer?.techniqueChain.findIndex((stage) => stage.id === parsed.stageId) ?? -1;
    return `${name} · STAGE ${index < 0 ? '?' : index + 2} · ${parsed.paramId}`;
  }
  return `${name} · ${parsed.paramId}`;
}

/**
 * The range a lane is DRAWN against — its control's own domain, not the range
 * the gesture happened to cover.
 *
 * Auto-scaling each lane to its own content made a lane that moved 0.4 to 0.5
 * look exactly as dramatic as one that swept 0 to 1, so two lanes could not be
 * compared by eye. Against the domain, a small gesture looks small, which is
 * the truth. A parameter whose definition cannot be found falls back to its
 * content, because a flat line with no explanation is worse than a rescaled one.
 */
export function laneDomain(
  target: string,
  project: Project,
  samples: readonly { v: number }[],
): [number, number] {
  const parsed = parseControlTarget(target);
  if (parsed && (parsed.kind === 'layerOpacity' || parsed.kind === 'macro')) return [0, 1];
  if (parsed?.kind === 'param') {
    const layer = project.layers.find((l) => l.id === parsed.layerId);
    const stage = parsed.stageId ? layer?.techniqueChain.find((item) => item.id === parsed.stageId) : null;
    const definition = stage
      ? getTechnique(stage.techniqueId)
      : layer?.technique ? getTechnique(layer.technique.techniqueId) : null;
    const def = definition
      ? allParams(definition).find((d) => d.id === parsed.paramId)
      : undefined;
    if (def && def.type === 'number') return [def.min, def.max];
  }
  const values = samples.map((s) => s.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
}

const EVENT_GLYPH: Record<TakeEvent['kind'], string> = {
  'look.recall': 'L',
  'morph.start': 'M',
  'freeze.set': 'F',
  'layer.enable': 'E',
};

export function TakeStrip() {
  const takes = useProjectStore((s) => s.project.takes);
  const project = useProjectStore((s) => s.project);
  const playing = usePlaybackStore((s) => s.playing);
  const take = activeTake(project);
  const [rec, setRec] = useState(() => takeRecorder.snapshot());
  const [replaying, setReplaying] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // The recorder and the player live outside React on purpose — they are on the
  // transport's hot path. Polling them at UI rate is what keeps them there.
  useEffect(() => {
    const timer = setInterval(() => {
      setRec(takeRecorder.snapshot());
      setReplaying(takePlayer.isPlaying);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  const recording = rec.state === 'recording';
  const unresolved = take ? resolveAgainstProject(take, project) : null;
  const unresolvedCount =
    (unresolved?.unresolvedLanes.length ?? 0) + (unresolved?.unresolvedEvents.length ?? 0);

  return (
    <div className="perf-takes">
      <div className="perf-group">
        <span className={`perf-group-label${recording ? ' rec' : ''}`}>
          {recording ? `● RECORDING ${rec.elapsedSec.toFixed(1)}s` : 'PERFORMANCE'}
        </span>
        <div className="perf-group-body">
          <button
            className={`perf-big-btn${recording ? ' engaged-rec' : rec.state === 'armed' ? ' armed-rec' : ''}`}
            onClick={() => toggleArm()}
            title={
              recording
                ? 'Stop recording and keep the Take'
                : 'Arm recording — starts when the transport plays'
            }
          >
            {recording ? '■ STOP REC' : rec.state === 'armed' ? '● ARMED' : '● REC'}
          </button>
          <button
            className={`perf-big-btn${replaying ? ' engaged' : ''}`}
            disabled={!take || recording}
            onClick={() => (replaying ? stopTake() : playTake())}
            title={replaying ? 'Stop replaying this Take' : 'Replay the selected Take'}
          >
            {replaying ? '■ STOP TAKE' : '▶ TAKE'}
          </button>
          <button
            className="perf-big-btn quiet"
            disabled={recording}
            onClick={() => {
              createManualTake();
              setExpanded(true);
            }}
            title="Make an empty Take and draw lanes into it by hand — keyframes for layer opacity and parameters"
          >
            + NEW KEYFRAMES
          </button>
          {recording && (
            <span className="perf-take-meter">
              {rec.laneCount}L · {rec.sampleCount}pt · {rec.eventCount}ev
              {!playing && <em> transport stopped</em>}
            </span>
          )}
        </div>
      </div>

      <div className="perf-group perf-group-takelist">
        <span className="perf-group-label">TAKES</span>
        <div className="perf-group-body">
          {takes.length === 0 && <span className="perf-take-empty">none yet — arm REC and play</span>}
          {takes.map((t) => (
            <TakeChip
              key={t.id}
              take={t}
              active={t.id === project.activeTakeId}
              onSelect={() => selectTake(t.id)}
            />
          ))}
        </div>
      </div>

      {take && (
        <div className="perf-group perf-group-editor">
          <span className="perf-group-label">
            {take.name} · {take.durationSec.toFixed(1)}s
            {unresolvedCount > 0 && (
              <em className="perf-take-warn"> · {unresolvedCount} unresolved</em>
            )}
          </span>
          <div className="perf-group-body">
            <button
              className="perf-big-btn quiet"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? 'HIDE' : 'EDIT'}
            </button>
            {!expanded && <TakeSummary take={take} project={project} />}
          </div>
        </div>
      )}

      {take && expanded && <TakeEditor take={take} project={project} />}
    </div>
  );
}

function TakeChip({
  take,
  active,
  onSelect,
}: {
  take: PerformanceTake;
  active: boolean;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <span className={`perf-take-chip${active ? ' active' : ''}`}>
      {editing ? (
        <input
          className="perf-take-name"
          defaultValue={take.name}
          autoFocus
          onBlur={(e) => {
            renameTake(take.id, e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button className="perf-take-select" onClick={onSelect} onDoubleClick={() => setEditing(true)}>
          {take.name}
          <em>{take.durationSec.toFixed(0)}s</em>
        </button>
      )}
      <button
        className="perf-take-mini"
        title="Duplicate"
        onClick={() => duplicateTake(take.id)}
        aria-label={`Duplicate ${take.name}`}
      >
        ⧉
      </button>
      <button
        className="perf-take-mini danger"
        title="Delete (undoable)"
        onClick={() => deleteTake(take.id)}
        aria-label={`Delete ${take.name}`}
      >
        ✕
      </button>
    </span>
  );
}

function TakeSummary({ take, project }: { take: PerformanceTake; project: Project }) {
  const stats = takeStats(take);
  return (
    <span className="perf-take-meter">
      {take.lanes.map((l) => laneLabel(l.target, project)).join(' · ') || 'no automation'}
      {' — '}
      {stats.samples} pt · {stats.events} ev · {(stats.bytes / 1024).toFixed(1)}kB
    </span>
  );
}

// ---- The minimal editor ---------------------------------------------------

function TakeEditor({ take, project }: { take: PerformanceTake; project: Project }) {
  const time = useUiTime();
  const rel = time - take.startSec;
  const playhead = take.durationSec > 0 ? Math.min(Math.max(rel / take.durationSec, 0), 1) : 0;
  const inside = rel >= 0 && rel <= take.durationSec;

  return (
    <div className="perf-take-editor">
      <div className="perf-take-ruler" style={{ marginLeft: LABEL_W }}>
        <span>0</span>
        <span>{(take.durationSec / 2).toFixed(1)}</span>
        <span>{take.durationSec.toFixed(1)}s</span>
      </div>

      <EventRow take={take} playhead={inside ? playhead : null} />

      {take.lanes.map((lane) => (
        <LaneRow
          key={lane.target}
          take={take}
          lane={lane}
          label={laneLabel(lane.target, project)}
          project={project}
          playhead={inside ? playhead : null}
          relSec={inside ? rel : null}
        />
      ))}

      <div className="perf-take-tools">
        <select
          className="perf-take-add-lane mono"
          aria-label="Add lane"
          value=""
          onChange={(e) => e.target.value && addLaneToTake(take.id, e.target.value)}
          title="Add a lane for a layer's opacity or a parameter. Double-click a lane to add a key; Alt-click a key to delete it."
        >
          <option value="">+ LANE…</option>
          {keyframeTargets(project)
            .filter((t) => !take.lanes.some((l) => l.target === t.target))
            .map((t) => (
              <option key={t.target} value={t.target}>
                {t.label}
              </option>
            ))}
        </select>
        <button
          className="perf-big-btn quiet"
          title="Re-simplify every lane, keeping the gesture within tolerance"
          onClick={() => editTake(take.id, (t) => simplifyTake(t, 0.008))}
        >
          SIMPLIFY
        </button>
        <button
          className="perf-big-btn quiet"
          title="Trim the Take to start at the playhead"
          disabled={!inside || playhead <= 0}
          onClick={() =>
            editTake(take.id, (t) => trimTake(t, playback.getTime() - t.startSec, t.durationSec))
          }
        >
          TRIM IN
        </button>
        <button
          className="perf-big-btn quiet"
          title="Trim the Take to end at the playhead"
          disabled={!inside || playhead >= 1}
          onClick={() => editTake(take.id, (t) => trimTake(t, 0, playback.getTime() - t.startSec))}
        >
          TRIM OUT
        </button>
      </div>
    </div>
  );
}

function EventRow({ take, playhead }: { take: PerformanceTake; playhead: number | null }) {
  const drag = useRef<string | null>(null);
  const span = Math.max(take.durationSec, 1e-6);
  return (
    <div className="perf-take-row">
      <span className="perf-take-lane-label">EVENTS</span>
      <div
        className="perf-take-lane events"
        style={{ height: LANE_H }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const box = e.currentTarget;
          const rect = box.getBoundingClientRect();
          const t = ((e.clientX - rect.left - box.clientLeft) / box.clientWidth) * span;
          editTake(take.id, (x) => moveEvent(x, drag.current as string, t));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        {playhead !== null && (
          <span className="perf-take-playhead" style={{ left: `${playhead * 100}%` }} />
        )}
        {take.events.map((event) => (
          <button
            key={event.id}
            className={`perf-take-event kind-${event.kind.split('.')[0]}`}
            style={{ left: `${(event.t / span) * 100}%` }}
            title={`${event.kind} at ${event.t.toFixed(2)}s — drag to move, ⌥click to delete`}
            onPointerDown={(e) => {
              if (e.altKey) {
                editTake(take.id, (x) => deleteEvent(x, event.id));
                return;
              }
              drag.current = event.id;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
          >
            {EVENT_GLYPH[event.kind]}
          </button>
        ))}
      </div>
      {/* Empty, but the same width as a lane's meta column: without it the
          event row stretches wider than the lanes below and a marker no longer
          sits above the point it happened at. */}
      <span className="perf-take-lane-meta" aria-hidden="true" />
    </div>
  );
}

function LaneRow({
  take,
  lane,
  label,
  project,
  playhead,
  relSec,
}: {
  take: PerformanceTake;
  lane: TakeLane;
  label: string;
  project: Project;
  playhead: number | null;
  relSec: number | null;
}) {
  const drag = useRef<number | null>(null);
  const span = Math.max(take.durationSec, 1e-6);
  const [lo, hi] = laneDomain(lane.target, project, lane.samples);
  const range = hi - lo || 1;
  const travel = LANE_H - 2 * LANE_PAD;
  const x = (t: number) => (t / span) * LANE_VB;
  const y = (v: number) => LANE_H - LANE_PAD - ((v - lo) / range) * travel;
  /** Exact inverse of `y`, so a point does not jump the moment you grab it. */
  const valueAtY = (offsetY: number) =>
    Math.min(Math.max(lo + ((LANE_H - LANE_PAD - offsetY) / travel) * range, lo), hi);
  const path = lane.samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`)
    .join(' ');

  // What this control is doing RIGHT NOW, on the row that draws it. The point
  // of the strip is to answer that without your eye travelling to the fader.
  const nowValue = relSec === null ? null : laneValueAt(lane, relSec);

  return (
    <div className="perf-take-row">
      <span className="perf-take-lane-label" title={label}>
        {label}
      </span>
      <div
        className="perf-take-lane"
        style={{ height: LANE_H }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          // Measure against the CONTENT box: the lane has a 1px border, and
          // taking the border into the mapping shifts every drag by half of it.
          const box = e.currentTarget;
          const rect = box.getBoundingClientRect();
          const t = ((e.clientX - rect.left - box.clientLeft) / box.clientWidth) * span;
          const v = valueAtY(e.clientY - rect.top - box.clientTop);
          editTake(take.id, (k) => movePoint(k, lane.target, drag.current as number, t, v));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).classList.contains('perf-take-point')) return;
          const box = e.currentTarget;
          const rect = box.getBoundingClientRect();
          const t = ((e.clientX - rect.left - box.clientLeft) / (box.clientWidth || 1)) * span;
          editTake(take.id, (k) => addPoint(k, lane.target, t));
        }}
      >
        {playhead !== null && (
          <span className="perf-take-playhead" style={{ left: `${playhead * 100}%` }} />
        )}
        <svg
          viewBox={`0 0 ${LANE_VB} ${LANE_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={path} vectorEffect="non-scaling-stroke" />
        </svg>
        {nowValue !== null && playhead !== null && (
          <span
            className="perf-take-now"
            style={{ left: `${playhead * 100}%`, top: y(nowValue) }}
          />
        )}
        {lane.samples.map((s, i) => (
          <button
            key={i}
            className="perf-take-point"
            style={{ left: `${(s.t / span) * 100}%`, top: y(s.v) }}
            title={`${s.t.toFixed(2)}s → ${s.v.toFixed(3)} — drag to move`}
            onPointerDown={(e) => {
              if (e.altKey) {
                editTake(take.id, (k) => deletePoint(k, lane.target, i));
                return;
              }
              drag.current = i;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </div>
      <span className="perf-take-lane-meta">
        <select
          className="perf-take-interp mono"
          aria-label={`${label} interpolation`}
          value={lane.interp ?? 'linear'}
          title="How the value moves between keys"
          onChange={(e) =>
            editTake(take.id, (k) =>
              setLaneInterp(k, lane.target, e.target.value as NonNullable<TakeLane['interp']>),
            )
          }
        >
          <option value="linear">LIN</option>
          <option value="hold">HOLD</option>
          <option value="smooth">SMOOTH</option>
        </select>
        <em className="perf-take-now-value" title="value at the playhead">
          {nowValue === null ? '—' : nowValue.toFixed(2)}
        </em>
        {lane.samples.length}
        <button
          className="perf-take-mini danger"
          title={`Delete the ${label} lane`}
          onClick={() => editTake(take.id, (t) => deleteLane(t, lane.target))}
          aria-label={`Delete ${label} lane`}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
