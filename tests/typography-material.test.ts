import { describe, expect, test } from 'vitest';
import { typographyTokens } from '@/materials/typography';
import { BUILTIN_MATERIALS, shapeIndexForMaterial } from '@/materials/builtins';
import { materialStateSchema } from '@shared/schemas/project';
import { mosaicDefinition } from '@/techniques/mosaic/definition';

describe('Typography material', () => {
  test('character, word and phrase modes produce stable bounded tokens', () => {
    expect(typographyTokens('MATERIAL', 'character')).toEqual([...Array.from('MATERIAL')]);
    expect(typographyTokens('kinetic image', 'word')).toEqual(['kinetic', 'image']);
    expect(typographyTokens(' kinetic\nimage ', 'phrase')).toEqual(['kinetic\nimage']);
    expect(typographyTokens(' e\u0301lan ', 'character')[0]).toBe('é');
    expect(typographyTokens('  ', 'word')).toEqual(['□']);
    expect(typographyTokens('x'.repeat(200), 'character')).toHaveLength(64);
  });

  test('registry has unique categorized material ids and preserves shape indices', () => {
    expect(new Set(BUILTIN_MATERIALS.map((material) => material.id)).size).toBe(BUILTIN_MATERIALS.length);
    expect(BUILTIN_MATERIALS.find((material) => material.id === 'typography')).toMatchObject({
      category: 'Typography', renderer: 'texture',
    });
    expect(shapeIndexForMaterial('triangle')).toBe(5);
    expect(shapeIndexForMaterial('typography')).toBe(0);
  });

  test('text material schema accepts stable app font id and rejects unsafe or unknown settings', () => {
    const material = {
      materialId: 'typography', colorMode: 'source', assetPath: null,
      params: { text: 'MATERIAL', mode: 'character', fontId: 'noto-sans-mono', weight: 500, size: 280, tracking: 2 },
    };
    expect(materialStateSchema.safeParse(material).success).toBe(true);
    expect(materialStateSchema.safeParse({ ...material, params: { ...material.params, fontId: '/System/Library/Fonts/Any.ttf' } }).success).toBe(false);
    expect(materialStateSchema.safeParse({ ...material, params: { ...material.params, text: 'x'.repeat(4097) } }).success).toBe(false);
  });

  test('glyph selection joins existing modulation and Explore parameter paths', () => {
    const glyphIndex = mosaicDefinition.sections.flatMap((section) => section.params).find((param) => param.id === 'glyphIndex');
    expect(glyphIndex).toMatchObject({ modulatable: true, explore: { randomizable: true, min: 0, max: 63 } });
  });
});
