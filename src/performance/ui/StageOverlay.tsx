import { useEffect, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { useCandidateStore } from '@/performance/candidateRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { liveScheduler } from '@/signals/triggerRuntime';
import { isLookDirty } from '@/performance/lookCore';

type StageState =
  | { kind: 'offline'; text: string }
  | { kind: 'frozen'; text: string }
  | { kind: 'previewing'; text: string }
  | { kind: 'morphing'; text: string }
  | { kind: 'queued'; text: string }
  | null;

/**
 * Corner overlays on the live stage. One state chip, highest priority wins
 * (§5): OFFLINE > FROZEN > PREVIEWING CANDIDATE > MORPH > QUEUED. Never a
 * wall of badges. Detail lives in the status rail; this is the glance.
 */
export function StageOverlay() {
  const project = useProjectStore((s) => s.project);
  const offline = useUiStore((s) => s.offlineSources);
  const previewing = useCandidateStore((s) => s.previewing);
  const candidate = useCandidateStore((s) => s.candidate);
  const anyFrozen = project.modulations.some((m) => m.frozenValue !== null);

  // Morph/queue live outside React — poll at UI rate, commit only on change.
  const [runtime, setRuntime] = useState<{ morph: string | null; queued: string | null }>({
    morph: null,
    queued: null,
  });
  useEffect(() => {
    const timer = setInterval(() => {
      const morph = morphRuntime.current ? `MORPH → ${morphRuntime.current.targetLabel}` : null;
      const pending = liveScheduler.getPending()[0];
      const queued = pending
        ? pending.mapping.action === 'applyLook'
          ? `LOOK ${pending.mapping.lookSlot ?? '?'} QUEUED`
          : `${pending.mapping.action.replace(/([A-Z])/g, ' $1').toUpperCase()} QUEUED`
        : null;
      setRuntime((prev) =>
        prev.morph === morph && prev.queued === queued ? prev : { morph, queued },
      );
    }, 150);
    return () => clearInterval(timer);
  }, []);

  const sourceOffline =
    project.composition.sourceId !== null && offline.includes(project.composition.sourceId);
  const state: StageState = sourceOffline
    ? { kind: 'offline', text: 'MEDIA OFFLINE' }
    : anyFrozen
      ? { kind: 'frozen', text: '■ FROZEN' }
      : previewing && candidate
        ? { kind: 'previewing', text: 'PREVIEWING CANDIDATE' }
        : runtime.morph
          ? { kind: 'morphing', text: runtime.morph }
          : runtime.queued
            ? { kind: 'queued', text: runtime.queued }
            : null;

  const activeLook = project.activeLookId
    ? (project.pinnedLooks.find((l) => l.id === project.activeLookId) ?? null)
    : null;
  const dirty = activeLook ? isLookDirty(project, activeLook) : false;

  return (
    <>
      <div className="stage-look-chip mono">
        {activeLook ? (
          <>
            {activeLook.slot != null && <span className="stage-look-slot">{activeLook.slot}</span>}
            {activeLook.label}
            {dirty && <span className="stage-look-dirty"> ●</span>}
          </>
        ) : (
          <span className="stage-look-none">NO LOOK</span>
        )}
      </div>
      {state && <div className={`stage-state-chip mono ${state.kind}`}>{state.text}</div>}
    </>
  );
}
