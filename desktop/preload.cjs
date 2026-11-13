const { contextBridge, ipcRenderer } = require('electron');
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
}));
