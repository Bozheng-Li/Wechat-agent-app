const { contextBridge, ipcRenderer } = require('electron');

// The window opens before the data layer is ready, so the renderer needs the boot
// progress and the readiness signal. Both are buffered here: the page can finish
// loading after the event has already been sent, and nothing may be lost.
let boot = { label: '正在启动…', percent: 8, version: '', ready: false };
const bootListeners = new Set(), readyListeners = new Set();
const notify = listeners => { for (const listener of listeners) { try { listener({ ...boot }); } catch {} } };
ipcRenderer.on('wechat-app:boot', (_event, value) => {
  if (!value || typeof value !== 'object') return;
  boot = { ...boot, label: String(value.label ?? boot.label), percent: Number(value.percent ?? boot.percent), version: String(value.version ?? boot.version) };
  notify(bootListeners);
});
ipcRenderer.on('wechat-app:ready', (_event, value) => {
  boot = { ...boot, ready: true, percent: 100, label: '准备就绪', version: String(value?.version ?? boot.version) };
  notify(readyListeners);
});

contextBridge.exposeInMainWorld('wechatApp', Object.freeze({
  request: (id, endpoint, payload) => ipcRenderer.invoke('wechat-app:rpc', { id, endpoint, payload }),
  cancel: id => ipcRenderer.send('wechat-app:cancel', id),
  openExternal: address => ipcRenderer.invoke('wechat-app:external', address),
  pickDirectory: current => ipcRenderer.invoke('wechat-app:pick-directory', current),
  relaunch: () => ipcRenderer.invoke('wechat-app:relaunch'),
  openPath: target => ipcRenderer.invoke('wechat-app:open-path', target),
  checkUpdate: () => ipcRenderer.invoke('wechat-app:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('wechat-app:update-download'),
  cancelUpdate: () => ipcRenderer.invoke('wechat-app:update-cancel'),
  installUpdate: () => ipcRenderer.invoke('wechat-app:update-install'),
  onUpdateProgress: handler => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on('wechat-app:update-progress', listener);
    return () => ipcRenderer.removeListener('wechat-app:update-progress', listener);
  },
  boot: {
    state: () => ({ ...boot }),
    onBoot: handler => { bootListeners.add(handler); handler({ ...boot }); return () => bootListeners.delete(handler); },
    onReady: handler => { readyListeners.add(handler); if (boot.ready) handler({ ...boot }); return () => readyListeners.delete(handler); },
  },
}));
