import { useEffect, useRef, useState } from 'react';
import type { PatternSource } from '@shared/schemas/project';
import type { AlternatePattern, SequencePattern } from '@/pattern/patternTypes';
import {
  canFormatSequence,
  createPatternDraft,
  formatSequencePattern,
  updatePatternDraft,
  type PatternDraft,
} from '@/pattern/miniNotation';
import { updatePatternSource } from '@/pattern/patternSourceActions';

/** Commit a settled edit rather than one history entry per keystroke. */
const COMMIT_DELAY_MS = 320;

/**
 * Mini-notation text box (P7 semantics wired to a real field).
 *
 * The draft lives here, never in the project: an invalid draft stays on
 * screen with its error while the LAST VALID pattern keeps running, so
 * visuals never blink out mid-keystroke. A valid change is committed once
 * the typing settles, and flushed on blur, Enter and unmount so switching
 * workspace can never drop an edit.
 */
export function SequenceEditor({
  source,
  definition,
}: {
  source: PatternSource;
  definition: SequencePattern | AlternatePattern;
}) {
  const editable = canFormatSequence(definition);
  const [draft, setDraft] = useState<PatternDraft>(() => createPatternDraft(definition));
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceId = source.id;

  const flush = useRef<() => void>(() => undefined);
  flush.current = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const text = pending.current;
    pending.current = null;
    if (text === null) return;
    // `changed` is false when the text re-states the committed values (only
    // the whitespace differs, or an edit was typed and undone). Committing
    // that would mark the project dirty and add a history entry for no
    // creative change.
    const parsed = updatePatternDraft(createPatternDraft(definition), text);
    if (parsed.error === null && parsed.changed) {
      updatePatternSource(sourceId, { pattern: parsed.lastValid });
    }
  };

  // A valid pending edit must survive unmount (workspace switch, selecting
  // another pattern) — losing someone's typing is never acceptable.
  useEffect(() => () => flush.current(), []);

  // Follow the project when it changes underneath us (undo, redo, reload)
  // — but never while a local edit is still pending.
  const committedText = editable ? formatSequencePattern(definition) : '';
  const lastCommitted = useRef(committedText);
  useEffect(() => {
    if (committedText === lastCommitted.current) return;
    lastCommitted.current = committedText;
    if (pending.current === null) setDraft(createPatternDraft(definition));
  }, [committedText, definition]);

  if (!editable) {
    return (
      <div className="pat-block">
        <div className="pat-block-head">
          <span className="label">Pattern</span>
          <span className="pat-hint">structured · read only</span>
        </div>
        <div className="pat-readonly mono">
          {definition.values.map((v) => String(v)).join(' ')}
        </div>
        <div className="pat-hint">
          This sequence holds values with no text form. Editing it as text would change it.
        </div>
      </div>
    );
  }

  const onChange = (text: string) => {
    const next = updatePatternDraft(draft, text);
    setDraft(next);
    if (next.error !== null) {
      // Invalid: nothing is scheduled, nothing is committed, and whatever is
      // already in the project keeps rendering.
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    pending.current = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), COMMIT_DELAY_MS);
  };

  const errorId = `pat-error-${source.id}`;
  return (
    <div className="pat-block">
      <div className="pat-block-head">
        <span className="label">Pattern</span>
        <span className="pat-hint">
          {definition.values.length} {definition.type === 'alternate' ? 'cycles' : 'steps'}
        </span>
      </div>
      <input
        className={`pat-text mono${draft.error ? ' invalid' : ''}`}
        value={draft.text}
        spellCheck={false}
        aria-label="Pattern steps"
        aria-invalid={draft.error !== null}
        {...(draft.error ? { 'aria-describedby': errorId } : {})}
        placeholder={definition.type === 'alternate' ? '<0 0.5 1>' : '0 0.25 1 0.25'}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => flush.current()}
        onKeyDown={(e) => {
          // Instrument shortcuts must not fire while typing a pattern.
          e.stopPropagation();
          if (e.key === 'Enter') {
            flush.current();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            pending.current = null;
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            setDraft(createPatternDraft(definition));
            e.currentTarget.blur();
          }
        }}
      />
      {draft.error && (
        <div className="pat-error" id={errorId} role="status">
          <span className="pat-error-title">Invalid · last valid active</span>
          <span className="pat-error-detail">{draft.error.message}</span>
        </div>
      )}
    </div>
  );
}
