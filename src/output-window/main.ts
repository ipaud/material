import { OutputReplica } from './replica';
import type { OutputChannelMsg } from '@shared/outputChannel';

declare global {
  interface Window {
    materialOutput: { ready: boolean };
    __replica?: OutputReplica;
  }
}

const canvas = document.getElementById('output-canvas') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const replica = new OutputReplica();
replica.init(canvas);
window.__replica = replica; // dev/QA introspection

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  if ((event.data as { type?: string })?.type !== 'material:runtime-port') return;
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (msg: MessageEvent<OutputChannelMsg>) => replica.handle(msg.data);
  port.start?.();
});

// Spike status line: quiet, mono, bottom-left. 4 Hz.
setInterval(() => {
  const f = replica.latest;
  const stats = replica.engine.getStats();
  const drift = replica.videoDriftMs();
  statusEl.textContent =
    `${f?.techniqueId ?? '—'}  t ${replica.estimateTime().toFixed(2)}s` +
    `  fps ${stats.fps}` +
    (drift !== null ? `  drift ${drift.toFixed(0)}ms` : '') +
    `  lat ${replica.lastWallLatencyMs.toFixed(0)}ms  frames ${replica.framesReceived}`;
}, 250);
