import type { MediaMetadata } from './schemas/media';
import type { Project } from './schemas/project';
import type { Preset } from './schemas/preset';

export const IPC = {
  appInfo: 'app:info',
  openMediaDialog: 'dialog:open-media',
  probeMedia: 'media:probe',
  readProject: 'project:read',
  writeProject: 'project:write',
  openProjectDialog: 'project:open-dialog',
  saveProjectDialog: 'project:save-dialog',
  savePngDialog: 'export:save-png',
  readSvg: 'media:read-svg',
  listPresets: 'presets:list',
  savePreset: 'presets:save',
  deletePreset: 'presets:delete',
  menuEvent: 'menu:event',
} as const;

export interface AppInfo {
  version: string;
  electron: string;
  platform: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  availableEncoders: string[];
}

export type MenuEventId =
  | 'new-project'
  | 'open-project'
  | 'save-project'
  | 'save-project-as'
  | 'import-media'
  | 'export'
  | 'undo'
  | 'redo'
  | 'toggle-debug-overlay';

/** API surface exposed on window.material by the preload bridge. */
export interface MaterialApi {
  getAppInfo(): Promise<AppInfo>;
  openMediaDialog(): Promise<string[]>;
  probeMedia(path: string): Promise<MediaMetadata>;
  readProject(path: string): Promise<{ path: string; project: Project }>;
  writeProject(path: string, project: Project): Promise<void>;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(defaultName: string): Promise<string | null>;
  /** Saves a base64-encoded PNG via a Finder dialog; returns chosen path or null. */
  savePngDialog(base64Png: string, defaultName: string): Promise<string | null>;
  /** Read an SVG file, sanitized (scripts/handlers/external refs stripped). */
  readSvg(path: string): Promise<string>;
  listPresets(): Promise<Preset[]>;
  savePreset(preset: Preset): Promise<void>;
  deletePreset(id: string): Promise<void>;
  onMenuEvent(callback: (id: MenuEventId) => void): () => void;
}
