import type { MediaKind, MediaMetadata } from './schemas/media';

/** v0.8: one media file found in a folder the user pointed at. */
export interface FolderMediaEntry {
  path: string;
  fileName: string;
  fileSize: number;
  kind: MediaKind;
}
import type { Project, ProjectIssue } from './schemas/project';
import type { DisplayInfo, OutputDisplayStatus, OutputMode } from './display';
import type { Preset } from './schemas/preset';
import type { LoadedPack } from './schemas/shaderPack';

/** 18E: what the editor's START action authorizes capturing. */
export type CaptureIntentTarget =
  | { kind: 'screen'; displayId: number | null }
  | { kind: 'window'; sourceId: string };

/** 18E: safe subset of a desktop capture source — no thumbnails, no icons. */
export interface CaptureWindowInfo {
  /** Ephemeral OS capture id — valid for this selection round only. */
  sourceId: string;
  /** Window title (best label Chromium exposes; app name is not separate). */
  title: string;
}

export const IPC = {
  appInfo: 'app:info',
  openMediaDialog: 'dialog:open-media',
  probeMedia: 'media:probe',
  showInFinder: 'shell:show-in-finder',
  findProxy: 'media:find-proxy',
  createProxy: 'media:create-proxy',
  readProject: 'project:read',
  writeProject: 'project:write',
  openProjectDialog: 'project:open-dialog',
  saveProjectDialog: 'project:save-dialog',
  savePngDialog: 'export:save-png',
  readSvg: 'media:read-svg',
  // v0.8 — a show that can travel. Both channels open their own dialog, so
  // the renderer never names a directory and no new way to enumerate the
  // disk is introduced.
  pickMediaFolder: 'media:pick-folder',
  collectMedia: 'media:collect',
  // v0.5B — shader packs. Four narrow channels; the renderer never receives a
  // filesystem API, only validated pack DATA.
  shaderPacksList: 'shaderPacks:list',
  shaderPackImport: 'shaderPacks:import',
  shaderPackRemove: 'shaderPacks:remove',
  shaderPacksRoot: 'shaderPacks:root',
  shaderIsfImport: 'shaderPacks:importIsf',
  listPresets: 'presets:list',
  savePreset: 'presets:save',
  deletePreset: 'presets:delete',
  exportSaveDialog: 'export:save-dialog',
  exportStart: 'export:start',
  exportFrame: 'export:frame',
  exportFinish: 'export:finish',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress',
  sessionId: 'session:id',
  recoveryWrite: 'recovery:write',
  recoveryList: 'recovery:list',
  recoveryClear: 'recovery:clear',
  recoveryDiscard: 'recovery:discard',
  menuEvent: 'menu:event',
  setLiveness: 'power:liveness',
  outputOpen: 'output:open',
  outputClose: 'output:close',
  outputStatus: 'output:status',
  outputRuntimePort: 'output:runtime-port',
  outputDisplays: 'output:displays',
  outputDisplayList: 'output:display-list',
  outputMove: 'output:move',
  outputSetMode: 'output:set-mode',
  outputTarget: 'output:target',
  outputEscape: 'output:escape',
  brandDockIcon: 'brand:dock-icon',
  cameraIntent: 'camera:intent',
  captureIntent: 'capture:intent',
  captureListWindows: 'capture:list-windows',
} as const;

export interface RecoveryEntry {
  version: 1;
  sessionId: string;
  savedAt: string;
  projectPath: string | null;
  project: Project;
}

export type ExportFormat = 'png-sequence' | 'h264' | 'prores422' | 'prores4444';

export interface ExportConfig {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  /** Absolute output path (mp4/mov file, or directory for sequences). */
  outPath: string;
  /** Render on transparency instead of the composition background. */
  alpha: boolean;
  /** Optional audio file to mux (movie formats only). */
  audioPath: string | null;
  /** Trim of the muxed audio in seconds (start offset + duration). */
  audioStartSec: number;
  durationSec: number;
}

