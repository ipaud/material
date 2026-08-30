import { useEffect, useState } from 'react';
import type { LoadedPack } from '@shared/schemas/shaderPack';
import { listPacks, subscribePacks } from './packRegistry';
import { importPack, isBuiltinPack, refreshInstalledPacks, reloadPack, uninstallPack } from './packManager';
import './shaderPacks.css';

/**
 * v0.5B — the pack manager.
 *
 * Deliberately small: what is installed, how many shaders each one has, and
 * the three actions that matter. There is no marketplace, no browser and no
 * preview grid — a pack's shaders appear in the technique picker like every
 * other technique, which is where a user is already looking for them.
 */
export function ShaderPacksPanel(): React.ReactElement {
  const [packs, setPacks] = useState<LoadedPack[]>(listPacks());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [root, setRoot] = useState<string>('');

  useEffect(() => {
    const unsub = subscribePacks(() => setPacks([...listPacks()]));
    void window.material.shaderPacksRoot().then(setRoot).catch(() => undefined);
    return unsub;
  }, []);

  const onImport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await importPack();
    if (!result.ok && result.error) setError(result.error);
    await refreshInstalledPacks();
    setBusy(false);
  };

  return (
    <div className="shader-packs">
      <div className="shader-packs-head">
        <span className="label">Shader Packs</span>
        <button className="vp-btn" disabled={busy} onClick={() => void onImport()}>
          IMPORT
        </button>
      </div>

      {error && <div className="shader-packs-error">{error}</div>}

      {packs.length === 0 && <div className="shader-packs-empty">No packs installed.</div>}

      {packs.map((pack) => (
        <div className="shader-pack" key={pack.id}>
          <div className="shader-pack-row">
            <span className="shader-pack-name">{pack.name}</span>
            <span className="shader-pack-meta mono">
              {pack.version} · {pack.shaders.length} shader{pack.shaders.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="shader-pack-row">
            <span className="shader-pack-id mono">{pack.id}</span>
            {!isBuiltinPack(pack.id) && (
              <span className="shader-pack-actions">
                <button className="vp-btn" onClick={() => void reloadPack(pack.id)}>
                  RELOAD
                </button>
                <button className="vp-btn" onClick={() => void uninstallPack(pack.id)}>
                  REMOVE
                </button>
              </span>
            )}
            {isBuiltinPack(pack.id) && <span className="shader-pack-builtin">built in</span>}
          </div>
          {pack.warnings.length > 0 && (
            <ul className="shader-pack-warnings">
              {pack.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {root && (
        <div className="shader-packs-root mono" title={root}>
          Installed to {root}
        </div>
      )}
    </div>
  );
}
