import { LooksPanel } from './LooksPanel';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { relinkSource } from '@/projects/projectActions';
import { cameraManager, useCameraStore } from '@/sources/cameraManager';
import { withTechniqueEnsured } from '@/projects/projectActions';
import { uid } from '@/utils/id';
import './library.css';

type SourceRef = ReturnType<typeof useProjectStore.getState>['project']['sources'][number];

/** One quiet line of real metadata: dimensions, duration, size — whatever exists. */
function describe(source: SourceRef): string {
  if (source.kind === 'camera') return 'LIVE INPUT';
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
      if (kind === 'camera') {
        // Selecting the camera source only points the composition at it —
        // capture starts exclusively from the explicit START action.
        return { ...p, composition: { ...p.composition, sourceId: id } };
      }
      if (kind === 'svg' && source.kind === 'svg') {
        // SVGs are materials, not composition sources.
        return { ...p, material: { ...p.material, materialId: 'custom', assetPath: source.path } };
      }
      if ((kind === 'image' || kind === 'video') && source.kind !== 'camera') {
        const meta = source.metadata;
        return {
          ...p,
          composition: {
            ...p.composition,
            sourceId: id,
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
      if (!source || source.kind === 'camera') return p;
      return { ...p, material: { ...p.material, materialId: 'custom', assetPath: source.path } };
    });
  };

  const addCamera = () => {
    apply((p) => {
      if (p.sources.some((s) => s.kind === 'camera')) return p;
      const id = uid('cam');
      // Same as file import: a first source must land on a working system.
      return withTechniqueEnsured({
        ...p,
        sources: [...p.sources, { id, kind: 'camera' as const, deviceId: null }],
        composition: { ...p.composition, sourceId: id },
      });
    });
  };
  const hasCamera = sources.some((s) => s.kind === 'camera');

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
        </div>
        {sources.length === 0 ? (
          <div className="library-empty">No media imported</div>
        ) : (
          <ul className="media-list">
            {sources.map((source) => {
              const isActive = source.id === activeSourceId || source.id === activeAudioId;
              const isOffline = source.kind !== 'camera' && offlineSources.includes(source.id);
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
