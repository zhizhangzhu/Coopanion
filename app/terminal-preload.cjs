/** Only the terminal settings page receives these native operations. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('terminal', {
  onChat: (callback) => { ipcRenderer.on('terminal:show-chat', () => callback()); },
  strings: () => ipcRenderer.invoke('terminal:strings'),
  importPairing: () => ipcRenderer.invoke('terminal:import'),
  request: (path, method = 'GET', body) => ipcRenderer.invoke('terminal:request', path, method, body),
  dress: () => ipcRenderer.invoke('terminal:dress'),
});
