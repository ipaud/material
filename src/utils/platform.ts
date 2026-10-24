/** True on macOS. Read from the browser, so it is available synchronously (and false in tests, which use jsdom). */
export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

/** The shortcut modifier the user expects: ⌘ on macOS, Ctrl elsewhere. Tests send metaKey, so that stays accepted. */
export function hasCommand(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || (!isMac && e.ctrlKey);
}

/** "⌘" or "Ctrl", for labels. */
export const COMMAND_KEY = isMac ? '⌘' : 'Ctrl';

/** The last part of a path, whichever separator it uses ("C:\\media\\clip.mp4" → "clip.mp4"). */
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
