import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';
import { parseControlTarget } from '@/performance/take/model';
import { takeStats, deleteEvent, deleteLane, moveEvent, movePoint, simplifyTake, trimTake } from '@/performance/take/edit';
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

const LANE_W = 320;
const LANE_H = 26;

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
  const name = layer?.name || `LAYER ${project.layers.indexOf(layer!) + 1}`;
  return parsed.kind === 'layerOpacity' ? `${name} · OPACITY` : `${name} · ${parsed.paramId}`;
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
      <div className="perf-take-ruler" style={{ width: LANE_W }}>
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
          playhead={inside ? playhead : null}
        />
      ))}

      <div className="perf-take-tools">
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
        style={{ width: LANE_W, height: LANE_H }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const t = ((e.clientX - rect.left) / rect.width) * span;
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
    </div>
  );
}

function LaneRow({
  take,
  lane,
  label,
  playhead,
}: {
  take: PerformanceTake;
  lane: TakeLane;
  label: string;
  playhead: number | null;
}) {
  const drag = useRef<number | null>(null);
  const span = Math.max(take.durationSec, 1e-6);
  const values = lane.samples.map((s) => s.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const range = hi - lo || 1;
  const x = (t: number) => (t / span) * LANE_W;
  const y = (v: number) => LANE_H - 3 - ((v - lo) / range) * (LANE_H - 6);
  const path = lane.samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join(' ');

  return (
    <div className="perf-take-row">
      <span className="perf-take-lane-label" title={label}>
        {label}
      </span>
      <div
        className="perf-take-lane"
        style={{ width: LANE_W, height: LANE_H }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const t = ((e.clientX - rect.left) / rect.width) * span;
          const v = lo + (1 - (e.clientY - rect.top) / rect.height) * range;
          editTake(take.id, (k) => movePoint(k, lane.target, drag.current as number, t, v));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        {playhead !== null && (
          <span className="perf-take-playhead" style={{ left: `${playhead * 100}%` }} />
        )}
        <svg width={LANE_W} height={LANE_H} aria-hidden="true">
          <path d={path} />
        </svg>
        {lane.samples.map((s, i) => (
          <button
            key={i}
            className="perf-take-point"
            style={{ left: x(s.t), top: y(s.v) }}
            title={`${s.t.toFixed(2)}s → ${s.v.toFixed(3)} — drag to move`}
            onPointerDown={(e) => {
              drag.current = i;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </div>
      <span className="perf-take-lane-meta">
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
