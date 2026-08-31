import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shaderPackManifestSchema, type LoadedPack } from '@shared/schemas/shaderPack';
import { customTechniqueDefinition } from '@/shaders/customTechnique';
import { registerPack, removePack } from '@/shaders/packRegistry';
import { packPresets } from '@/shaders/packPresets';
import { getTechnique, isMissingTechnique, listTechniques } from '@/techniques/registry';
import { allParams, defaultParams } from '@/techniques/types';
import { SmoothingState, applyModulations, replaceConflicts } from '@/modulation/evaluator';
import { shaderHash } from '@/shaders/shaderHash';
import type { ModulationMapping } from '@shared/schemas/project';

/**
 * v0.5C — the integration claim, stated as tests.
 *
 * The claim is that a pack shader needs NO shader-specific code anywhere else:
 * the inspector, modulation, signals, Explore, Looks and Morph should already
 * work because a custom shader is an ordinary TechniqueDefinition. These tests
 * fail if that stops being true — which is the signal to fix the abstraction,
 * not the feature that noticed.
 */

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

function starterPack(): LoadedPack {
  const dir = join('resources', 'shader-packs', 'material-starter');
  const manifest = shaderPackManifestSchema.parse(JSON.parse(read(dir, 'material-pack.json')));
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    dir,
    warnings: [],
    shaders: manifest.shaders.map((entry) => {
      const fragment = read(dir, entry.file);
      return {
        packId: manifest.id,
        packName: manifest.name,
        packVersion: manifest.version,
        entry,
        fragment,
        hash: shaderHash(entry, fragment),
      };
    }),
  };
}

const map = (over: Partial<ModulationMapping>): ModulationMapping => ({
  id: 'm',
  enabled: true,
  source: 's',
  target: 'amount',
  amount: 1,
  min: 0,
  max: 1,
  invert: false,
  smoothing: 0,
  curve: 'linear',
  frozenValue: null,
  ...over,
});

describe('a pack shader is a technique everything else already understands', () => {
  const pack = starterPack();

  it('registers into the same registry the technique picker reads', () => {
    registerPack(pack);
    try {
      const ids = listTechniques().map((t) => t.id);
      expect(ids).toContain('custom:material.starter:ripple');
      expect(getTechnique('custom:material.starter:ripple')?.name).toBe('Ripple');
      expect(isMissingTechnique('custom:material.starter:ripple')).toBe(false);
    } finally {
      removePack(pack.id);
    }
  });

  it('removing a pack takes its techniques back out, and the id goes MISSING', () => {
    registerPack(pack);
    removePack(pack.id);
    expect(listTechniques().map((t) => t.id)).not.toContain('custom:material.starter:ripple');
    expect(isMissingTechnique('custom:material.starter:ripple')).toBe(true);
    // Still resolvable, so a project holding that id keeps rendering.
    expect(getTechnique('custom:material.starter:ripple')?.name).toBe('Missing Shader Pack');
  });

  it('replacing a pack version drops a shader that no longer exists', () => {
    registerPack(pack);
    registerPack({ ...pack, version: '2.0.0', shaders: pack.shaders.slice(0, 1) });
    try {
      const ids = listTechniques().map((t) => t.id);
      expect(ids).toContain(`custom:${pack.id}:${pack.shaders[0]!.entry.id}`);
      expect(ids).not.toContain(`custom:${pack.id}:${pack.shaders[1]!.entry.id}`);
    } finally {
      removePack(pack.id);
    }
  });
});

