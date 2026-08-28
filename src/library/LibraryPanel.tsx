import { LooksPanel } from './LooksPanel';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { relinkSource } from '@/projects/projectActions';
import './library.css';

const KIND_LABEL: Record<string, string> = {
  image: 'IMG',
  video: 'VID',
  audio: 'AUD',
  svg: 'SVG',
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
      if (kind === 'svg') {
        // SVGs are materials, not composition sources.
        return { ...p, material: { ...p.material, materialId: 'custom', assetPath: source.path } };
      }
      if (kind === 'image' || kind === 'video') {
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
      if (!source) return p;
      return { ...p, material: { ...p.material, materialId: 'custom', assetPath: source.path } };
    });
  };

  return (
    <>
      <div className="panel-header">
        <span className="label">Library</span>
      </div>
      <div className="panel-body">
        {sources.length === 0 ? (
          <div className="library-empty">No media imported</div>
        ) : (
          <ul className="media-list">
            {sources.map((source) => {
              const isActive = source.id === activeSourceId || source.id === activeAudioId;
              const isOffline = offlineSources.includes(source.id);
              return (
                <li key={source.id}>
                  <button
                    className={`media-item${isActive ? ' active' : ''}${isOffline ? ' offline' : ''}`}
                    onClick={() =>
                      isOffline ? void relinkSource(source.id) : selectSource(source.id, source.kind)
                    }
                    title={isOffline ? `MEDIA OFFLINE — click to relink\n${source.path}` : source.path}
                  >
                    <span className={`media-kind kind-${source.kind}`}>
                      {isOffline ? 'OFF' : (KIND_LABEL[source.kind] ?? '?')}
                    </span>
                    <span className="media-name">
                      {source.metadata?.fileName ?? source.path.split('/').pop()}
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
