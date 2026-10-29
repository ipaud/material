import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { addGeneratorSource, importMediaPaths } from '@/projects/projectActions';

/** Pins and Looks: what a pin captures, how slots fill, and that each edit is one undo step. */

const thumb = vi.hoisted(() => ({ dataUrl: 'data:image/png;base64,AAAA' as string | null, luminance: 0.4 as number | null }));
vi.mock('@/performance/thumbnail', () => ({
  renderThumbnail: () => ({ ...thumb }),
  isDarkThumbnail: (l: number | null) => l !== null && l < 0.02,
}));

const {
  applyLookBySlot,
  deleteLook,
  duplicateLook,
  endPinPreview,
  makeLook,
  overwriteSlotWithCurrent,
  pinCurrentLook,
  previewPin,
  renameLook,
  rethumbnailLook,
} = await import('@/projects/lookActions');

const store = () => useProjectStore.getState();
const looks = () => store().project.pinnedLooks;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  store().newProject();
  useUiStore.setState({ toasts: [] });
  thumb.dataUrl = 'data:image/png;base64,AAAA';
  thumb.luminance = 0.4;
});

describe('pinning', () => {
  it('there is nothing to pin before the layer has a technique', () => {
    expect(pinCurrentLook()).toBeNull();
    expect(toasts()).toEqual(['Nothing to pin yet']);
    expect(looks()).toEqual([]);
  });

  it('numbers pins after the highest one, even after deletions', () => {
    addGeneratorSource('noise');
    const a = pinCurrentLook()!;
    const b = pinCurrentLook()!;
    deleteLook(a.id);
    const c = pinCurrentLook()!;
    expect([a.label, b.label, c.label]).toEqual(['PIN 001', 'PIN 002', 'PIN 003']);
    expect(c).toMatchObject({ slot: null, thumbnail: thumb.dataUrl, techniques: [expect.objectContaining({ techniqueId: 'mosaic' })] });
  });
});

describe('Look slots', () => {
  beforeEach(() => addGeneratorSource('noise'));

  it('a pin promoted to a Look takes the first free key; a renamed one keeps its name', () => {
    const a = pinCurrentLook()!;
    const b = pinCurrentLook()!;
    renameLook(b.id, '  Bass drop  ');
    expect(makeLook(a.id)).toBe(true);
    expect(makeLook(b.id)).toBe(true);
    expect(looks().map((l) => [l.label, l.slot])).toEqual([
      ['LOOK 01', 1],
      ['Bass drop', 2],
    ]);
    expect(makeLook(a.id)).toBe(true); // already a Look
    expect(looks()[0]!.slot).toBe(1);
    expect(makeLook('missing')).toBe(false);
  });

  it('with all nine keys taken, a pin stays a pin', () => {
    for (let s = 1; s <= 9; s++) overwriteSlotWithCurrent(s);
    const pin = pinCurrentLook()!;
    expect(makeLook(pin.id)).toBe(false);
    expect(toasts().at(-1)).toBe('No empty Look slots');
  });

  it('Shift+number on an empty key makes a Look in one undo step', () => {
    overwriteSlotWithCurrent(4);
    expect(looks()).toHaveLength(1);
    expect(looks()[0]).toMatchObject({ slot: 4, label: 'LOOK 04' });
    expect(store().project.activeLookId).toBe(looks()[0]!.id);
    store().undo();
    expect(looks()).toEqual([]);
  });

  it('Shift+number on a taken key overwrites that Look in place', () => {
    overwriteSlotWithCurrent(2);
    const id = looks()[0]!.id;
    useProjectStore.getState().apply((p) => ({ ...p, name: 'changed' }));
    overwriteSlotWithCurrent(2);
    expect(looks()).toHaveLength(1);
    expect(looks()[0]!.id).toBe(id);
    expect(toasts().at(-1)).toBe('Slot 2 overwritten with current state');
  });

  it('recall by key only for keys that hold a Look', () => {
    expect(applyLookBySlot(3)).toBe(false);
    overwriteSlotWithCurrent(3);
    expect(applyLookBySlot(3)).toBe(true);
  });
});

describe('editing Looks', () => {
  beforeEach(() => addGeneratorSource('noise'));

  it('rename trims and caps at 40 characters; a blank name is ignored', () => {
    const pin = pinCurrentLook()!;
    renameLook(pin.id, `  ${'x'.repeat(60)} `);
    expect(looks()[0]!.label).toBe('x'.repeat(40));
    renameLook(pin.id, '   ');
    expect(looks()[0]!.label).toBe('x'.repeat(40));
  });

  it('a copy is labelled and gets the next free key', () => {
    overwriteSlotWithCurrent(1);
    duplicateLook(looks()[0]!.id);
    expect(looks()[1]).toMatchObject({ label: 'LOOK 01 COPY', slot: 2 });
    expect(looks()[1]!.id).not.toBe(looks()[0]!.id);
    const before = store().project;
    duplicateLook('missing');
    expect(store().project).toBe(before);
  });

  it('deleting the active Look clears the active marker', () => {
    overwriteSlotWithCurrent(1);
    deleteLook(looks()[0]!.id);
    expect(store().project.activeLookId).toBeNull();
  });

  it('a new thumbnail from a dark frame is kept but flagged', () => {
    const pin = pinCurrentLook()!;
    thumb.dataUrl = 'data:image/png;base64,DARK';
    thumb.luminance = 0.001;
    rethumbnailLook(pin.id);
    expect(looks()[0]!.thumbnail).toBe('data:image/png;base64,DARK');
    expect(toasts().at(-1)).toBe('Thumbnail is very dark — try again on a brighter frame');

    thumb.dataUrl = null; // nothing rendered: keep what was there
    rethumbnailLook(pin.id);
    expect(looks()[0]!.thumbnail).toBe('data:image/png;base64,DARK');
  });
});

describe('compare (hold to preview)', () => {
  it('previews a generator Pin without touching the saved project', () => {
    addGeneratorSource('noise');
    const pin = pinCurrentLook()!;
    const saved = store().project;
    expect(previewPin(pin.id)).toBe(true);
    expect(store().previewLabel).toBe(`Compare ${pin.label}`);
    expect(store().project).toBe(saved);
    endPinPreview();
    expect(store().previewLabel).toBeNull();
    expect(previewPin('missing')).toBe(false);
  });

  it('refuses Pins that need a file source', async () => {
    vi.stubGlobal('material', {
      probeMedia: async (path: string) => ({ kind: 'video', path, fileName: 'a.mp4', fileSize: 1, durationSec: 1, width: 10, height: 10, frameRate: 30, videoCodec: 'h264', audioCodec: null, audioChannels: null, sampleRate: null }),
    });
    await importMediaPaths(['/media/a.mp4']);
    vi.unstubAllGlobals();
    const pin = pinCurrentLook()!;
    expect(previewPin(pin.id)).toBe(false);
    expect(toasts().at(-1)).toBe('Compare currently supports existing generator sources only');
  });
});
