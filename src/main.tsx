import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { engine } from './rendering/RenderEngine';
import { useProjectStore } from './state/projectStore';
import { useUiStore } from './state/uiStore';
import { runtimeBus } from './runtime/RuntimeBus';
import { patternClockAt, timingFromTimeline } from './pattern/patternClock';
import { compilePattern } from './pattern/compilePattern';
import { evaluatePattern } from './pattern/evaluatePattern';
import { patternRandom01 } from './pattern/patternRandom';
import { formatSequencePattern, parsePattern } from './pattern/miniNotation';
import { getPatternCompileCount, getPatternDiagnostics } from './pattern/patternSourceRuntime';
import { useOutputStore } from './state/outputStore';
import { importMediaPaths, openProjectFromPath } from './projects/projectActions';
import { modulationRuntime } from './modulation/runtime';
import * as modulationActions from './modulation/modulationActions';
import { playback } from './playback/PlaybackController';
import { createFrameEvaluator, runAnimationExport } from './export/exportRunner';
import { useExportStore } from './state/exportStore';
import * as presetActions from './projects/presetActions';
import { analyzeBuffer, sampleTrack } from './audio/analysis';
import { detectTempo } from './audio/tempo';
import { useAudioStore } from './state/audioStore';
import { morphRuntime } from './performance/morphRuntime';
import * as lookCore from './performance/lookCore';
import * as interpolate from './performance/interpolate';
import * as lookActions from './projects/lookActions';
import * as performanceActions from './performance/performanceActions';
import { candidateRuntime, useCandidateStore } from './performance/candidateRuntime';
import * as mutation from './performance/mutation';
import * as triggerRuntime from './signals/triggerRuntime';
import { midiEngine, useMidiStore } from './midi/midiEngine';
import { FakeMidiTransport, WebMidiTransport } from './midi/transport';
import { cameraManager, useCameraStore } from './sources/cameraManager';
import './styles/global.css';

// Dev-only handle for QA tooling (CDP-driven tests).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __dev: {
      engine,
      runtimeBus,
      useOutputStore,
      /** Pattern Engine P2: pure compile/evaluate surface (read-only, dev). */
      patternEngine: {
        compilePattern,
        evaluatePattern,
        patternRandom01,
        /** P4: last-evaluated state of each live pattern source. */
        sources: getPatternDiagnostics,
        compileCount: getPatternCompileCount,
        /** P7: mini-notation (read-only helpers, no project mutation). */
        parse: parsePattern,
        format: formatSequencePattern,
      },
      /** Pattern Engine P1: inspect the pure clock at any composition time. */
      patternClock: {
        at(timeSec?: number, beatsPerCycle?: number) {
          const t = timeSec ?? playback.getTime();
          const timing = timingFromTimeline(useProjectStore.getState().project.timeline);
          return patternClockAt(t, timing, beatsPerCycle);
        },
      },
      useProjectStore,
      /** 18D: camera lifecycle (QA drives the same path as the UI). */
      cameraManager,
      useCameraStore,
      useUiStore,
      importMediaPaths,
      openProjectFromPath,
      modulationRuntime,
      modulationActions,
      playback,
      createFrameEvaluator,
      runAnimationExport,
      useExportStore,
      presetActions,
      analyzeBuffer,
      detectTempo,
      sampleTrack,
      useAudioStore,
      morphRuntime,
      lookActions,
      performanceActions,
      candidateRuntime,
      useCandidateStore,
      mutation,
      triggerRuntime,
      lookCore,
      interpolate,
      midiEngine,
      useMidiStore,
      FakeMidiTransport,
      WebMidiTransport,
    },
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
