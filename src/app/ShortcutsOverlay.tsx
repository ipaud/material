import { useEffect } from 'react';
import { useUiStore } from '@/state/uiStore';

/**
 * Shortcut reference (Phase 17 §34). Not a tutorial system — a card you can
 * glance at mid-set and dismiss. Kept in sync with docs/SHORTCUTS.md.
 */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Global',
    rows: [
      ['⌘⌥1 – ⌘⌥4', 'BUILD · EXPLORE · PERFORM · OUTPUT'],
      ['Space', 'Play / pause'],
      ['`  (hold)', 'A/B — show the untouched source'],
      ['⌘S / ⌘⇧S', 'Save / Save as'],
      ['⌘O / ⌘I', 'Open project / Import media'],
      ['⌘E', 'Export'],
      ['⌘Z / ⌘⇧Z', 'Undo / Redo'],
      ['⌘D', 'Debug overlay'],
      ['?', 'This overlay'],
    ],
  },
  {
    title: 'Looks (everywhere)',
    rows: [
      ['1 – 9', 'Apply the Look in that slot'],
      ['⇧1 – ⇧9', 'Overwrite that slot with the current state'],
      ['P', 'Pin the current state as a Look'],
      ['F', 'Freeze / release all modulated values'],
    ],
  },
  {
    title: 'Candidate (Explore + Perform)',
    rows: [
      ['G', 'Mutate from CURRENT'],
      ['⇧G', 'Mutate again from the candidate'],
      ['B  (hold)', 'Audition — release returns to CURRENT'],
      ['Enter', 'Apply the candidate'],
      ['⌫', 'Discard the candidate'],
    ],
  },
  {
    title: 'Perform only',
    rows: [
      ['Q', 'Cycle quantization'],
      ['M', 'Morph to the selected target'],
      ['Z X C V', 'Trigger pads 1–4'],
      ['Tab', 'Minimal HUD'],
      ['Esc', 'Cancel queued actions / keep a morph'],
    ],
  },
];

export function ShortcutsOverlay() {
  const open = useUiStore((s) => s.showShortcuts);
  const toggle = useUiStore((s) => s.toggleShortcuts);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toggle]);

  if (!open) return null;
  return (
    <div
      className="shortcuts-backdrop"
      onClick={toggle}
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="shortcuts-card" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <span className="label">Shortcuts</span>
          <button className="vp-btn" onClick={toggle} aria-label="Close shortcuts">
            ✕
          </button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <span className="shortcuts-group-title">{group.title}</span>
              {group.rows.map(([key, what]) => (
                <div key={key} className="shortcuts-row">
                  <span className="shortcuts-key mono">{key}</span>
                  <span className="shortcuts-what">{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="shortcuts-foot">
          Live controls — knobs, pads, keys — are not recorded. Exports render the project&rsquo;s
          deterministic state.
        </p>
      </div>
    </div>
  );
}
