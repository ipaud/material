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

  /**
   * Apply an immutable update. Pushes an undo entry unless a transient
   * gesture is in progress (then history is deferred to commitTransient).
   */
  apply: (updater: (p: Project) => Project) => void;
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

  apply: (updater) => {
    const { project, past, transientBase } = get();
    const next = updater(project);
    if (next === project) return;
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
    set({
      project: createEmptyProject(),
      projectPath: null,
      dirty: false,
      past: [],
      future: [],
      transientBase: null,
    });
  },

  loadProject: (path, project) => {
    set({
      project,
      projectPath: path,
      dirty: false,
      past: [],
      future: [],
      transientBase: null,
    });
  },

  markSaved: (path) => {
    set({ projectPath: path, dirty: false });
  },
}));
