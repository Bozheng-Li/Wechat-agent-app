const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, safeStorage, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function runDesktop({ dataHome = process.env.WECHAT_APP_HOME, show = true } = {}) {
  // Electron keys its instance lock by userData. Claim the same per-user lock
  // before choosing a data directory, so another profile cannot start an app.
  const singletonHome = path.join(app.getPath('appData'), 'dsh-Wechat-app');
  app.setPath('userData', singletonHome);
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  app.setPath('userData', dataHome ? path.resolve(dataHome) : singletonHome);
  let window, tray, quitting = false, stopping, showRequested = show;
  const showWindow = () => {
    if (quitting) return;
    showRequested = true;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  app.on('second-instance', showWindow);
  await app.whenReady();
  require('./network.cjs').installNetworkFetch();
  const { createDesktopApplication } = await import('../lib/app.js');
  const application = await createDesktopApplication({ dataHome: app.getPath('userData'), encryption: {
    isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
  } });
  const page = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
  const active = new Map();
  window = new BrowserWindow({ width: 1360, height: 920, minWidth: 720, minHeight: 560, show: false,
    title: '微信 Agent', icon: path.join(__dirname, 'icon.ico'), backgroundColor: '#f5f6f5', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      spellcheck: false, backgroundThrottling: false, offscreen: !show } });
  const owner = event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page)
      throw new Error('只有本应用窗口可以管理微信助手');
  };
  ipcMain.handle('wechat-app:rpc', async (event, request) => {
    owner(event);
    if (!request || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id) ||
        typeof request.endpoint !== 'string' || request.endpoint.length > 100 || active.has(request.id)) throw new Error('无效请求');
    if (quitting) throw new Error('应用正在退出');
    const controller = new AbortController(); active.set(request.id, controller);
    try { return await application.call(request.endpoint, request.payload, controller.signal); }
    finally { active.delete(request.id); }
  });
  ipcMain.on('wechat-app:cancel', (event, id) => { try { owner(event); active.get(id)?.abort(); } catch {} });
  ipcMain.handle('wechat-app:external', async (event, address) => {
    owner(event);
    const url = new URL(address);
    if (typeof address !== 'string' || address.length > 8192 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页链接无效');
    await shell.openExternal(url.href);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('render-process-gone', () => { for (const controller of active.values()) controller.abort(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '微信 Agent', submenu: [{ label: '显示主窗口', click: showWindow }, { label: '退出', click: () => app.quit() }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.ico')));
  tray.setToolTip('微信 Agent · 关闭窗口后继续运行');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开微信 Agent', click: showWindow }, { label: '退出并停止微信助手', click: () => app.quit() }]));
  tray.on('double-click', showWindow);
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  const stop = () => stopping ??= (async () => {
    quitting = true; for (const controller of active.values()) controller.abort();
    await application.close(); tray?.destroy();
    ipcMain.removeHandler('wechat-app:rpc'); ipcMain.removeHandler('wechat-app:external'); ipcMain.removeAllListeners('wechat-app:cancel');
    if (!window.isDestroyed()) window.destroy();
  })();
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); void stop().finally(() => app.quit());
  });
  await window.loadURL(page);
  if (showRequested) showWindow();
  return { window, application, stop, dataHome: app.getPath('userData') };
}

module.exports = { runDesktop };
if (require.main === module) runDesktop().catch(error => {
  dialog.showErrorBox('微信 Agent 启动失败', error.message || '请检查应用安装与数据目录'); app.exit(1);
});
