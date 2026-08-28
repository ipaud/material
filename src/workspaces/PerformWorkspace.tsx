import { Viewport } from '@/viewport/Viewport';
import { PerformanceWorkspace } from '@/performance/ui/PerformanceWorkspace';

/**
 * PERFORM — play the system. The validated v0.2 performance surface, unchanged;
 * its visual pass is Phase D.
 */
export function PerformWorkspace() {
  return (
    <div className="workspace workspace-perform">
      <main className="viewport-area">
        <Viewport />
      </main>
      <PerformanceWorkspace />
    </div>
  );
}
