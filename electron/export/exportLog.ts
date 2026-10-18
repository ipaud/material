/**
 * Export diagnostics. The encoder only knows `logExport`; main wires the sink
 * to a file under ~/Library/Logs/MATERIAL so a crash mid-export leaves a trail
 * (last frame, memory, GPU state) even though the renderer is gone.
 */
type Sink = (line: string) => void;

let sink: Sink = () => undefined;

export function setExportLogSink(next: Sink): void {
  sink = next;
}

export function logExport(message: string): void {
  const mb = Math.round(process.memoryUsage().rss / 1048576);
  try {
    sink(`${new Date().toISOString()} rss=${mb}MB ${message}`);
  } catch {
    // logging must never take the export down with it
  }
}
