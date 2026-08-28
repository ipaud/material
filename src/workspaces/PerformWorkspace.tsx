import { useUiStore } from '@/state/uiStore';
import { Viewport } from '@/viewport/Viewport';
import { StageOverlay } from '@/performance/ui/StageOverlay';
import { StatusRail } from '@/performance/ui/StatusRail';
import { HudLine } from '@/performance/ui/HudLine';
import { ActionsStrip, LooksStrip, MacrosStrip } from '@/performance/ui/PerformanceWorkspace';

/**
 * PERFORM — play the system. Output dominates; the status rail answers
 * position/tempo/signals/MIDI at a glance; Looks, Macros and Actions are
 * flat strips below. HUD (Tab) collapses everything except output and the
 * trust-critical states.
 */
export function PerformWorkspace() {
  const hud = useUiStore((s) => s.perfHud);

  if (hud) {
    return (
      <div className="workspace workspace-perform hud">
        <main className="perf-stage">
          <Viewport />
          <StageOverlay />
        </main>
        <HudLine />
      </div>
    );
  }

  return (
    <div className="workspace workspace-perform">
      <div className="perf-main">
        <main className="perf-stage">
          <Viewport />
          <StageOverlay />
        </main>
        <StatusRail />
      </div>
      <LooksStrip />
      <MacrosStrip />
      <ActionsStrip />
    </div>
  );
}
