import type { MaterialApi } from '@shared/ipc';

declare global {
  interface Window {
    material: MaterialApi & { getPathForFile(file: File): string };
  }
}

export {};
