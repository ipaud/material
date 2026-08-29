import { create } from 'zustand';
import { engine } from '@/rendering/RenderEngine';
import { reportError } from '@/state/uiStore';
import { CameraSource } from './CameraSource';
import type { SourceRuntimeStatus } from './SourceRuntime';

/**
 * Camera lifecycle authority (18D). One active camera, user-intent driven:
 *
 *   attach(sourceId, deviceId)   project selected a camera source — IDLE,
 *                                nothing acquired, no permission touched
 *   start()                      the explicit user action; arms the main
 *                                permission gate, acquires, goes LIVE
 *   stop()                       releases everything; gate disarmed
 *   detach()                     project switched away — same as stop
 *
 * Liveness: a LIVE camera holds the `live-source` reason (the one 18A
 * reserved), so the app stays awake with the transport paused. Stopping
 * releases it. There is deliberately no camera-specific reason.
 */

export interface CameraUiState {
  /** Project source id currently attached, or null. */
  sourceId: string | null;
  status: SourceRuntimeStatus | 'idle';
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /** Video inputs known to the browser (labels empty before permission). */
  devices: { deviceId: string; label: string }[];
}

export const useCameraStore = create<CameraUiState>(() => ({
  sourceId: null,
  status: 'idle',
  width: null,
  height: null,
  frameRate: null,
  devices: [],
}));

class CameraManager {
  private runtime: CameraSource | null = null;
  private attachedSourceId: string | null = null;
  private preferredDeviceId: string | null = null;
  private deviceListener: (() => void) | null = null;

  /** Project selected a camera source. Idle by design — never acquires. */
  attach(sourceId: string, deviceId: string | null): void {
    if (this.attachedSourceId === sourceId && this.preferredDeviceId === deviceId) return;
    const wasLive = this.runtime?.status === 'live';
    this.teardownRuntime();
    this.attachedSourceId = sourceId;
    this.preferredDeviceId = deviceId;
    useCameraStore.setState({
      sourceId,
      status: 'idle',
      width: null,
      height: null,
      frameRate: null,
    });
    // Same source re-attached with a new preferred device while live:
    // restart onto the new device (explicit user choice = intent).
    if (wasLive && this.attachedSourceId === sourceId) void this.start();
  }

  /** Project switched away from the camera. */
  detach(): void {
    if (this.attachedSourceId === null) return;
    this.teardownRuntime();
    this.attachedSourceId = null;
    this.preferredDeviceId = null;
    useCameraStore.setState({
      sourceId: null,
      status: 'idle',
      width: null,
      height: null,
      frameRate: null,
      devices: [],
    });
  }

  /** THE user action. Arms the permission gate, acquires, feeds the engine. */
  async start(): Promise<void> {
    if (!this.attachedSourceId) return;
    this.teardownRuntime();

    const runtime = new CameraSource(this.preferredDeviceId);
    this.runtime = runtime;
    runtime.onStatus((status) => this.onRuntimeStatus(runtime, status));
    useCameraStore.setState({ status: 'connecting' });

    await window.material.setCameraIntent(true);
    try {
      await runtime.connect();
    } catch (err) {
      // Status is already precise (permission-denied / device-lost / error);
      // the gate must not stay armed after a failed start.
      await window.material.setCameraIntent(false);
      if ((err as DOMException)?.name !== 'NotAllowedError') {
        reportError('Camera', err);
      }
      return;
    }
    if (this.runtime !== runtime) return; // stopped while connecting

    engine.setSource(runtime.texture());
    engine.setLiveSourceActive(true);
    void window.material.setLiveness('live-source', true);
    useCameraStore.setState({
      status: 'live',
      width: runtime.width,
      height: runtime.height,
      frameRate: runtime.frameRate,
    });
    void this.refreshDevices();
    this.watchDevices();
  }

  /** Explicit stop — also used by detach/project switch/app teardown. */
  stop(): void {
    this.teardownRuntime();
    if (this.attachedSourceId) useCameraStore.setState({ status: 'idle' });
  }

  /** Restart onto another device (explicit user choice = intent). */
  async selectDevice(deviceId: string): Promise<void> {
    this.preferredDeviceId = deviceId;
    if (this.runtime) await this.start();
  }

  isLive(): boolean {
    return this.runtime?.status === 'live';
  }

  texture() {
    return this.runtime?.texture() ?? null;
  }

  async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      useCameraStore.setState({ devices });
    } catch {
      // Enumeration failing is not an error state worth surfacing.
    }
  }

  private watchDevices(): void {
    if (this.deviceListener) return;
    const handler = () => void this.refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    this.deviceListener = () =>
      navigator.mediaDevices.removeEventListener('devicechange', handler);
  }

  private onRuntimeStatus(runtime: CameraSource, status: SourceRuntimeStatus): void {
    if (this.runtime !== runtime) return;
    if (status === 'device-lost') {
      // Unplugged while live: neutral source, liveness released, one clean
      // status — the user decides when to reconnect.
      engine.setSource(null);
      engine.setLiveSourceActive(false);
      void window.material.setLiveness('live-source', false);
      void window.material.setCameraIntent(false);
      useCameraStore.setState({ status: 'device-lost', width: null, height: null, frameRate: null });
    } else if (status !== 'live' && status !== 'connecting') {
      useCameraStore.setState({ status });
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
    void window.material.setCameraIntent(false);
    this.deviceListener?.();
    this.deviceListener = null;
  }
}

export const cameraManager = new CameraManager();
