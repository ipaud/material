import { useEffect, useRef, useState } from 'react';
import {
  applyPreset,
  listAllPresets,
  saveCurrentAsPreset,
  unmetRequirementNote,
} from '@/projects/presetActions';
import { useProjectStore } from '@/state/projectStore';
import type { Preset } from '@shared/schemas/preset';

/** CE1A curation order — families read from calm to aggressive. */
const CATEGORY_ORDER = [
  'Minimal',
  'Feedback',
  'Temporal',
  'Optical',
  'Geometry',
  'Analog',
  'Digital Damage',
  'Studies',
  'Live',
  'Performance',
];

export function PresetBar() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sources = useProjectStore((s) => s.project.sources);
  const bpm = useProjectStore((s) => s.project.timeline.bpm);

  const refresh = () => {
    void listAllPresets().then(setPresets);
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (saving) inputRef.current?.select();
  }, [saving]);

  const commitSave = async () => {
    const trimmed = name.trim();
    setSaving(false);
    setName('');
    if (!trimmed) return;
    await saveCurrentAsPreset(trimmed);
    refresh();
  };

  const projectCaps = {
    hasVideo: sources.some((s) => s.kind === 'video'),
    hasAudio: sources.some((s) => s.kind === 'audio'),
    hasBpm: bpm !== null,
  };

  const builtins = presets.filter((p) => p.builtin);
  const userPresets = presets.filter((p) => !p.builtin);

  return (
    <div className="preset-bar-wrap">
      <div className="preset-bar">
        <select
          className="select"
          value=""
          aria-label="Apply preset"
          onChange={(e) => {
            const preset = presets.find((p) => p.id === e.target.value);
            if (!preset) return;
            applyPreset(preset);
            setNote(unmetRequirementNote(preset, projectCaps));
          }}
        >
          <option value="" disabled>
            Presets…
          </option>
          {CATEGORY_ORDER.filter((cat) => builtins.some((p) => p.category === cat)).map(
            (cat) => (
              <optgroup key={cat} label={cat}>
                {builtins
                  .filter((p) => p.category === cat)
                  .map((p) => (
                    <option key={p.id} value={p.id} title={p.description}>
                      {p.name}
                    </option>
                  ))}
              </optgroup>
            ),
          )}
          {userPresets.length > 0 && (
            <optgroup label="Yours">
              {userPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {saving ? (
          <input
            ref={inputRef}
            className="preset-name-input mono"
            value={name}
            placeholder="preset name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitSave()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitSave();
              if (e.key === 'Escape') setSaving(false);
            }}
          />
        ) : (
          <button
            className="vp-btn"
            onClick={() => setSaving(true)}
            title="Save current settings as preset"
          >
            + SAVE
          </button>
        )}
      </div>
      {note && <div className="preset-note">{note} to take full effect.</div>}
    </div>
  );
}
