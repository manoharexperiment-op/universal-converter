const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const { startServer } = require('./static-server.cjs');

let win;

async function createWindow() {
  // dist/ sits next to this electron/ folder (both packed into the app).
  const root = path.join(__dirname, '..', 'dist');
  const port = await startServer(root);

  win = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 460,
    minHeight: 600,
    backgroundColor: '#0a1228',
    title: 'MunnX Convertor',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadURL(`http://127.0.0.1:${port}/`);

  // Converted files download via <a download> — show a native "Save As" dialog.
  win.webContents.session.on('will-download', (_event, item) => {
    const target = dialog.showSaveDialogSync(win, { defaultPath: item.getFilename() });
    if (target) item.setSavePath(target);
    else item.cancel();
  });

  // Open any external links in the user's real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
