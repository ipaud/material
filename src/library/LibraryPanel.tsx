import { withSelectedSource } from '@shared/schemas/project';
import { LooksPanel } from './LooksPanel';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { relinkSource } from '@/projects/projectActions';
import { cameraManager, useCameraStore } from '@/sources/cameraManager';
import { captureManager, useCaptureStore } from '@/sources/captureManager';
import {
  isFileSource,
  type GeneratorSourceRef,
  type ScreenSourceRef,
  type WindowSourceRef,
} from '@shared/schemas/project';
import { GENERATORS, generatorDefaults, getGenerator } from '@/sources/generators/definitions';
import { withTechniqueEnsured } from '@/projects/projectActions';
import { uid } from '@/utils/id';
import './library.css';

type SourceRef = ReturnType<typeof useProjectStore.getState>['project']['sources'][number];

/** One quiet line of real metadata: dimensions, duration, size — whatever exists. */
function describe(source: SourceRef): string {
  if (source.kind === 'camera' || source.kind === 'screen' || source.kind === 'window')
    return 'LIVE INPUT';
  if (source.kind === 'generator') return 'PROCEDURAL';
  const meta = source.metadata;
  if (!meta) return source.kind.toUpperCase();
  const parts: string[] = [];
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  if (meta.durationSec) parts.push(`${meta.durationSec.toFixed(1)}s`);
  if (meta.fileSize) parts.push(`${(meta.fileSize / 1_000_000).toFixed(1)} MB`);
  return parts.join('  ·  ');
}

const KIND_LABEL: Record<string, string> = {
  image: 'IMG',
  video: 'VID',
  audio: 'AUD',
  svg: 'SVG',
  camera: 'CAM',
  screen: 'SCR',
  window: 'WIN',
  generator: 'GEN',
};

