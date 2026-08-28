import { useEffect, useRef, useState } from 'react';

/**
 * Compact numeric field with the same discipline as the pattern text box:
 * the draft lives in local state, and only a VALID value ever reaches the
 * project. Typing `-` or clearing the field mid-edit must not write NaN.
 *
 * Commit on blur or Enter; Escape restores the committed value.
 */
export function NumberField({
  label,
  value,
  suffix,
  integer = false,
  validate,
  onCommit,
  width = 44,
}: {
  label: string;
  value: number;
  suffix?: string;
  integer?: boolean;
  validate?: (value: number) => boolean;
  onCommit: (value: number) => void;
  width?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);

  // Follow the project while the user is not typing (undo, external edit).
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const parsed = Number(draft.trim());
  const valid =
    draft.trim() !== '' &&
    Number.isFinite(parsed) &&
    (!integer || Number.isInteger(parsed)) &&
    (validate?.(parsed) ?? true);

  const commit = () => {
    if (valid && parsed !== value) onCommit(parsed);
    else if (!valid) setDraft(String(value));
  };

  return (
    <label className="pat-num">
      <span className="pat-num-label">{label}</span>
      <input
        className={`pat-num-input mono${valid ? '' : ' invalid'}`}
        style={{ width }}
        value={draft}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={!valid}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          // Keep instrument shortcuts (Space, 1–9, G/B/F…) out of a field
          // someone is typing numbers into.
          e.stopPropagation();
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      {suffix && <span className="pat-num-suffix">{suffix}</span>}
    </label>
  );
}
