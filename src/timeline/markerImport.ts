/**
 * Marker import: CSV, EDL (locators or cut points) and FCPXML. Pure parsing —
 * nothing here touches the project; the caller decides how to merge.
 */
export interface ImportedMarker {
  timeSec: number;
  label: string;
  group?: string;
}

export type MarkerFormat = 'csv' | 'edl' | 'fcpxml';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Seconds, `m:ss.ms`, `h:m:s`, or frame timecode `h:m:s:f` (`;` accepted, not true drop-frame). */
export function timecodeToSec(raw: string, fps: number): number | null {
  const s = raw.trim().replace(/;/g, ':');
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number) as [number, number, number?, number?];
  if (parts.length === 2) return n[0] * 60 + n[1];
  if (parts.length === 3) return n[0] * 3600 + n[1] * 60 + (n[2] as number);
  return n[0] * 3600 + n[1] * 60 + (n[2] as number) + (n[3] as number) / fps;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

export function parseCsvMarkers(text: string, fps: number): ImportedMarker[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const first = lines[0] as string;
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const out: ImportedMarker[] = [];
  for (const line of lines) {
    const [time = '', label = '', group = ''] = splitCsvLine(line, delimiter);
    const timeSec = timecodeToSec(time, fps);
    if (timeSec === null) continue; // header or junk row
    out.push({
      timeSec: round3(timeSec),
      label: label || `M${out.length + 1}`,
      ...(group ? { group } : {}),
    });
  }
  return out;
}

/** CMX3600: `* LOC:` locators (colour becomes the group); cut points when there are none. */
export function parseEdlMarkers(text: string, fps: number, zeroSec = 0): ImportedMarker[] {
  const locators: ImportedMarker[] = [];
  const cuts: ImportedMarker[] = [];
  for (const line of text.split(/\r?\n/)) {
    const loc = /^\*\s*LOC:\s*(\S+)\s+(\S+)\s*(.*)$/i.exec(line.trim());
    if (loc) {
      const t = timecodeToSec(loc[1] as string, fps);
      if (t === null) continue;
      const color = loc[2] as string;
      locators.push({ timeSec: round3(t - zeroSec), label: (loc[3] as string).trim() || color, group: color });
      continue;
    }
    const event = /^\d{3,}\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+/.exec(line.trim());
    if (event) {
      const t = timecodeToSec(event[1] as string, fps);
      if (t !== null) cuts.push({ timeSec: round3(t - zeroSec), label: `cut ${cuts.length + 1}` });
    }
  }
  return (locators.length > 0 ? locators : cuts).filter((m) => m.timeSec >= 0);
}

function rational(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
}

/** `<marker>` / `<chapter-marker>`; a clip-relative time is placed using its clip's offset and start. */
export function parseFcpxmlMarkers(text: string): ImportedMarker[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Invalid XML in the FCPXML file');
  const out: ImportedMarker[] = [];
  const nodes = [...doc.getElementsByTagName('marker'), ...doc.getElementsByTagName('chapter-marker')];
  for (const node of nodes) {
    const start = rational(node.getAttribute('start'));
    if (start === null) continue;
    let timeSec = start;
    for (let p = node.parentElement; p; p = p.parentElement) {
      const offset = rational(p.getAttribute('offset'));
      const clipStart = rational(p.getAttribute('start'));
      if (offset !== null && clipStart !== null) {
        timeSec = offset + (start - clipStart);
        break;
      }
    }
    out.push({ timeSec: round3(timeSec), label: node.getAttribute('value') ?? `M${out.length + 1}` });
  }
  return out;
}

export function detectFormat(text: string): MarkerFormat {
  const head = text.trimStart();
  if (head.startsWith('<')) return 'fcpxml';
  if (/^TITLE:/m.test(head) || /^\*\s*LOC:/im.test(head) || /^\d{3,}\s+\S+\s+\S+\s+\S+\s+\d/m.test(head)) {
    return 'edl';
  }
  return 'csv';
}

export interface ParseOptions {
  fps: number;
  /** EDL timecode that means 0 s (e.g. 3600 for a 01:00:00:00 start). */
  zeroSec?: number;
}

export function parseMarkers(text: string, options: ParseOptions): ImportedMarker[] {
  const format = detectFormat(text);
  const markers =
    format === 'fcpxml'
      ? parseFcpxmlMarkers(text)
      : format === 'edl'
        ? parseEdlMarkers(text, options.fps, options.zeroSec ?? 0)
        : parseCsvMarkers(text, options.fps);
  if (markers.length === 0) throw new Error(`No markers found (read as ${format.toUpperCase()})`);
  return markers.sort((a, b) => a.timeSec - b.timeSec);
}