export function LibraryPanel() {
  const sources = useProjectStore((s) => s.project.sources);
  const activeSourceId = useProjectStore((s) => s.project.composition.sourceId);
  const activeAudioId = useProjectStore((s) => s.project.composition.audioSourceId);
  const offlineSources = useUiStore((s) => s.offlineSources);
  const apply = useProjectStore((s) => s.apply);

  const selectSource = (id: string, kind: string) => {
    apply((p) => {
      const source = p.sources.find((s) => s.id === id);
      if (!source) return p;
      if (kind === 'audio') {
        return { ...p, composition: { ...p.composition, audioSourceId: id } };
      }
      if (kind === 'generator') {
        // A generator is just a source: point the selected layer at it.
        return withSelectedSource(p, id);
      }
      if (kind === 'camera' || kind === 'screen' || kind === 'window') {
        // Selecting a live source only points the selected layer at it —
        // capture starts exclusively from the explicit START action.
        return withSelectedSource(p, id);
      }
      if (kind === 'svg' && source.kind === 'svg') {
        // SVGs are materials, not composition sources.
        return { ...p, material: { ...p.material, materialId: 'custom', assetPath: source.path } };
      }
      if ((kind === 'image' || kind === 'video') && isFileSource(source)) {
        const meta = source.metadata;
        const withSource = withSelectedSource(p, id);
        return {
          ...withSource,
          composition: {
            ...withSource.composition,
            width: meta?.width ?? p.composition.width,
            height: meta?.height ?? p.composition.height,
          },
        };
      }
      return p;
    });
  };

  const useAsMaterial = (id: string) => {
    apply((p) => {
      const source = p.sources.find((s) => s.id === id);
      if (!source || !isFileSource(source)) return p;
      return { ...p, material: { ...p.material, materialId: 'custom', assetPath: source.path } };
    });
  };

  const addCamera = () => {
    apply((p) => {
      if (p.sources.some((s) => s.kind === 'camera')) return p;
      const id = uid('cam');
      // Same as file import: a first source must land on a working system.
      return withTechniqueEnsured(
        withSelectedSource({ ...p, sources: [...p.sources, { id, kind: 'camera' as const, deviceId: null }] }, id),
      );
    });
  };
  const hasCamera = sources.some((s) => s.kind === 'camera');
  const hasScreen = sources.some((s) => s.kind === 'screen');
  const hasWindow = sources.some((s) => s.kind === 'window');

  const addGenerator = () => {
    apply((p) => {
      const id = uid('gen');
      return withTechniqueEnsured(
        withSelectedSource(
          {
            ...p,
            sources: [
              ...p.sources,
              { id, kind: 'generator' as const, generator: 'noise', params: generatorDefaults('noise'), seed: 1 },
            ],
          },
          id,
        ),
      );
    });
  };

  const addLive = (kind: 'screen' | 'window') => {
    apply((p) => {
      if (p.sources.some((s) => s.kind === kind)) return p;
      const id = uid(kind === 'screen' ? 'scr' : 'win');
      const ref =
        kind === 'screen'
          ? { id, kind: 'screen' as const, displayId: null }
          : { id, kind: 'window' as const, titleHint: null };
      return withTechniqueEnsured(withSelectedSource({ ...p, sources: [...p.sources, ref] }, id));
    });
  };

  return (
    <>
      <div className="panel-header">
        <span className="label">Library</span>
      </div>
      <div className="panel-body">
        <div className="library-section-head">
          <span className="label">Sources</span>
          {sources.length > 0 && <span className="library-count">{sources.length}</span>}
          <span className="library-head-spacer" />
          {!hasCamera && (
            <button
              className="vp-btn"
              title="Add a connected camera as a live source"
              onClick={addCamera}
            >
              + CAMERA
            </button>
          )}
          {!hasScreen && (
            <button
              className="vp-btn"
              title="Capture a display as a live source"
              onClick={() => addLive('screen')}
            >
              + SCREEN
            </button>
          )}
          <button
            className="vp-btn"
            title="Add a procedural generator source"
            onClick={addGenerator}
          >
            + GENERATOR
          </button>
          {!hasWindow && (
            <button
              className="vp-btn"
              title="Capture an application window as a live source"
              onClick={() => addLive('window')}
            >
              + WINDOW
            </button>
          )}
        </div>
        {sources.length === 0 ? (
          <div className="library-empty">No media imported</div>
        ) : (
          <ul className="media-list">
            {sources.map((source) => {
              const isActive = source.id === activeSourceId || source.id === activeAudioId;
              const isOffline = isFileSource(source) && offlineSources.includes(source.id);
              if (source.kind === 'camera') {
                return (
                  <li key={source.id}>
                    <CameraRow
                      sourceId={source.id}
                      active={isActive}
                      onSelect={() => selectSource(source.id, 'camera')}
                    />
                  </li>
                );
              }
              if (source.kind === 'generator') {
                return (
                  <li key={source.id}>
                    <GeneratorRow
                      source={source}
                      active={isActive}
                      onSelect={() => selectSource(source.id, 'generator')}
                    />
                  </li>
                );
              }
              if (source.kind === 'screen' || source.kind === 'window') {
                return (
                  <li key={source.id}>
                    <CaptureRow
                      source={source}
                      active={isActive}
                      onSelect={() => selectSource(source.id, source.kind)}
                    />
                  </li>
                );
              }
              return (
                <li key={source.id}>
                  <button
                    className={`media-item${isActive ? ' active' : ''}${isOffline ? ' offline' : ''}`}
                    onClick={() =>
                      isOffline
                        ? void relinkSource(source.id)
                        : selectSource(source.id, source.kind)
                    }
                    title={
                      isOffline ? `MEDIA OFFLINE — click to relink\n${source.path}` : source.path
                    }
                  >
                    <span className={`media-kind kind-${source.kind}`}>
                      {isOffline ? 'OFF' : (KIND_LABEL[source.kind] ?? '?')}
                    </span>
                    <span className="media-text">
                      <span className="media-name">
                        {source.metadata?.fileName ?? source.path.split('/').pop()}
                      </span>
                      <span className="media-meta">{describe(source)}</span>
                    </span>
                    {isOffline && <span className="media-offline-badge">RELINK</span>}
                    {!isOffline && source.kind === 'image' && (
                      <span
                        className="media-mat-btn"
                        role="button"
                        title="Use as repeated material"
                        onClick={(e) => {
                          e.stopPropagation();
                          useAsMaterial(source.id);
                        }}
                      >
                        MAT
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <LooksPanel />
      </div>
    </>
  );
}

/**
 * The camera row (18D): status, device picker, and the ONE explicit action
 * that may trigger a permission prompt. Saved camera projects sit here in
 * idle state forever until the user presses START.
 */
function CameraRow({
  sourceId,
  active,
  onSelect,
}: {
  sourceId: string;
  active: boolean;
  onSelect: () => void;
}) {
  const cam = useCameraStore();
  const apply = useProjectStore((s) => s.apply);
  const live = cam.status === 'live';

  const STATUS_TEXT: Record<string, string> = {
    idle: 'NOT STARTED',
    connecting: 'STARTING…',
    live: `LIVE${cam.width ? ` · ${cam.width}×${cam.height}` : ''}${cam.frameRate ? ` · ${cam.frameRate}fps` : ''}`,
    'permission-denied': 'ACCESS DENIED',
    'device-lost': 'DISCONNECTED',
    offline: 'STOPPED',
    error: 'ERROR',
  };

  return (
    <div className={`media-item camera-row${active ? ' active' : ''}`} onClick={onSelect}>
      <span className={`media-kind kind-camera${live ? ' live' : ''}`}>CAM</span>
      <span className="media-text">
        <span className="media-name">Camera</span>
        <span className="media-meta">{STATUS_TEXT[cam.status] ?? cam.status}</span>
        {cam.status === 'permission-denied' && (
          <span className="media-meta camera-help">
            Enable camera access for MATERIAL in System Settings → Privacy &amp; Security.
          </span>
        )}
        {live && cam.devices.length > 1 && (
          <select
            className="select camera-device"
            aria-label="Camera device"
            value={cam.devices.find((d) => d.deviceId)?.deviceId ?? ''}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const deviceId = e.target.value;
              // Device preference is creative/project config — persist it.
              apply((p) => ({
                ...p,
                sources: p.sources.map((s) =>
                  s.id === sourceId && s.kind === 'camera' ? { ...s, deviceId } : s,
                ),
              }));
              void cameraManager.selectDevice(deviceId);
            }}
          >
            {cam.devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        )}
      </span>
      <button
        className={`vp-btn${live ? ' active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (live || cam.status === 'connecting') cameraManager.stop();
          else void cameraManager.start();
        }}
      >
        {live || cam.status === 'connecting'
          ? 'STOP'
          : cam.status === 'device-lost'
            ? 'RECONNECT'
            : cam.status === 'permission-denied'
              ? 'TRY AGAIN'
              : 'START'}
      </button>
    </div>
  );
}

/**
 * Screen / window capture row (18E). Same contract as the camera row: saved
 * projects sit IDLE forever; enumeration (CHOOSE WINDOW) and START are the
 * only actions that may touch the macOS screen-recording permission.
 */
function CaptureRow({
  source,
  active,
  onSelect,
}: {
  source: ScreenSourceRef | WindowSourceRef;
  active: boolean;
  onSelect: () => void;
}) {
  const cap = useCaptureStore();
  const apply = useProjectStore((s) => s.apply);
  const mine = cap.sourceId === source.id;
  const live = mine && cap.status === 'live';
  const connecting = mine && cap.status === 'connecting';
  const isScreen = source.kind === 'screen';

  const status = !mine
    ? 'NOT STARTED'
    : cap.status === 'idle'
      ? 'NOT STARTED'
      : cap.status === 'connecting'
        ? 'STARTING…'
        : cap.status === 'live'
          ? `LIVE${cap.width ? ` · ${cap.width}×${cap.height}` : ''}${cap.frameRate ? ` · ${cap.frameRate}fps` : ''}`
          : cap.status === 'permission-denied'
            ? 'SCREEN RECORDING ACCESS REQUIRED'
            : cap.status === 'device-lost'
              ? 'SOURCE ENDED'
              : 'ERROR';

  const canStartWindow = !isScreen && cap.chosenWindowId !== null;

  return (
    <div className={`media-item camera-row${active ? ' active' : ''}`} onClick={onSelect}>
      <span className={`media-kind kind-camera${live ? ' live' : ''}`}>
        {isScreen ? 'SCR' : 'WIN'}
      </span>
      <span className="media-text">
        <span className="media-name">{isScreen ? 'Screen' : 'Window'}</span>
        <span className="media-meta">{status}</span>
        {mine && cap.status === 'permission-denied' && (
          <span className="media-meta camera-help">
            Enable Screen &amp; System Audio Recording for MATERIAL in System Settings → Privacy
            &amp; Security, then relaunch MATERIAL if macOS asks for it.
          </span>
        )}
        {!isScreen && source.titleHint && !live && (
          <span className="media-meta">Last: {source.titleHint}</span>
        )}
        {isScreen && mine && cap.displays.length > 1 && (
          <select
            className="select camera-device"
            aria-label="Display to capture"
            value={source.displayId ?? cap.displays[0]?.id ?? ''}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const displayId = Number(e.target.value);
              // Display preference is creative/project config — persist it.
              apply((p) => ({
                ...p,
                sources: p.sources.map((s) =>
                  s.id === source.id && s.kind === 'screen' ? { ...s, displayId } : s,
                ),
              }));
              void captureManager.selectDisplay(displayId);
            }}
          >
            {cap.displays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        )}
        {!isScreen && mine && cap.windows.length > 0 && !live && (
          <select
            className="select camera-device"
            aria-label="Window to capture"
            value={cap.chosenWindowId ?? ''}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const id = e.target.value;
              captureManager.selectWindow(id);
              const title = cap.windows.find((w) => w.sourceId === id)?.title ?? null;
              // Persist only the human-readable hint — capture ids are
              // ephemeral and must never be treated as identity (§14).
              apply((p) => ({
                ...p,
                sources: p.sources.map((s) =>
                  s.id === source.id && s.kind === 'window' ? { ...s, titleHint: title } : s,
                ),
              }));
            }}
          >
            <option value="" disabled>
              Choose window…
            </option>
            {cap.windows.map((w) => (
              <option key={w.sourceId} value={w.sourceId}>
                {w.title}
              </option>
            ))}
          </select>
        )}
      </span>
      {!isScreen && !live && !connecting && (
        <button
          className="vp-btn"
          title="List capturable windows (may ask for screen recording access)"
          onClick={(e) => {
            e.stopPropagation();
            void captureManager.chooseWindow();
          }}
        >
          {cap.windows.length > 0 ? 'REFRESH' : 'CHOOSE'}
        </button>
      )}
      <button
        className={`vp-btn${live ? ' active' : ''}`}
        disabled={!live && !connecting && !isScreen && !canStartWindow}
        onClick={(e) => {
          e.stopPropagation();
          if (live || connecting) captureManager.stop();
          else void captureManager.start();
        }}
      >
        {live || connecting
          ? 'STOP'
          : mine && cap.status === 'device-lost'
            ? 'RECONNECT'
            : mine && cap.status === 'permission-denied'
              ? 'TRY AGAIN'
              : 'START'}
      </button>
    </div>
  );
}

/**
 * CE1F — the generator source row: pick the generator, see its identity.
 * Its PARAMETERS live in the Inspector's SOURCE group (same param system as
 * techniques), so this row stays compact.
 */
function GeneratorRow({
  source,
  active,
  onSelect,
}: {
  source: GeneratorSourceRef;
  active: boolean;
  onSelect: () => void;
}) {
  const apply = useProjectStore((s) => s.apply);
  const def = getGenerator(source.generator);
  return (
    <div className={`media-item camera-row${active ? ' active' : ''}`} onClick={onSelect}>
      <span className="media-kind kind-generator">GEN</span>
      <span className="media-text">
        <span className="media-name">{def?.name ?? source.generator}</span>
        <select
          className="select camera-device"
          aria-label="Generator"
          value={source.generator}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const next = e.target.value;
            apply((p) => ({
              ...p,
              sources: p.sources.map((s) =>
                s.id === source.id && s.kind === 'generator'
                  ? { ...s, generator: next, params: generatorDefaults(next) }
                  : s,
              ),
            }));
          }}
        >
          {GENERATORS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
