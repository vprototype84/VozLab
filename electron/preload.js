'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('transcriptorIA', {
  getAppUrl: () => ipcRenderer.invoke('get-app-url'),
  onProvisionLog: (callback) => {
    ipcRenderer.on('provision-log', (_event, msg) => callback(msg));
  },
  installOllama: () => ipcRenderer.invoke('install-ollama'),
});
