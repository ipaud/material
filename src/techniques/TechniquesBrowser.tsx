import { useEffect, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { getTechnique } from './registry';
import { defaultParams } from './types';
import { PREVIEW_PARAMS, TechniquePreviewRenderer } from './preview/previewRenderer';
import { uid } from '@/utils/id';
import './techniques-browser.css';

interface Card {
  id: string;
  techniqueId: string;
  name: string;
  category: 'SPACE' | 'TIME' | 'IMAGE' | 'MATERIAL';
  description: string;
}

/** Cards are curated entry points, not a raw dump of the registry. */
const CARDS: Card[] = [
  {
    id: 'mosaic',
    techniqueId: 'mosaic',
    name: 'Mosaic',
    category: 'SPACE',
    description: 'Rebuilds the image from a grid of repeated elements. Brightness drives their size.',
  },
  {
    id: 'mosaic-temporal',
    techniqueId: 'mosaic',
    name: 'Temporal Mosaic',
    category: 'TIME',
    description: 'Each cell shows the source at a different moment. Distance from centre becomes distance into the past.',
  },
  {
    id: 'echo',
    techniqueId: 'echo',
    name: 'Echo',
    category: 'TIME',
    description: 'Repeats the frame across time — every copy samples further back, fading as it goes.',
  },
  {
    id: 'step-print',
    techniqueId: 'step-print',
    name: 'Step Print',
    category: 'TIME',
    description: 'Holds and repeats stepped frames, turning smooth motion into stutter and trail.',
  },
  {
    id: 'slit-scan',
    techniqueId: 'slit-scan',
    name: 'Slit Scan',
    category: 'TIME',
    description: 'Maps image position to different moments in time. One frame becomes a span of seconds.',
  },
];

const CATEGORIES = ['ALL', 'SPACE', 'TIME', 'IMAGE', 'MATERIAL'] as const;

export function TechniquesBrowser() {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<(typeof CATEGORIES)[number]>('ALL');
  const [generating, setGenerating] = useState(true);
  const apply = useProjectStore((s) => s.apply);
  const activeId = useProjectStore((s) => s.project.techniques.find((t) => t.enabled)?.techniqueId);
  const setWorkspace = useUiStore((s) => s.setWorkspace);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    let cancelled = false;
    let renderer: TechniquePreviewRenderer | null = null;
    void (async () => {
      try {
        renderer = new TechniquePreviewRenderer();
        for (const card of CARDS) {
          if (cancelled) break;
          const dataUrl = await renderer.render(card.techniqueId, card.id);
          if (dataUrl && !cancelled) {
            setPreviews((prev) => ({ ...prev, [card.id]: dataUrl }));
          }
          // Yield so the browser paints progressively.
          await new Promise((r) => setTimeout(r, 0));
        }
      } catch {
        // Previews are decorative; the browser stays usable without them.
      } finally {
        if (!cancelled) setGenerating(false);
        renderer?.dispose();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyTechnique = (card: Card) => {
    const definition = getTechnique(card.techniqueId);
    if (!definition) return;
    apply((p) => ({
      ...p,
      techniques: [
        {
          id: uid('tech'),
          techniqueId: card.techniqueId,
          enabled: true,
          params: { ...defaultParams(definition), ...(PREVIEW_PARAMS[card.id] ?? {}) },
        },
      ],
      // Mappings target technique params, so a technique swap invalidates them.
      modulations: [],
    }));
    setWorkspace('create');
    pushToast('info', `${card.name} applied`);
  };

  const visible = CARDS.filter((c) => filter === 'ALL' || c.category === filter);

  return (
    <div className="techniques-browser">
      <div className="explore-toolbar">
        <span className="label">Techniques</span>
        <div className="explore-counts">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={`vp-btn${filter === c ? ' active' : ''}`}
              onClick={() => setFilter(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <span className="explore-spacer" />
        {generating && <span className="vp-readout mono">generating previews…</span>}
      </div>
      <div className="techniques-grid">
        {visible.map((card) => (
          <button
            key={card.id}
            className={`technique-card${activeId === card.techniqueId ? ' active' : ''}`}
            onClick={() => applyTechnique(card)}
            title={`Apply ${card.name}`}
          >
            <div className="technique-thumb">
              {previews[card.id] ? (
                <img src={previews[card.id]} alt="" draggable={false} />
              ) : (
                <div className="variation-pending" />
              )}
              <span className="technique-category mono">{card.category}</span>
            </div>
            <div className="technique-body">
              <span className="technique-name">{card.name}</span>
              <span className="technique-desc">{card.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
