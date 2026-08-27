import { importMediaViaDialog, newProject, openProject } from '@/projects/projectActions';

export function EmptyState({ isDragOver }: { isDragOver: boolean }) {
  return (
    <div className={`empty-state${isDragOver ? ' drag-over' : ''}`}>
      <div className="empty-state-title">MATERIAL</div>
      <div className="empty-state-hint">DROP IMAGE, VIDEO OR AUDIO</div>
      <div className="empty-state-actions">
        <button className="titlebar-action" onClick={() => void importMediaViaDialog()}>
          Import Media
        </button>
        <button className="titlebar-action" onClick={() => newProject()}>
          New Project
        </button>
        <button className="titlebar-action" onClick={() => void openProject()}>
          Open Project
        </button>
      </div>
    </div>
  );
}
