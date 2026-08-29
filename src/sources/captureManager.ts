import { create } from 'zustand';
import type { CaptureWindowInfo } from '@shared/ipc';
import type { DisplayInfo } from '@shared/display';
import { engine } from '@/rendering/RenderEngine';
import { reportError } from '@/state/uiStore';
import { DisplayCaptureSource } from './DisplayCaptureSource';
import type { SourceRuntimeStatus } from './SourceRuntime';

/**
 * Screen/window capture lifecycle authority (18E). Mirrors cameraManager —
 * one active capture, user-intent driven:
 *
 *   attach(sourceId, kind, displayId)  project selected the source — IDLE,
 *                                      nothing acquired, no TCC touched
 *   chooseWindow()                     the explicit enumeration action (the
 *                                      first call may raise the macOS screen
 *                                      recording prompt — never automatic)
 *   start()                            the explicit user action; arms the
 *                                      main gate with the exact target,
 *                                      acquires, goes LIVE
 *   stop()/detach()                    symmetric teardown; gate + the
 *                                      Output's rejoin grant both revoked
 *
 * Window identity is EPHEMERAL: the chosen OS capture id lives only in this
 * manager for the current selection round. The project persists a human
 * `titleHint` — reopening always requires an explicit re-selection (§14).
 */

export interface CaptureUiState {
  sourceId: string | null;
  kind: 'screen' | 'window' | null;
  status: SourceRuntimeStatus | 'idle';
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /** Capturable windows from the last CHOOSE WINDOW round (ephemeral ids). */
  windows: CaptureWindowInfo[];
  /** Ephemeral OS id the user picked for this round; null = not chosen. */
  chosenWindowId: string | null;
  /** Displays for the SCREEN picker (Electron screen module — no TCC). */
  displays: DisplayInfo[];
}

const NEUTRAL: Omit<CaptureUiState, 'sourceId' | 'kind'> = {
  status: 'idle',
  width: null,
  height: null,
  frameRate: null,
  windows: [],
  chosenWindowId: null,
  displays: [],
};

export const useCaptureStore = create<CaptureUiState>(() => ({
  sourceId: null,
  kind: null,
  ...NEUTRAL,
}));

class CaptureManager {
  private runtime: DisplayCaptureSource | null = null;
  private attachedSourceId: string | null = null;
  private attachedKind: 'screen' | 'window' | null = null;
  private preferredDisplayId: number | null = null;

  /** Project selected a screen/window source. Idle by design. */
  attach(sourceId: string, kind: 'screen' | 'window', displayId: number | null): void {
    if (
      this.attachedSourceId === sourceId &&
      this.attachedKind === kind &&
      this.preferredDisplayId === displayId
    ) {
      return;
    }
    const wasLive = this.runtime?.status === 'live';
    this.teardownRuntime();
    this.attachedSourceId = sourceId;
    this.attachedKind = kind;
    this.preferredDisplayId = displayId;
    useCaptureStore.setState({ sourceId, kind, ...NEUTRAL });
    if (kind === 'screen') void this.refreshDisplays();
    // Same screen source re-attached with a new display while live: restart
    // onto it (explicit user choice = intent). Windows never restart
    // implicitly — their target id is ephemeral and per-round.
    if (wasLive && kind === 'screen' && this.attachedSourceId === sourceId) void this.start();
  }

  detach(): void {
    if (this.attachedSourceId === null) return;
    this.teardownRuntime();
    this.attachedSourceId = null;
    this.attachedKind = null;
    this.preferredDisplayId = null;
    useCaptureStore.setState({ sourceId: null, kind: null, ...NEUTRAL });
  }

  /** SCREEN picker data — Electron display list, no permission involved. */
  async refreshDisplays(): Promise<void> {
    try {
      const displays = await window.material.outputDisplays();
      useCaptureStore.setState({ displays });
    } catch {
      // Non-fatal; the START path falls back to the primary display.
    }
  }

