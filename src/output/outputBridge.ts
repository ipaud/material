import { runtimeBus, type FrameState, type RenderInputs } from '@/runtime/RuntimeBus';
import { playback } from '@/playback/PlaybackController';
import { usePlaybackStore } from '@/state/playbackStore';
import { useOutputStore } from '@/state/outputStore';
import type {
  ClockSyncMsg,
  FrameStateMsg,
  OutputChannelMsg,
  RenderInputsMsg,
} from '@shared/outputChannel';

const CLOCK_SYNC_MS = 250; // ~4 Hz

/**
 * Editor-side authority bridge (Phase 18B).
 *
 * Streams the RuntimeBus over the brokered MessagePort: RenderInputs on
 * change, FrameState per evaluated frame, transport events from the one
 * clock, and a ~4 Hz ClockSync beacon. The output replica renders exactly
 * this — it never evaluates anything.
 */
let port: MessagePort | null = null;
let teardown: (() => void) | null = null;
let frameSeq = 0;
let clockSeq = 0;

function toInputsMsg(inputs: RenderInputs): RenderInputsMsg {
  return {
    type: 'render-inputs',
    generation: inputs.generation,
    techniqueId: inputs.techniqueId,
    materialState: inputs.materialState,
    compWidth: inputs.compWidth,
    compHeight: inputs.compHeight,
    background: inputs.background,
    source: inputs.source,
    customShaders: inputs.customShaders,
    // v0.6E: the stack, as configuration. Dropping it here is exactly the
    // class of bug that made CE1F/CE1G invisible in the Output for a release.
    layers: inputs.layers,
  };
}

function toFrameMsg(frame: FrameState): FrameStateMsg {
  return {
    type: 'frame',
    seq: frameSeq++,
    wallEmittedAt: Date.now(),
    compTime: frame.compTime,
    techniqueId: frame.techniqueId,
    temporalActive: frame.temporalActive,
    finalParams: frame.finalParams,
    // CE1F / CE1G: both were declared on FrameStateMsg and read by the
    // replica, but never copied here — so the Output rendered generators with
    // UNMODULATED params (falling back to the low-rate RenderInputs) and never
    // showed a morph transition at all. Resolved values only; the replica
    // still evaluates nothing.
    sourceParams: frame.sourceParams,
    transition: frame.transition,
    materialState: frame.materialState,
    // v0.6E: the rest of the stack, already resolved by the editor.
    layerParams: frame.layerParams,
    layerOpacity: frame.layerOpacity,
    layerSourceParams: frame.layerSourceParams,
  };
}

function clockMsg(): ClockSyncMsg {
  return {
    type: 'clock',
    seq: clockSeq++,
    authorityTimeSec: playback.getTime(),
    playing: usePlaybackStore.getState().playing,
    playbackRate: 1,
    wallEmittedAt: Date.now(),
  };
}

function attach(newPort: MessagePort): void {
  teardown?.();
  port = newPort;
  const send = (msg: OutputChannelMsg) => {
    try {
      port?.postMessage(msg);
    } catch {
      /* replica gone — status push will tear us down */
    }
  };

  const offInputs = runtimeBus.subscribeInputs((inputs) => send(toInputsMsg(inputs)));
  const offFrames = runtimeBus.subscribe((frame) => send(toFrameMsg(frame)));
  const offTransport = runtimeBus.subscribeTransport((event) => {
    send({ type: 'transport', action: event.action, timeSec: event.timeSec });
    send(clockMsg());
  });
  const beacon = setInterval(() => send(clockMsg()), CLOCK_SYNC_MS);

  // Bring the fresh replica up to date immediately.
  send(toInputsMsg(runtimeBus.getRenderInputs()));
  const latest = runtimeBus.latest();
  if (latest) send(toFrameMsg(latest));
  send(clockMsg());

  newPort.start?.();
  teardown = () => {
    offInputs();
    offFrames();
    offTransport();
    clearInterval(beacon);
    try {
      newPort.close();
    } catch {
      /* already closed */
    }
    if (port === newPort) port = null;
  };
}

/** Idempotent — call once from App bootstrap. */
let started = false;
export function startOutputBridge(): void {
  if (started) return;
  started = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if ((event.data as { type?: string })?.type !== 'material:output-port') return;
    const port = event.ports[0];
    if (port) attach(port);
  });
  window.material.onOutputStatus((status) => {
    useOutputStore.getState().setStatus(status);
    if (status.state !== 'open') {
      teardown?.();
      teardown = null;
    }
  });
  // Hotplug: main pushes the list, the editor never polls.
  window.material.onOutputDisplays((displays) => {
    useOutputStore.getState().setDisplays(displays);
  });
}

/** Test-only: number of active subscriptions guard. */
export function outputBridgeActive(): boolean {
  return port !== null;
}
