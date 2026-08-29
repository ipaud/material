import { useEffect } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useMenuEvents } from '@/hooks/useMenuEvents';
import { useMediaDrop } from '@/hooks/useMediaDrop';
import { usePerformanceKeys } from '@/hooks/usePerformanceKeys';
import { useWorkspaceKeys } from '@/hooks/useWorkspaceKeys';
import { TitleBar } from './TitleBar';
import { Toasts } from './Toasts';
import { RecoveryPrompt } from './RecoveryPrompt';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { WorkspaceRouter } from '@/workspaces/WorkspaceRouter';
import { ExportDialog } from '@/export/ExportDialog';
import { startAutosave } from '@/projects/autosave';
import { cameraManager } from '@/sources/cameraManager';
import { startOutputBridge } from '@/output/outputBridge';
import { startDockIconSync } from '@/brand/dockIcon';
import { midiEngine } from '@/midi/midiEngine';
import { WebMidiTransport } from '@/midi/transport';
import './app.css';

export function App() {
  useMenuEvents();
  usePerformanceKeys();
  useWorkspaceKeys();
  useEffect(() => startAutosave(), []);
  useEffect(() => startOutputBridge(), []);
  useEffect(() => startDockIconSync(), []);
  // 18D: window teardown must stop camera tracks — the OS camera indicator
  // must never outlive the editor (reload, quit, window close).
  useEffect(() => {
    const stopCamera = () => cameraManager.detach();
    window.addEventListener('beforeunload', stopCamera);
    return () => window.removeEventListener('beforeunload', stopCamera);
  }, []);
  // §25: request MIDI only when needed — a project that ships MIDI mappings
  // needs the controller live; otherwise the user opts in from the panel.
  useEffect(() => {
    const check = () => {
      if (!midiEngine.isRunning && useProjectStore.getState().project.midiMappings.length > 0) {
        void midiEngine.start(new WebMidiTransport());
      }
    };
    check();
    const unsub = useProjectStore.subscribe(check);
    return unsub;
  }, []);
  const { isDragOver, onDragOver, onDragLeave, onDrop } = useMediaDrop();

  return (
    <div className="app" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <TitleBar />
      <WorkspaceRouter isDragOver={isDragOver} />
      <Toasts />
      <ExportDialog />
      <RecoveryPrompt />
      <ShortcutsOverlay />
    </div>
  );
}