describe('custom parameters flow into modulation with no special case', () => {
  const def = customTechniqueDefinition(
    starterPack().shaders.find((s) => s.entry.id === 'ripple')!,
  );

  it('numeric params are modulation targets; a bool is not', () => {
    const modulatable = allParams(def)
      .filter((p) => p.type === 'number' && p.modulatable)
      .map((p) => p.id);
    expect(modulatable).toContain('amount');
    expect(modulatable).toContain('centerX');
    const posterise = customTechniqueDefinition(
      starterPack().shaders.find((s) => s.entry.id === 'posterise')!,
    );
    expect(allParams(posterise).find((p) => p.id === 'mono')?.type).toBe('boolean');
  });

  it('ADD works on a custom parameter, in the parameter own units', () => {
    const out = applyModulations(
      { ...defaultParams(def) },
      [map({ target: 'amount', amount: 1 })],
      { s: 0.5 },
      def,
      new SmoothingState(),
      1 / 60,
    );
    // amount is declared 0..0.15, so a half-strength full-range mapping adds
    // 0.075 on top of the 0.03 default.
    expect(out.amount).toBeCloseTo(0.03 + 0.5 * 0.15, 6);
  });

  it('SET positions a custom parameter — what a centroid needs', () => {
    const out = applyModulations(
      { ...defaultParams(def) },
      [map({ target: 'centerX', mode: 'replace', min: 0.2, max: 0.8 })],
      { s: 0.5 },
      def,
      new SmoothingState(),
      1 / 60,
    );
    // centerX is declared 0..1, so the 0.2..0.8 window puts the midpoint at 0.5.
    expect(out.centerX).toBeCloseTo(0.5, 6);
    const low = applyModulations(
      { ...defaultParams(def) },
      [map({ target: 'centerX', mode: 'replace', min: 0.2, max: 0.8 })],
      { s: 0 },
      def,
      new SmoothingState(),
      1 / 60,
    );
    expect(low.centerX).toBeCloseTo(0.2, 6);
  });

  it('a centred signal at rest contributes nothing to a custom parameter', () => {
    const out = applyModulations(
      { ...defaultParams(def) },
      [map({ target: 'centerY', source: 'motion.y', min: -1, max: 1 })],
      { 'motion.y': 0.5 },
      def,
      new SmoothingState(),
      1 / 60,
    );
    expect(out.centerY).toBeCloseTo(defaultParams(def).centerY as number, 10);
  });

  it('the Set conflict rule applies to custom params like any other', () => {
    const ignored = replaceConflicts([
      map({ id: 'a', target: 'centerX', mode: 'replace' }),
      map({ id: 'b', target: 'centerX', mode: 'replace' }),
    ]);
    expect([...ignored]).toEqual(['b']);
  });

  it('an absent signal leaves a custom parameter exactly at its base', () => {
    const out = applyModulations(
      { ...defaultParams(def) },
      [map({ target: 'amount', source: 'motion.amount', invert: true })],
      {},
      def,
      new SmoothingState(),
      1 / 60,
    );
    expect(out.amount).toBe(defaultParams(def).amount);
  });
});

describe('pack presets are params only (§79)', () => {
  const pack = starterPack();

  it('a declared preset becomes an ordinary preset for its own technique', () => {
    registerPack(pack);
    try {
      const presets = packPresets();
      const deep = presets.find((p) => p.id.endsWith(':deepRipple'));
      expect(deep).toBeDefined();
      expect(deep!.techniqueId).toBe('custom:material.starter:softWarp');
      expect(deep!.params).toEqual({ amount: 0.12, scale: 2, speed: 0.6 });
      // No pack gets to write mappings or triggers into a document.
      expect(deep!.modulations).toEqual([]);
      expect(deep!.triggers).toEqual([]);
    } finally {
      removePack(pack.id);
    }
  });

  it('a preset value outside the declared range is clamped, not trusted', () => {
    const shader = pack.shaders.find((s) => s.entry.id === 'softWarp')!;
    registerPack({
      ...pack,
      shaders: [
        {
          ...shader,
          entry: {
            ...shader.entry,
            presets: [{ id: 'wild', name: 'Wild', params: { amount: 99, scale: -5, bogus: 1 } }],
          },
        },
      ],
    });
    try {
      const wild = packPresets().find((p) => p.id.endsWith(':wild'))!;
      expect(wild.params.amount).toBe(0.2); // declared max
      expect(wild.params.scale).toBe(0.5); // declared min
      // A key the shader does not declare is dropped rather than carried.
      expect('bogus' in wild.params).toBe(false);
    } finally {
      removePack(pack.id);
    }
  });
});

describe('structural — no feature had to learn about shaders (§67, §81)', () => {
  it('the inspector renders pack params through its ordinary path', () => {
    const panel = read('src', 'inspector', 'InspectorPanel.tsx');
    // It groups params from the definition, exactly as for a native technique.
    expect(panel).toContain('groupParams(definition)');
    // And the pack contributes no UI of its own.
    expect(panel.includes('dangerouslySetInnerHTML')).toBe(false);
  });

  it('no pack-supplied React, HTML or CSS can reach the UI', () => {
    const schema = read('shared', 'schemas', 'shaderPack.ts');
    for (const forbidden of ['html', 'component', 'css', 'style', 'render']) {
      expect(schema.toLowerCase().includes(`${forbidden}:`), `schema exposes ${forbidden}`).toBe(false);
    }
  });

  it('modulation, Explore and Looks contain no shader-specific branch', () => {
    for (const f of [
      ['src', 'modulation', 'evaluator.ts'],
      ['src', 'modulation', 'runtime.ts'],
      ['src', 'performance', 'mutation.ts'],
      ['src', 'performance', 'interpolate.ts'],
    ]) {
      const src = read(...f);
      for (const forbidden of ['custom:', 'CustomShaderRenderer', 'packRegistry', 'LoadedShader']) {
        expect(src.includes(forbidden), `${f.join('/')} special-cases shaders via ${forbidden}`).toBe(false);
      }
    }
  });

  it('a slider move cannot recompile — only the hash triggers that', () => {
    const renderer = read('src', 'shaders', 'CustomShaderRenderer.ts');
    expect(renderer).toContain('if (this.compiledHash === this.shader.hash) return;');
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    // The renderer is rebuilt on technique IDENTITY change, never on params —
    // per layer since v0.6, so the comparison is against that layer's own
    // previous id rather than a module-wide one.
    expect(bridge).toContain('if (techniqueId !== state.techniqueId)');
  });
});
