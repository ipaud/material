import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC, type MenuEventId } from '../../shared/ipc';

export function buildAppMenu(getWindow: () => BrowserWindow | null): void {
  const send = (id: MenuEventId) => () => {
    getWindow()?.webContents.send(IPC.menuEvent, id);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
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
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
