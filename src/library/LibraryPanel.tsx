import { useProjectStore } from '@/state/projectStore';
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
  const apply = useProjectStore((s) => s.apply);

  const selectSource = (id: string, kind: string) => {
    apply((p) => {
      const source = p.sources.find((s) => s.id === id);
      if (!source) return p;
      if (kind === 'audio') {
        return { ...p, composition: { ...p.composition, audioSourceId: id } };
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
              return (
                <li key={source.id}>
                  <button
                    className={`media-item${isActive ? ' active' : ''}`}
                    onClick={() => selectSource(source.id, source.kind)}
                    title={source.path}
                  >
                    <span className={`media-kind kind-${source.kind}`}>
                      {KIND_LABEL[source.kind] ?? '?'}
                    </span>
                    <span className="media-name">
                      {source.metadata?.fileName ?? source.path.split('/').pop()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
