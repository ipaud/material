import { useUiStore } from '@/state/uiStore';
import { BuildWorkspace } from './BuildWorkspace';
import { ExploreWorkspace } from './ExploreWorkspace';
import { PerformWorkspace } from './PerformWorkspace';
import { OutputWorkspace } from '@/output/OutputWorkspace';

interface Props {
  isDragOver: boolean;
}

export function WorkspaceRouter({ isDragOver }: Props) {
  const workspace = useUiStore((s) => s.workspace);

  switch (workspace) {
    case 'explore':
      return <ExploreWorkspace isDragOver={isDragOver} />;
    case 'perform':
      return <PerformWorkspace />;
    case 'output':
      return <OutputWorkspace />;
    default:
      return <BuildWorkspace isDragOver={isDragOver} />;
  }
}
