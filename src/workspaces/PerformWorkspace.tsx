import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { Viewport } from '@/viewport/Viewport';
import { WorkspaceEmpty } from '@/components/WorkspaceEmpty';
import { StageOverlay } from '@/performance/ui/StageOverlay';
import { StatusRail } from '@/performance/ui/StatusRail';
import { HudLine } from '@/performance/ui/HudLine';
import { ActionsStrip, LooksStrip, MacrosStrip } from '@/performance/ui/PerformanceWorkspace';
import { LayerStrip } from '@/performance/ui/LayerStrip';

/**
 * PERFORM — play the system. Output dominates; the status rail answers
 * position/tempo/signals/MIDI at a glance; Looks, Macros and Actions are
 * flat strips below. HUD (Tab) collapses everything except output and the
 * trust-critical states.
 */
export function PerformWorkspace() {
  const hud = useUiStore((s) => s.perfHud);
  const hasSource = useProjectStore((s) => s.project.composition.sourceId !== null);

  if (!hasSource) {
    return (
      <div className="workspace workspace-perform">
        <main className="perf-stage empty-stage">
          <WorkspaceEmpty
            title="BUILD A SYSTEM FIRST"
            hint="PERFORM plays pinned Looks and Macros — there is nothing to play yet"
          />
        </main>
      </div>
    );
  }

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
      <LayerStrip />
      <LooksStrip />
      <MacrosStrip />
      <ActionsStrip />
    </div>
  );
}