export interface ExportProgressEvent {
  sessionId: string;
  phase: 'encoding' | 'finalizing' | 'done' | 'error' | 'cancelled';
  framesWritten: number;
  message?: string;
  outPath?: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  platform: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  availableEncoders: string[];
  /** Diagnostic: whether the app-suspension blocker is currently held. */
  livenessActive: boolean;
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

export type ReadProjectResult =
  | { ok: true; path: string; project: Project; repaired: ProjectIssue[] }
  | { ok: false; path: string; issues: ProjectIssue[]; repairable: boolean };

/** API surface exposed on window.material by the preload bridge. */
export interface MaterialApi {
  getAppInfo(): Promise<AppInfo>;
  openMediaDialog(): Promise<string[]>;
  probeMedia(path: string): Promise<MediaMetadata>;
  /** Reveal a file or folder in Finder. */
  showInFinder(path: string): Promise<void>;
  /** H.264 proxy made earlier for a video the viewer cannot decode, if any. */
  findProxy(path: string): Promise<string | null>;
  /** Transcode (or reuse) the proxy; resolves with its path once complete. */
  createProxy(path: string): Promise<string>;
  /** With `repair`, out-of-range numbers are clamped to their schema bounds. */
  readProject(path: string, repair?: boolean): Promise<ReadProjectResult>;
  writeProject(path: string, project: Project): Promise<void>;
  /** Pick a folder in Finder and list the media in it (bounded depth). */
  pickMediaFolder(): Promise<FolderMediaEntry[] | null>;
  /** Copy media beside the project file; returns old path → new path. */
  collectMedia(
    projectPath: string,
    sourcePaths: string[],
  ): Promise<{ moved: Record<string, string>; bytesCopied: number; missing: string[] }>;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(defaultName: string): Promise<string | null>;
  /** Saves a base64-encoded PNG via a Finder dialog; returns chosen path or null. */
  savePngDialog(base64Png: string, defaultName: string): Promise<string | null>;
  /** Read an SVG file, sanitized (scripts/handlers/external refs stripped). */
  readSvg(path: string): Promise<string>;
  listShaderPacks(): Promise<LoadedPack[]>;
  importShaderPack(): Promise<{ ok: boolean; pack?: LoadedPack; error?: string }>;
  removeShaderPack(id: string): Promise<{ ok: boolean; error?: string }>;
  shaderPacksRoot(): Promise<string>;
  importIsfShader(): Promise<{ ok: boolean; pack?: LoadedPack; error?: string }>;
  listPresets(): Promise<Preset[]>;
  savePreset(preset: Preset): Promise<void>;
  deletePreset(id: string): Promise<void>;
  /** Pick an export destination (extension depends on format). */
  exportSaveDialog(format: ExportFormat, defaultName: string): Promise<string | null>;
  exportStart(config: ExportConfig): Promise<{ sessionId: string }>;
  /** Stream one RGBA frame (width*height*4 bytes) into the encoder. */
  exportFrame(sessionId: string, rgba: Uint8Array): Promise<void>;
  exportFinish(sessionId: string): Promise<{ outPath: string }>;
  exportCancel(sessionId: string): Promise<void>;
  onExportProgress(callback: (event: ExportProgressEvent) => void): () => void;
  /** Stable id for this app run; scopes the autosave file. */
  /** Hold/release the macOS App Nap inhibitor while the live engine runs. */
  setLiveness(reason: string, active: boolean): Promise<boolean>;
  /** Open (or move) the output window on a display. */
  outputOpen(options?: { displayId?: number | null; mode?: OutputMode }): Promise<boolean>;
  outputClose(): Promise<void>;
  onOutputStatus(callback: (status: OutputDisplayStatus) => void): void;
  /** Displays currently connected, in presentation order. */
  outputDisplays(): Promise<DisplayInfo[]>;
  /** Hotplug / geometry changes — the list is pushed, never polled. */
  onOutputDisplays(callback: (displays: DisplayInfo[]) => void): void;
  /** Move the existing output window; never opens a second one. */
  outputMove(displayId: number | null, mode?: OutputMode): Promise<boolean>;
  outputSetMode(mode: OutputMode): Promise<boolean>;
  /** Remembered target (app preference, not project state). */
  outputTarget(): Promise<{ displayId: number | null; mode: OutputMode }>;
  /** Dock icon signal position (0-8) — the project's brand fingerprint. */
  setDockIcon(position: number): Promise<void>;
  /**
   * Arm/disarm camera acquisition (18D). Video-capture permission is granted
   * ONLY while armed, and arming happens ONLY from an explicit user action
   * in the editor — never on launch, project open or source browsing.
   */
  setCameraIntent(active: boolean): Promise<void>;
  /**
   * 18E: arm/disarm the display-capture gate with the exact target the user
   * chose. null disarms and also revokes the Output's rejoin authorization.
   */
  setCaptureIntent(target: CaptureIntentTarget | null): Promise<void>;
  /**
   * 18E: enumerate capturable application windows. Narrow wrapper over
   * desktopCapturer — ids never persist, list is fetched only on the
   * explicit CHOOSE WINDOW action (this call can trigger the macOS screen
   * recording TCC prompt, so it must never run on launch or project open).
   */
  listCaptureWindows(): Promise<CaptureWindowInfo[]>;

  getSessionId(): Promise<string>;
  /** Autosave — writes to userData/recovery, never to the user's project. */
  writeRecovery(projectPath: string | null, project: Project): Promise<void>;
  /** Recovery entries from sessions that did not shut down cleanly. */
  listRecoveries(): Promise<RecoveryEntry[]>;
  clearRecovery(): Promise<void>;
  discardRecovery(sessionId: string): Promise<void>;
  onMenuEvent(callback: (id: MenuEventId) => void): () => void;
}