  /** THE explicit enumeration action for WINDOW (may raise TCC — once). */
  async chooseWindow(): Promise<void> {
    if (this.attachedKind !== 'window') return;
    try {
      const windows = await window.material.listCaptureWindows();
      useCaptureStore.setState({ windows });
    } catch (err) {
      reportError('Window capture', err);
      useCaptureStore.setState({ windows: [] });
    }
  }

  /** User picked a window for this round (ephemeral id, never persisted). */
  selectWindow(sourceId: string): void {
    useCaptureStore.setState({ chosenWindowId: sourceId });
  }

  /** THE user action. Arms the gate with the exact target, acquires. */
  async start(): Promise<void> {
    if (!this.attachedSourceId || !this.attachedKind) return;
    const kind = this.attachedKind;
    const chosenWindowId = useCaptureStore.getState().chosenWindowId;
    if (kind === 'window' && !chosenWindowId) return; // nothing chosen yet
    this.teardownRuntime();

    const runtime = new DisplayCaptureSource(kind === 'screen' ? 'live-screen' : 'live-window');
    this.runtime = runtime;
    runtime.onStatus((status) => this.onRuntimeStatus(runtime, status));
    useCaptureStore.setState({ status: 'connecting' });

    await window.material.setCaptureIntent(
      kind === 'screen'
        ? { kind: 'screen', displayId: this.preferredDisplayId }
        : { kind: 'window', sourceId: chosenWindowId as string },
    );
    try {
      await runtime.connect();
    } catch (err) {
      // Status is already precise; the gate must not stay armed (and the
      // Output must gain no rejoin grant) after a failed start.
      await window.material.setCaptureIntent(null);
      const name = (err as DOMException)?.name;
      const message = (err as DOMException)?.message ?? '';
      const isPermissionShape =
        name === 'NotAllowedError' ||
        name === 'OverconstrainedError' ||
        message.includes('Invalid capture constraints');
      if (!isPermissionShape) reportError('Capture', err);
      return;
    }
    if (this.runtime !== runtime) return; // stopped while connecting

    engine.setSource(runtime.texture());
    engine.setLiveSourceActive(true);
    void window.material.setLiveness('live-source', true);
    useCaptureStore.setState({
      status: 'live',
      width: runtime.width,
      height: runtime.height,
      frameRate: runtime.frameRate,
    });
  }

  stop(): void {
    this.teardownRuntime();
    if (this.attachedSourceId) useCaptureStore.setState({ status: 'idle' });
  }

  /** Restart onto another display (explicit user choice = intent). */
  async selectDisplay(displayId: number): Promise<void> {
    this.preferredDisplayId = displayId;
    if (this.runtime) await this.start();
  }

  isLive(): boolean {
    return this.runtime?.status === 'live';
  }

  texture() {
    return this.runtime?.texture() ?? null;
  }

  private onRuntimeStatus(runtime: DisplayCaptureSource, status: SourceRuntimeStatus): void {
    if (this.runtime !== runtime) return;
    if (status === 'device-lost') {
      // Captured window closed / display unplugged: neutral source, both
      // gates revoked, one clean status. Never auto-capture something else.
      engine.setSource(null);
      engine.setLiveSourceActive(false);
      void window.material.setLiveness('live-source', false);
      void window.material.setCaptureIntent(null);
      useCaptureStore.setState({
        status: 'device-lost',
        width: null,
        height: null,
        frameRate: null,
        chosenWindowId: null,
      });
    } else if (status !== 'live' && status !== 'connecting') {
      useCaptureStore.setState({ status });
    }
  }

  private teardownRuntime(): void {
    if (!this.runtime) return;
    const wasLive = this.runtime.status === 'live';
    this.runtime.dispose();
    this.runtime = null;
    engine.setSource(null);
    engine.setLiveSourceActive(false);
    if (wasLive) void window.material.setLiveness('live-source', false);
    void window.material.setCaptureIntent(null);
  }
}

export const captureManager = new CaptureManager();
