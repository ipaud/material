import { OutputReplica } from './replica';
import type { OutputChannelMsg } from '@shared/outputChannel';

declare global {
  interface Window {
    materialOutput: { ready: boolean; escape?: () => void };
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

// The output renders pixels; Escape is its only control (18C §28/§30).
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.materialOutput.escape?.();
  }
});

// Presentation cursor: hide it while the pointer rests over the output, and
// bring it back the moment it moves so the window stays operable.
let cursorTimer: ReturnType<typeof setTimeout> | null = null;
const HIDE_CURSOR_AFTER_MS = 1200;
const armCursorHide = () => {
  document.body.classList.remove('hide-cursor');
  if (cursorTimer) clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), HIDE_CURSOR_AFTER_MS);
};
window.addEventListener('mousemove', armCursorHide);
armCursorHide();

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
