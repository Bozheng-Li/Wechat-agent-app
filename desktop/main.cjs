const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, safeStorage, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createUpdater } = require('./updates.cjs');
// app.getVersion() reports Electron's own version when the entry is a script
// file (tests, npm start), so the release version comes from the package itself.
const { version: PACKAGE_VERSION } = require('../package.json');

async function runDesktop({ dataHome = process.env.WECHAT_APP_HOME, show = true } = {}) {
  // Electron keys its instance lock by userData. Claim the same per-user lock
  // before choosing a data directory, so another profile cannot start an app.
  const singletonHome = path.join(app.getPath('appData'), 'dsh-Wechat-app');
  app.setPath('userData', singletonHome);
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  // The bundle owns the storage helpers, so the packaged app never reaches into
  // source folders that are not shipped.
  const { createDesktopApplication, resolveDataRoot, lockHolder } = await import('../lib/app.js');
  // The data root is settled before any store opens: an explicit home wins, then
  // a pointer that both ends share, then the per-user default. A pending switch
  // (copy or adopt another root) runs here so nothing is copied while in use.
  const data = dataHome ? { root: path.resolve(dataHome), source: 'argument' } : resolveDataRoot(singletonHome);
  // One data root has one writer. A live lock means the other end (the DSH plugin
  // or another window) is using it, so report it instead of opening stores that
  // cannot commit.
  const root = data.root;
  const holder = process.env.WECHAT_APP_IGNORE_LOCK === '1' ? undefined : lockHolder(root);
  if (holder) console.error('数据目录正被其他实例使用（pid ' + (holder.pid ?? holder.workerPid) + '）：' + root);
  app.setPath('userData', root);
  if (data.source === 'failed') console.error('数据目录切换未完成：' + data.error);
  const dshHome = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh');
  let window, tray, quitting = false, stopping, showRequested = show;
  const showWindow = () => {
    if (quitting) return;
    showRequested = true;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  app.on('second-instance', showWindow);
  // Opening the data root can take a while on a large history, so the window is
  // created first and renders this progress itself: the person sees the app at
  // once and the stores open behind it instead of in front of a blank screen.
  const STAGES = {
    'data-root': ['正在读取数据目录设置…', 20],
    application: ['正在打开数据目录…', 28],
    lock: ['正在取得数据目录写入权…', 36],
    open: ['正在加载会话与索引…', 48],
    service: ['正在准备设置与界面…', 70],
    activate: ['正在连接微信…', 84],
  };
  const versionLabel = '版本 ' + PACKAGE_VERSION;
  let stage = { label: STAGES['data-root'][0], percent: STAGES['data-root'][1], version: versionLabel };
  const postStage = () => { if (window && !window.isDestroyed()) window.webContents.send('wechat-app:boot', stage); };
  const progress = key => {
    const [label, percent] = STAGES[key] || [];
    if (!label) return;
    stage = { label, percent, version: versionLabel };
    postStage();
  };
  await app.whenReady();
  require('./network.cjs').installNetworkFetch();
  const page = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
  const active = new Map();
  let application, readyResolve, readyReject;
  const appReady = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Nobody awaits this promise when startup fails before the first RPC.
  appReady.catch(() => {});
  window = new BrowserWindow({ width: 1360, height: 920, minWidth: 720, minHeight: 560, show: false,
    title: '微信 Agent', icon: path.join(__dirname, 'icon.ico'), backgroundColor: '#f5f6f5', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      spellcheck: false, backgroundThrottling: false, offscreen: !show } });
  // A reload or a slow frame must not lose the stage the backend is already in.
  window.webContents.on('did-finish-load', postStage);
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
    try {
      // Requests arriving during startup wait for the data layer instead of failing.
      const service = application ?? await appReady;
      return await service.call(request.endpoint, request.payload, controller.signal);
    } finally { active.delete(request.id); }
  });
  ipcMain.on('wechat-app:cancel', (event, id) => { try { owner(event); active.get(id)?.abort(); } catch {} });
  ipcMain.handle('wechat-app:external', async (event, address) => {
    owner(event);
    // Validate the shape before parsing: a non-string used to surface an internal
    // "Invalid URL" TypeError instead of the user-facing message.
    if (typeof address !== 'string' || !address || address.length > 8192) throw new Error('网页链接无效');
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页链接无效');
    await shell.openExternal(url.href);
  });
  // The renderer only ever receives a path the person picked in their own dialog.
  ipcMain.handle('wechat-app:pick-directory', async (event, current) => {
    owner(event);
    const options = { title: '选择全局工作目录', buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent'] };
    if (typeof current === 'string' && path.isAbsolute(current) && fs.existsSync(current)) options.defaultPath = current;
    const result = await dialog.showOpenDialog(window, options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('wechat-app:open-path', async (event, target) => {
    owner(event);
    if (typeof target !== 'string' || target.length > 32767 || !path.isAbsolute(target)) throw new Error('目录无效');
    let stat;
    try { stat = await fs.promises.stat(target); } catch { throw new Error('目录不存在'); }
    if (!stat.isDirectory()) throw new Error('只能打开目录');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  // Update checks and installer downloads stay in the main process; the renderer
  // has no network access and never receives the installer bytes.
  const updater = createUpdater({ currentVersion: PACKAGE_VERSION, directory: app.getPath('userData') });
  const settle = operation => operation.then(value => ({ ok: true, value }),
    error => ({ ok: false, error: { code: error.code || 'UPDATE_FAILED', message: error.message || '更新操作未完成' } }));
  ipcMain.handle('wechat-app:update-check', async event => { owner(event); return settle(updater.check()); });
  ipcMain.handle('wechat-app:update-download', async event => {
    owner(event);
    return settle(updater.download(progress => {
      if (!window.isDestroyed()) window.webContents.send('wechat-app:update-progress', progress);
    }));
  });
  ipcMain.handle('wechat-app:update-cancel', async event => { owner(event); return { ok: true, value: updater.cancel() }; });
  ipcMain.handle('wechat-app:update-install', async event => {
    owner(event);
    const outcome = await settle(Promise.resolve().then(() => updater.install()));
    if (outcome.ok) setTimeout(() => app.quit(), 1200);
    return outcome;
  });
  // A data-root switch is applied on the next start, so the window asks for a
  // restart instead of re-pointing a live store.
  ipcMain.handle('wechat-app:relaunch', async event => {
    owner(event);
    setTimeout(() => { app.relaunch(); app.quit(); }, 150);
    return { ok: true, value: { restarting: true } };
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
    // Startup may still be running: wait for it so the stores close in order.
    await appReady.catch(() => {});
    await application?.close();
    tray?.destroy();
    ipcMain.removeHandler('wechat-app:rpc'); ipcMain.removeHandler('wechat-app:external');
    ipcMain.removeHandler('wechat-app:pick-directory'); ipcMain.removeHandler('wechat-app:open-path');
    ipcMain.removeHandler('wechat-app:update-check'); ipcMain.removeHandler('wechat-app:update-download');
    ipcMain.removeHandler('wechat-app:update-cancel'); ipcMain.removeHandler('wechat-app:update-install');
    ipcMain.removeHandler('wechat-app:relaunch');
    ipcMain.removeAllListeners('wechat-app:cancel');
    if (!window.isDestroyed()) window.destroy();
  })();
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); void stop().finally(() => app.quit());
  });
  progress('data-root');
  try {
    await window.loadURL(page);
  } catch (error) { throw error; }
  if (showRequested) showWindow();
  // Everything below runs behind the visible window; the panel waits for `ready`.
  const startedAt = Date.now();
  try {
    application = await createDesktopApplication({ dataHome: app.getPath('userData'), home: singletonHome, dshHome, progress, encryption: {
      isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
    } });
  } catch (error) {
    // Release anything that queued behind startup before the app goes away.
    readyReject(error);
    throw error;
  }
  readyResolve(application);
  if (!window.isDestroyed()) {
    window.webContents.send('wechat-app:ready', { version: versionLabel, elapsedMs: Date.now() - startedAt });
    if (showRequested) window.focus();
  }
  return { window, application, stop, updater, dataHome: app.getPath('userData') };
}

module.exports = { runDesktop };

// Electron loads the package `main` itself: in a packaged build `require.main` is
// not this module, and under `electron .` it is Electron's own module, so the plain
// `require.main === module` check never fired and the window never opened.
const isEntry = () => {
  if (require.main === module) return true;
  if (!process.versions.electron) return false;
  if (!process.defaultApp) return true;
  const target = process.argv[1];
  return typeof target === 'string' && (target === '.' || path.resolve(target) === __filename);
};
if (isEntry()) runDesktop().catch(error => {
  dialog.showErrorBox('微信 Agent 启动失败', error.message || '请检查应用安装与数据目录'); app.exit(1);
});
