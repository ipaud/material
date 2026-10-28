import { useState } from 'react';
import { selectedLayerOf } from '@shared/schemas/project';
import {
  addCaptureSource,
  addGeneratorSource,
  importMediaViaDialog,
  newProject,
  openProject,
} from '@/projects/projectActions';
import { applyRecipe, listRecipes } from '@/projects/recipes';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { playback } from '@/playback/PlaybackController';

export function EmptyState({ isDragOver }: { isDragOver: boolean }) {
  const [showGenerators, setShowGenerators] = useState(false);
  const [recipe, setRecipe] = useState('');
  const recipes = listRecipes();
  // A generator start promises a running system: with the transport stopped
  // the first thing a new user saw was a frozen frame (and Flow techniques
  // had no motion to work with) until they found Space.
  const startRunning = () => {
    if (!usePlaybackStore.getState().playing) playback.play();
  };
  const focusSelectedSource = () => {
    requestAnimationFrame(() => {
      const layer = selectedLayerOf(useProjectStore.getState().project);
      if (!layer.sourceId) return;
      document
        .querySelector<HTMLElement>(
          `[data-source-id="${layer.sourceId}"] select, [data-source-id="${layer.sourceId}"] button`,
        )
        ?.focus();
    });
  };
  return (
    <div className={`empty-state${isDragOver ? ' drag-over' : ''}`}>
      <h1 className="empty-state-title">MATERIAL</h1>
      <p className="empty-state-hint">MAKE SOMETHING FROM</p>
      <div className="empty-state-actions">
        <button
          className="titlebar-action"
          onClick={() => void importMediaViaDialog().then(focusSelectedSource)}
        >
          VIDEO / IMAGE
        </button>
        <button
          className="titlebar-action"
          onClick={() => {
            addCaptureSource('camera');
            focusSelectedSource();
          }}
        >
          CAMERA
        </button>
        <button
          className="titlebar-action"
          onClick={() => {
            addCaptureSource('screen');
            focusSelectedSource();
          }}
        >
          SCREEN
        </button>
        <button
          className="titlebar-action"
          aria-expanded={showGenerators}
          onClick={() => setShowGenerators((shown) => !shown)}
        >
          NOTHING
        </button>
      </div>
      {showGenerators && (
        <div className="empty-state-actions" role="group" aria-label="Start with a generator">
          {[
            ['noise', 'NOISE'],
            ['grid', 'GRID'],
            ['cellular', 'CELLS'],
            ['waves', 'WAVES'],
          ].map(([id, label]) => (
            <button
              key={id}
              className="vp-btn"
              onClick={() => {
                addGeneratorSource(id);
                startRunning();
                focusSelectedSource();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <label className="empty-state-recipe">
        <span>OR START WITH A RECIPE</span>
        <select
          className="select"
          aria-label="Start with a recipe"
          value={recipe}
          onChange={(event) => {
            const id = event.currentTarget.value;
            setRecipe('');
            if (id && applyRecipe(id)) {
              startRunning();
              focusSelectedSource();
            }
          }}
        >
          <option value="">Choose recipe…</option>
          {Array.from(new Set(recipes.map((entry) => entry.category))).map((category) => (
            <optgroup key={category} label={category}>
              {recipes
                .filter((entry) => entry.category === category)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="empty-state-actions">
        <button className="titlebar-action" onClick={() => newProject()}>
          New Project
        </button>
        <button className="titlebar-action" onClick={() => void openProject()}>
          Open Project
        </button>
      </div>
      <p className="empty-state-source-hint">
        Camera and Screen need START in Library to request access.
      </p>
    </div>
  );
}
