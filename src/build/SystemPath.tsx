import { useProjectStore } from '@/state/projectStore';
import { getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { BUILTIN_MATERIALS } from '@/materials/builtins';
import { MOD_SOURCES } from '@/modulation/sources';
import { parsePatternSourceKey } from '@/pattern/patternSourceRuntime';
import './system-path.css';

const MAX_SIGNALS = 3;
const MAX_SEGMENT_CHARS = 22;

function truncate(text: string): string {
  return text.length > MAX_SEGMENT_CHARS ? `${text.slice(0, MAX_SEGMENT_CHARS - 1)}…` : text;
}

interface Segment {
  key: string;
  text: string;
  title: string;
  /** A segment with nothing behind it yet reads dim, not absent. */
  placeholder?: boolean;
  current?: boolean;
}

/**
 * The processing chain, read straight off project state:
 *   VIDEO → TEMPORAL MOSAIC → SQUARE → BASS / ONSET → OUTPUT
 * Informational, one line, never a node graph.
 */
export function SystemPath() {
  const sources = useProjectStore((s) => s.project.sources);
  const composition = useProjectStore((s) => s.project.composition);
  const technique = useProjectStore((s) => s.project.techniques.find((t) => t.enabled) ?? null);
  const material = useProjectStore((s) => s.project.material);
  const modulations = useProjectStore((s) => s.project.modulations);
  const triggers = useProjectStore((s) => s.project.triggers);

  const segments: Segment[] = [
    sourceSegment(sources, composition.sourceId),
    techniqueSegment(technique),
    materialSegment(material),
    signalSegment(modulations, triggers),
    { key: 'output', text: 'OUTPUT', title: 'Rendered output' },
  ];

  return (
    <nav className="system-path" aria-label="Processing path">
      {segments.map((segment, i) => (
        <span key={segment.key} className="system-path-item">
          {i > 0 && <span className="system-path-arrow">→</span>}
          <span
            className={`system-path-seg${segment.placeholder ? ' placeholder' : ''}${segment.current ? ' current' : ''}`}
            title={segment.title}
          >
            {segment.text}
          </span>
        </span>
      ))}
    </nav>
  );
}

type Sources = ReturnType<typeof useProjectStore.getState>['project']['sources'];

function sourceSegment(sources: Sources, sourceId: string | null): Segment {
  const source = sources.find((s) => s.id === sourceId) ?? null;
  if (!source)
    return { key: 'source', text: 'SOURCE', title: 'No source selected', placeholder: true };
  const name = source.metadata?.fileName ?? source.path.split('/').pop() ?? source.id;
  return { key: 'source', text: source.kind.toUpperCase(), title: name };
}

type Technique = ReturnType<typeof useProjectStore.getState>['project']['techniques'][number];

function techniqueSegment(technique: Technique | null): Segment {
  if (!technique)
    return { key: 'technique', text: 'TECHNIQUE', title: 'No technique', placeholder: true };
  const definition = getTechnique(technique.techniqueId);
  const name = (definition?.name ?? technique.techniqueId).toUpperCase();
  // "Temporal" is real state, not decoration: it means the technique is
  // reading composition-time frame history right now.
  const temporal = techniqueNeedsTemporal(technique.techniqueId, technique.params);
  return {
    key: 'technique',
    text: truncate(temporal ? `TEMPORAL ${name}` : name),
    title: definition?.description ?? name,
    current: true,
  };
}

type Material = ReturnType<typeof useProjectStore.getState>['project']['material'];

function materialSegment(material: Material): Segment {
  if (material.materialId === 'custom') {
    const file = material.assetPath?.split('/').pop() ?? 'CUSTOM';
    return {
      key: 'material',
      text: truncate(file.toUpperCase()),
      title: material.assetPath ?? 'Custom material',
    };
  }
  const builtin = BUILTIN_MATERIALS.find((m) => m.id === material.materialId);
  const name = (builtin?.name ?? material.materialId).toUpperCase();
  return { key: 'material', text: truncate(name), title: `Material: ${name}` };
}

type Modulations = ReturnType<typeof useProjectStore.getState>['project']['modulations'];
type Triggers = ReturnType<typeof useProjectStore.getState>['project']['triggers'];

function signalSegment(modulations: Modulations, triggers: Triggers): Segment {
  const labels: string[] = [];
  for (const m of modulations) {
    if (!m.enabled) continue;
    // Patterns collapse to one category segment: PAT 01 / PAT 02 / PAT 03
    // would drown the path in instances of the same idea.
    const label =
      parsePatternSourceKey(m.source) !== null
        ? 'PATTERN'
        : (MOD_SOURCES.find((s) => s.id === m.source)?.label ?? m.source);
    if (!labels.includes(label.toUpperCase())) labels.push(label.toUpperCase());
  }
  for (const t of triggers) {
    if (!t.enabled) continue;
    const label = t.source
      .replace(/^div:/, '')
      .replace(/^marker:.*/, 'MARKER')
      .toUpperCase();
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) {
    return {
      key: 'signals',
      text: 'NO SIGNAL',
      title: 'No enabled modulation or trigger',
      placeholder: true,
    };
  }
  const shown = labels.slice(0, MAX_SIGNALS);
  const more = labels.length - shown.length;
  return {
    key: 'signals',
    text: shown.join(' / ') + (more > 0 ? ` +${more}` : ''),
    title: labels.join(', '),
  };
}
