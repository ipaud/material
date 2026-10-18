import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  parseCsvMarkers,
  parseEdlMarkers,
  parseFcpxmlMarkers,
  parseMarkers,
  timecodeToSec,
} from '@/timeline/markerImport';

describe('timecodeToSec', () => {
  it('reads seconds, mm:ss.ms, hh:mm:ss and frame timecode', () => {
    expect(timecodeToSec('12.5', 25)).toBe(12.5);
    expect(timecodeToSec('1:02.5', 25)).toBeCloseTo(62.5, 6);
    expect(timecodeToSec('00:01:02', 25)).toBe(62);
    expect(timecodeToSec('00:01:02:12', 25)).toBeCloseTo(62.48, 6);
    expect(timecodeToSec('00:00:01;15', 30)).toBeCloseTo(1.5, 6);
  });
  it('returns null for junk', () => {
    expect(timecodeToSec('hello', 25)).toBeNull();
    expect(timecodeToSec('', 25)).toBeNull();
  });
});

describe('CSV', () => {
  it('reads time,label[,group] with or without a header, any common delimiter', () => {
    const text = 'time,label,group\n1.5,Kick,drums\n3,Snare,drums\n0:10,Vox,\n';
    expect(parseCsvMarkers(text, 25)).toEqual([
      { timeSec: 1.5, label: 'Kick', group: 'drums' },
      { timeSec: 3, label: 'Snare', group: 'drums' },
      { timeSec: 10, label: 'Vox' },
    ]);
    expect(parseCsvMarkers('2;A\n4;B', 25).map((m) => m.timeSec)).toEqual([2, 4]);
    expect(parseCsvMarkers('2\tA\n4\tB', 25).map((m) => m.label)).toEqual(['A', 'B']);
  });

  it('handles quoted labels with commas and a bare list of times', () => {
    expect(parseCsvMarkers('1,"Kick, big"\n', 25)).toEqual([{ timeSec: 1, label: 'Kick, big' }]);
    expect(parseCsvMarkers('0.5\n1.5\n', 25).map((m) => m.timeSec)).toEqual([0.5, 1.5]);
  });

  it('skips unparseable rows instead of failing the whole file', () => {
    expect(parseCsvMarkers('1,A\nnope,B\n3,C', 25).map((m) => m.label)).toEqual(['A', 'C']);
  });
});

describe('EDL', () => {
  const edl = [
    'TITLE: Clip',
    'FCM: NON-DROP FRAME',
    '',
    '001  AX       V     C        00:00:00:00 00:00:05:00 01:00:00:00 01:00:05:00',
    '* LOC: 01:00:02:00 RED      Kick',
    '002  AX       V     C        00:00:05:00 00:00:10:00 01:00:05:00 01:00:10:00',
    '* LOC: 01:00:07:12 BLUE     Snare hit',
  ].join('\n');

  it('reads locator markers, colour as group, with a timecode zero', () => {
    expect(parseEdlMarkers(edl, 25, 3600)).toEqual([
      { timeSec: 2, label: 'Kick', group: 'RED' },
      { timeSec: 7.48, label: 'Snare hit', group: 'BLUE' },
    ]);
  });

  it('falls back to cut points when there are no locators', () => {
    const cuts = edl.split('\n').filter((l) => !l.startsWith('* LOC')).join('\n');
    expect(parseEdlMarkers(cuts, 25, 3600).map((m) => m.timeSec)).toEqual([0, 5]);
  });
});

describe('FCPXML', () => {
  const xml = `<?xml version="1.0"?>
<fcpxml version="1.10"><library><event><project><sequence><spine>
  <asset-clip name="A" offset="10s" start="2s" duration="20s">
    <marker start="5s" duration="1/25s" value="Kick"/>
    <chapter-marker start="1001/30000s" duration="1/25s" value="Intro"/>
  </asset-clip>
  <marker start="40s" duration="1/25s" value="Loose"/>
</spine></sequence></project></event></library></fcpxml>`;

  it('maps clip-relative marker times onto the timeline', () => {
    const m = parseFcpxmlMarkers(xml);
    expect(m.find((x) => x.label === 'Kick')!.timeSec).toBeCloseTo(13, 6); // 10 + (5 - 2)
    expect(m.find((x) => x.label === 'Intro')!.timeSec).toBeCloseTo(10 + 1001 / 30000 - 2, 3); // stored to the millisecond
    expect(m.find((x) => x.label === 'Loose')!.timeSec).toBe(40);
  });

  it('rejects malformed XML with a clear error', () => {
    expect(() => parseFcpxmlMarkers('<fcpxml><oops')).toThrow(/XML/i);
  });
});

describe('detectFormat / parseMarkers', () => {
  it('chooses the parser from the content and sorts the result', () => {
    expect(detectFormat('<?xml version="1.0"?><fcpxml/>')).toBe('fcpxml');
    expect(detectFormat('TITLE: x\n001 AX V C 00:00:00:00')).toBe('edl');
    expect(detectFormat('1,A')).toBe('csv');
    const out = parseMarkers('5,B\n1,A', { fps: 25 });
    expect(out.map((m) => m.timeSec)).toEqual([1, 5]);
  });
  it('an empty or unreadable file is an error, not zero markers', () => {
    expect(() => parseMarkers('', { fps: 25 })).toThrow(/no markers/i);
    expect(() => parseMarkers('just some words', { fps: 25 })).toThrow(/no markers/i);
  });
});
