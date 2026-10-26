import { useState, type ReactNode } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { midiEngine, useMidiStore } from '@/midi/midiEngine';
import { WebMidiTransport } from '@/midi/transport';
import { useUiStore } from '@/state/uiStore';
import { selectedLayerOf } from '@shared/schemas/project';

/**
 * Right-click surface for a numeric parameter row: MIDI Learn / Clear (§15).
 * Shows a small badge when the param is CC-mapped, plus the pickup state.
 */
export function MidiParamWrap({ paramId, stageId, children }: { paramId: string; stageId?: string; children: ReactNode }) {
  const layerId = useProjectStore((s) => selectedLayerOf(s.project).id);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const mapping = useProjectStore((s) =>
    s.project.midiMappings.find(
      (m) => m.targetType === 'param' && m.targetParam === paramId && (m.targetStageId ?? null) === (stageId ?? null) &&
        (stageId ? m.targetLayerId === layerId : !m.targetStageId) && m.messageType === 'cc',
    ),
  );
  const status = useMidiStore((s) => (mapping ? s.status[mapping.id] : undefined));

  const learn = async () => {
    setMenuAt(null);
    if (!midiEngine.isRunning) {
      const ok = await midiEngine.start(new WebMidiTransport());
      if (!ok) {
        useUiStore.getState().pushToast('error', 'MIDI unavailable on this system');
        return;
      }
    }
    await midiEngine.startLearn({
      targetType: 'param', targetParam: paramId,
      ...(stageId ? { targetLayerId: layerId, targetStageId: stageId } : {}),
    }, paramId);
  };

  const clear = () => {
    setMenuAt(null);
    if (!mapping) return;
    useProjectStore.getState().apply((p) => ({
      ...p,
      midiMappings: p.midiMappings.filter((m) => m.id !== mapping.id),
    }));
  };

  return (
    <div
      className="midi-param-wrap"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      {children}
      {mapping && (
        <span
          className={`midi-badge mono${status === 'waiting' ? ' waiting' : ''}`}
          title={
            status === 'waiting'
              ? 'Waiting for pickup — move the control across the current value'
              : `MIDI CC ${mapping.control} (ch ${(mapping.channel ?? 0) + 1})`
          }
        >
          {status === 'offline' ? 'MIDI ⨯' : `CC${mapping.control}`}
          {status === 'waiting' && ' ◌'}
        </span>
      )}
      {menuAt && (
        <>
          <div className="midi-menu-backdrop" onClick={() => setMenuAt(null)} />
          <div className="midi-menu" style={{ left: menuAt.x, top: menuAt.y }}>
            <button onClick={() => void learn()}>MIDI Learn</button>
            {mapping && <button onClick={clear}>Clear MIDI Mapping</button>}
          </div>
        </>
      )}
    </div>
  );
}
