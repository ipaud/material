import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockMenu } = vi.hoisted(() => ({
  mockMenu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: { name: 'MATERIAL' }, Menu: mockMenu }));
vi.mock('../electron/main/buildInfo', () => ({ configureAboutPanel: vi.fn() }));
vi.mock('../electron/main/updater', () => ({ checkForUpdates: vi.fn(), setAutoCheck: vi.fn() }));

import { buildAppMenu } from '../electron/main/menu';

afterEach(() => vi.clearAllMocks());

describe('application menu', () => {
  it('provides native page zoom controls in View', () => {
    buildAppMenu(() => null, false);
    const template = mockMenu.setApplicationMenu.mock.calls[0]?.[0] as {
      label?: string;
      submenu?: { role?: string }[];
    }[];
    const roles = template.find((item) => item.label === 'View')?.submenu?.map((item) => item.role);

    expect(roles).toEqual(expect.arrayContaining(['zoomIn', 'resetZoom', 'zoomOut']));
  });
});
