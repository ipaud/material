import { useEffect, useRef, useState } from 'react';
import { applyPreset, listAllPresets, saveCurrentAsPreset } from '@/projects/presetActions';
import type { Preset } from '@shared/schemas/preset';

export function PresetBar() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void listAllPresets().then(setPresets);
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (saving) inputRef.current?.focus();
  }, [saving]);

  const commitSave = async () => {
    const trimmed = name.trim();
    setSaving(false);
    setName('');
    if (!trimmed) return;
    await saveCurrentAsPreset(trimmed);
    refresh();
  };

  return (
    <div className="preset-bar">
      <select
        className="select"
        value=""
        aria-label="Apply preset"
        onChange={(e) => {
          const preset = presets.find((p) => p.id === e.target.value);
          if (preset) applyPreset(preset);
        }}
      >
        <option value="" disabled>
          Presets…
        </option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.builtin ? `● ${p.name}` : p.name}
          </option>
        ))}
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
        <button className="vp-btn" onClick={() => setSaving(true)} title="Save current settings as preset">
          + SAVE
        </button>
      )}
    </div>
  );
}
