import { useRef, useState } from 'react';
import { reportError, useUiStore } from '@/state/uiStore';
import { addOnsetMarkers, importMarkers, snapAllMarkersToOnsets } from './markerActions';

const DEFAULT_FPS = 25;
const DEFAULT_THRESHOLD = 0.3;

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

/** Marker import (CSV / EDL / FCPXML), onsets at an adjustable threshold, snap to onsets. */
export function MarkerTools() {
  const pushToast = useUiStore((s) => s.pushToast);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [zeroSec, setZeroSec] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = importMarkers(await readText(file), { fps, zeroSec });
      const skipped = result.skipped > 0 ? `, ${result.skipped} already there` : '';
      pushToast('info', `${result.added} markers imported${skipped}`);
    } catch (err) {
      reportError('Import markers', err);
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        hidden
        aria-label="Import markers file"
        accept=".csv,.txt,.edl,.fcpxml,.xml"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        className="vp-btn"
        onClick={() => fileRef.current?.click()}
        title="Import markers from a CSV (time,label,group), an EDL or an FCPXML. Frame timecode uses the fps and timecode zero set beside this button."
      >
        IMPORT
      </button>
      <input
        className="timeline-num mono"
        type="number"
        min={1}
        max={120}
        step={0.001}
        value={fps}
        aria-label="Import frame rate"
        title="Frame rate for frame timecodes in the imported file"
        onChange={(e) => setFps(Number(e.target.value) || DEFAULT_FPS)}
      />
      <input
        className="timeline-num mono"
        type="number"
        min={0}
        step={1}
        value={zeroSec}
        aria-label="Timecode zero (seconds)"
        title="EDL: the timecode that means 0 s, in seconds (3600 for a 01:00:00:00 start)"
        onChange={(e) => setZeroSec(Math.max(Number(e.target.value) || 0, 0))}
      />
      <input
        className="timeline-num mono"
        type="number"
        min={0.05}
        max={0.95}
        step={0.05}
        value={threshold}
        aria-label="Onset threshold"
        title="Onset sensitivity: lower finds more hits, higher keeps only the strong ones"
        onChange={(e) => setThreshold(Math.min(Math.max(Number(e.target.value) || DEFAULT_THRESHOLD, 0.05), 0.95))}
      />
      <button
        className="vp-btn"
        onClick={() => {
          try {
            const n = addOnsetMarkers(threshold);
            pushToast('info', n === 0 ? 'No new onsets at this threshold' : `${n} onset markers added`);
          } catch (err) {
            reportError('Onsets to markers', err);
          }
        }}
        title="Add one marker per detected onset at the threshold"
      >
        ONSETS → MARKERS
      </button>
      <button
        className="vp-btn"
        onClick={() => {
          const n = snapAllMarkersToOnsets();
          pushToast('info', n === 0 ? 'Nothing to snap' : `${n} markers snapped to onsets`);
        }}
        title="Move every marker within 0.25 s of an onset onto it"
      >
        SNAP TO ONSETS
      </button>
    </>
  );
}
