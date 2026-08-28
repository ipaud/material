import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { engine } from './rendering/RenderEngine';
import { useProjectStore } from './state/projectStore';
import { useUiStore } from './state/uiStore';
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
import * as triggerRuntime from './signals/triggerRuntime';
import './styles/global.css';

// Dev-only handle for QA tooling (CDP-driven tests).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __dev: {
      engine,
      useProjectStore,
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
      triggerRuntime,
      lookCore,
      interpolate,
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
