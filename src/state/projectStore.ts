import { create } from 'zustand';
import { createEmptyProject, type Project } from '@shared/schemas/project';

const HISTORY_LIMIT = 100;

interface ProjectStore {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  past: Project[];
  future: Project[];
  /** Snapshot taken at the start of a transient gesture (slider drag). */
  transientBase: Project | null;
  /** Bumped when the document is REPLACED (new / open / recover), never on edits. */
  projectGeneration: number;
  /** See runSilently. */
  silent: boolean;

  /**
   * Apply an immutable update. Pushes an undo entry unless a transient
   * gesture is in progress (then history is deferred to commitTransient).
   */
  apply: (updater: (p: Project) => Project) => void;
  /**
   * Transient update with NO history entry and no dirty change — reserved
   * for morph-driven technique/material side flips, where the single real
   * commit happens at morph completion.
   */
  applySilent: (updater: (p: Project) => Project) => void;
  /**
   * Run `fn` with every `apply` inside it behaving as `applySilent`.
   *
   * v0.7: replaying a Take recalls Looks, restores freezes and flips layers,
   * all through the actions that already do those things. None of it is an
   * EDIT — the document did not change because the performer pressed play —
   * so it must leave neither an undo entry nor a dirty flag (§76). Scoping the
   * store rather than duplicating a silent variant of every action keeps one
   * implementation of what a Look recall means.
   *
   * Synchronous only, by construction: the flag is cleared in a `finally`, so
   * an async continuation lands outside the scope and dirties normally. That
   * is the safe direction to fail.
   */
  runSilently: (fn: () => void) => void;
  beginTransient: () => void;
  commitTransient: () => void;
  cancelTransient: () => void;
  undo: () => void;
  redo: () => void;

  newProject: () => void;
  loadProject: (path: string, project: Project) => void;
  markSaved: (path: string) => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: createEmptyProject(),
  projectPath: null,
  dirty: false,
  past: [],
  future: [],
  transientBase: null,
  projectGeneration: 0,
  silent: false,

  apply: (updater) => {
    const { project, past, transientBase, silent } = get();
    const next = updater(project);
    if (next === project) return;
    if (silent) {
      set({ project: next });
      return;
    }
    if (transientBase !== null) {
      // Mid-gesture: update live value, defer history.
      set({ project: next, dirty: true });
      return;
    }
    set({
      project: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), project],
      future: [],
      dirty: true,
    });
  },

  runSilently: (fn) => {
    const was = get().silent;
    set({ silent: true });
    try {
      fn();
    } finally {
      set({ silent: was });
    }
  },

  applySilent: (updater) => {
    const { project } = get();
    const next = updater(project);
    if (next !== project) set({ project: next });
  },

  beginTransient: () => {
    if (get().transientBase === null) {
      set({ transientBase: get().project });
    }
  },

  commitTransient: () => {
    const { transientBase, project, past } = get();
    if (transientBase === null) return;
    if (transientBase === project) {
      set({ transientBase: null });
      return;
    }
    set({
      transientBase: null,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), transientBase],
      future: [],
      dirty: true,
    });
  },

  cancelTransient: () => {
    const { transientBase } = get();
    if (transientBase === null) return;
    set({ project: transientBase, transientBase: null });
  },

  undo: () => {
    const { past, future, project, transientBase } = get();
    if (transientBase !== null || past.length === 0) return;
    const previous = past[past.length - 1];
    if (!previous) return;
    set({
      project: previous,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY_LIMIT),
      dirty: true,
    });
  },

  redo: () => {
    const { past, future, project, transientBase } = get();
    if (transientBase !== null || future.length === 0) return;
    const next = future[0];
    if (!next) return;
    set({
      project: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), project],
      future: future.slice(1),
      dirty: true,
    });
  },

  newProject: () => {
    set((s) => ({
      project: createEmptyProject(),
      projectPath: null,
      dirty: false,
      past: [],
      future: [],
      transientBase: null,
      projectGeneration: s.projectGeneration + 1,
    }));
  },

  loadProject: (path, project) => {
    set((s) => ({
      project,
      projectPath: path,
      dirty: false,
      past: [],
      future: [],
      transientBase: null,
      projectGeneration: s.projectGeneration + 1,
    }));
  },

  markSaved: (path) => {
    set({ projectPath: path, dirty: false });
  },
}));
