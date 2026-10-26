import type { MaterialState } from '@shared/schemas/project';

export type TypographyMode = 'character' | 'word' | 'phrase';

export const TYPOGRAPHY_FONT_ID = 'noto-sans-mono';
export const TYPOGRAPHY_MAX_ITEMS = 64;

export const TYPOGRAPHY_DEFAULTS: MaterialState = {
  materialId: 'typography',
  colorMode: 'source',
  assetPath: null,
  params: {
    text: 'MATERIAL',
    mode: 'character',
    fontId: TYPOGRAPHY_FONT_ID,
    weight: 500,
    size: 320,
    tracking: 2,
  },
};

export function typographyTokens(text: string, mode: TypographyMode): string[] {
  const normalized = text.normalize('NFC').trim();
  if (mode === 'phrase') return [normalized || '□'];
  const tokens = mode === 'word'
    ? normalized.split(/\s+/u).filter(Boolean)
    : Array.from(normalized).filter((char) => !/\s/u.test(char));
  return (tokens.length ? tokens : ['□']).slice(0, TYPOGRAPHY_MAX_ITEMS);
}
