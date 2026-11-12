const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wechatApp', Object.freeze({
  request: (id, endpoint, payload) => ipcRenderer.invoke('wechat-app:rpc', { id, endpoint, payload }),
  cancel: id => ipcRenderer.send('wechat-app:cancel', id),
  openExternal: address => ipcRenderer.invoke('wechat-app:external', address),
}));
