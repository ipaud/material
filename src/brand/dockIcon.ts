import { useProjectStore } from '@/state/projectStore';
import { iconPositionForSeed } from './mark';

/**
 * Keep the macOS Dock icon on the project's brand fingerprint. Subscribes to
 * the store, derives the signal position from the seed, and tells main only
 * when it actually changes — main ignores repeats too, so a store churn can
 * never spam `app.dock.setIcon`.
 */
export function startDockIconSync(): () => void {
  let lastPosition = -1;
  const sync = () => {
    const seed = useProjectStore.getState().project.explore.lastSeed ?? 1;
    const position = iconPositionForSeed(seed);
    if (position === lastPosition) return;
    lastPosition = position;
    void window.material.setDockIcon(position);
  };
  sync();
  return useProjectStore.subscribe(sync);
}
