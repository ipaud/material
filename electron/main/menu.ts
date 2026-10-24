import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC, type MenuEventId } from '../../shared/ipc';
import { configureAboutPanel } from './buildInfo';
import { checkForUpdates, setAutoCheck } from './updater';

const isMac = process.platform === 'darwin';

export function buildAppMenu(
  getWindow: () => BrowserWindow | null,
  autoUpdateCheck: boolean,
): void {
  configureAboutPanel();
  const send = (id: MenuEventId) => () => {
    getWindow()?.webContents.send(IPC.menuEvent, id);
  };
  const updateItems: MenuItemConstructorOptions[] = [
    { label: 'Check for Updates…', click: () => void checkForUpdates(getWindow, true) },
    {
      label: 'Check for Updates Automatically',
      type: 'checkbox',
      checked: autoUpdateCheck,
      click: (item) => void setAutoCheck(item.checked),
    },
  ];
  const macAppMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      ...updateItems,
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('new-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open-project') },
        { type: 'separator' },
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: send('import-media') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save-project') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('save-project-as') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Debug Overlay',
          accelerator: 'CmdOrCtrl+D',
          click: send('toggle-debug-overlay'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.NODE_ENV === 'development'
          ? ([{ role: 'toggleDevTools' }, { role: 'reload' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    { role: 'windowMenu' },
    // Windows / Linux: no app-name menu, so Quit lives in File and updates and About in Help.
    ...(isMac
      ? []
      : [
          {
            label: 'Help',
            submenu: [...updateItems, { type: 'separator' }, { role: 'about' }],
          } as MenuItemConstructorOptions,
        ]),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
