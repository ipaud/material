import { useProjectStore } from '@/state/projectStore';

export function InspectorPanel() {
  const hasSource = useProjectStore((s) => s.project.composition.sourceId !== null);

  return (
    <>
      <div className="panel-header">
        <span className="label">Inspector</span>
      </div>
      <div className="panel-body">
        {!hasSource && (
          <div style={{ padding: 'var(--sp-5) var(--sp-4)', color: 'var(--text-2)', fontSize: 'var(--text-sm)' }}>
            Import a source to begin
          </div>
        )}
        {/* Technique parameter sections arrive with the Mosaic renderer (Phase 1). */}
      </div>
    </>
  );
}
