import { app } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logExport, setExportLogSink } from '../export/exportLog';

/** ~/Library/Logs/MATERIAL/export.log on macOS. */
export function exportLogPath(): string {
  return path.join(app.getPath('logs'), 'export.log');
}

export function installExportLogFile(): void {
  const file = exportLogPath();
  let ready: Promise<void> | null = null;
  setExportLogSink((line) => {
    ready ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined);
    void ready.then(() => appendFile(file, `${line}\n`)).catch(() => undefined);
  });
}

export function logGpuState(reason: string): void {
  logExport(`${reason} gpu=${JSON.stringify(app.getGPUFeatureStatus())}`);
}
