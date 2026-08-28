import type { SequencePattern } from './patternTypes';

/**
 * Pattern Engine P7 — mini-notation for Sequence patterns.
 *
 * An INPUT layer, never a runtime representation:
 *
 *   editor text → parse → PatternDefinition → compilePattern → evaluation
 *
 * The structured definition stays the canonical persisted form; raw text is
 * never stored in a project, so there is exactly one source of truth and a
 * later grammar change cannot invalidate saved work. Opening an editor
 * formats the definition back to canonical text.
 *
 * The grammar is deliberately boring and closed:
 *
 *   sequence := number ( whitespace number )*
 *   number   := '-'? ( digits ( '.' digits? )? | '.' digits )
 *
 * Numbers only, dot decimal separator only (locale-independent by
 * construction), no exponents, no '+' sign, no brackets, no operators, no
 * transforms, no Euclidean shorthand. Euclidean and transforms already have
 * structured models and get real controls in P8; keeping them out of the
 * text box is what stops this from becoming a language.
 *
 * Parsing is an explicit character scanner with no dynamic code evaluation
 * of any kind and no regex backtracking. It runs on edit, never per frame.
 */

export interface PatternParseError {
  /** Editor-facing single line, e.g. `Unexpected token "nope" at position 5`. */
  message: string;
  /** Character offset of the offending token (0-based). */
  index: number;
  /** Length of the offending token — enough to underline it in P8. */
  length: number;
  /** The raw offending text, or '' for "unexpected end". */
  token: string;
}

export type ParsePatternResult =
  | { ok: true; definition: SequencePattern }
  | { ok: false; error: PatternParseError };

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
/** Whitespace = anything JS considers space; only space/tab/newline documented. */
const isSpace = (c: string): boolean => /\s/.test(c);

function fail(token: string, index: number, message: string): ParsePatternResult {
  return { ok: false, error: { message, index, length: token.length, token } };
}

/** Read one whitespace-delimited chunk starting at `start`. */
function readToken(text: string, start: number): string {
  let end = start;
  while (end < text.length && !isSpace(text[end]!)) end++;
  return text.slice(start, end);
}

/**
 * Validate a token against the numeric grammar and return its value.
 * Returns null when the token is not a well-formed number — `Number()` is
 * far more permissive than this grammar (it accepts `1e3`, `0x10`, `''`,
 * `Infinity`), so the grammar check has to come first, never the coercion.
 */
function parseNumberToken(token: string): number | null {
  let i = 0;
  if (token[i] === '-') i++;
  let digitsBefore = 0;
  while (i < token.length && isDigit(token[i]!)) {
    i++;
    digitsBefore++;
  }
  let digitsAfter = 0;
  if (token[i] === '.') {
    i++;
    while (i < token.length && isDigit(token[i]!)) {
      i++;
      digitsAfter++;
    }
  }
  // Every character must be consumed, and there must be at least one digit
  // somewhere: '.', '-', '-.' and '1..2' all fail here.
  if (i !== token.length || digitsBefore + digitsAfter === 0) return null;
  const value = Number(token);
  if (!Number.isFinite(value)) return null;
  // -0 is not creative meaning; normalize so formatting and equality behave.
  return value === 0 ? 0 : value;
}

/** Parse mini-notation into a Sequence definition. Never throws. */
export function parsePattern(text: string): ParsePatternResult {
  const values: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i]!)) {
      i++;
      continue;
    }
    const token = readToken(text, i);
    const value = parseNumberToken(token);
    if (value === null) {
      return fail(token, i, `Unexpected token "${token}" at position ${i}`);
    }
    values.push(value);
    i += token.length;
  }
  if (values.length === 0) {
    // An empty sequence would compile to nothing and silently kill the
    // signal — an empty box is an error the editor can show, not a pattern.
    return fail('', 0, 'Pattern is empty — type at least one number');
  }
  return { ok: true, definition: { type: 'sequence', values } };
}

/**
 * Canonical number text. `String(n)` already gives the shortest round-trip
 * decimal (`0.25`, `-0.25`, `2`, `12.5`), which is exactly the canonical
 * form — with a conventional leading zero even though the parser also
 * accepts `.25`, because a leading zero reads less surprisingly when a
 * project is reopened.
 */
function formatNumber(value: number): string {
  return String(value === 0 ? 0 : value);
}

/**
 * True when a definition can be represented in mini-notation at all:
 * numeric, finite, and not large enough to force exponent notation (the
 * grammar has no exponents). Booleans are engine-valid but have no text
 * form in P7 — P8 shows those sequences read-only rather than lying about
 * being editable.
 */
export function canFormatSequence(definition: SequencePattern): boolean {
  return definition.values.every(
    (v) => typeof v === 'number' && Number.isFinite(v) && !formatNumber(v).includes('e'),
  );
}

/** Structured definition → canonical editable text. */
export function formatSequencePattern(definition: SequencePattern): string {
  return definition.values
    .map((v) => (typeof v === 'number' ? formatNumber(v) : String(v)))
    .join(' ');
}

// ---- Live-edit draft ----------------------------------------------------

/**
 * A text editing session over one pattern. Immutable: every keystroke makes
 * a new draft, and only `definition` changes are worth committing to the
 * project.
 *
 * `lastValid` is the policy that matters live: while the text is
 * mid-keystroke garbage (`0 .5 1 .`), the runtime must keep rendering the
 * previous valid pattern rather than dropping to neutral — visuals must not
 * blink out because someone is typing. So the project is only updated when
 * `changed` is true.
 */
export interface PatternDraft {
  text: string;
  /** Last successfully parsed definition — what the runtime should use. */
  lastValid: SequencePattern;
  error: PatternParseError | null;
  /** True when this update produced a NEW definition worth committing. */
  changed: boolean;
}

export function createPatternDraft(definition: SequencePattern): PatternDraft {
  return {
    text: formatSequencePattern(definition),
    lastValid: definition,
    error: null,
    changed: false,
  };
}

export function updatePatternDraft(draft: PatternDraft, text: string): PatternDraft {
  const result = parsePattern(text);
  if (!result.ok) {
    return { text, lastValid: draft.lastValid, error: result.error, changed: false };
  }
  const changed = !sameValues(draft.lastValid, result.definition);
  return {
    text,
    lastValid: changed ? result.definition : draft.lastValid,
    error: null,
    changed,
  };
}

function sameValues(a: SequencePattern, b: SequencePattern): boolean {
  if (a.values.length !== b.values.length) return false;
  return a.values.every((v, i) => v === b.values[i]);
}
