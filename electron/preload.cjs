const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  chooseProject: () => ipcRenderer.invoke('choose-project'),
  newWindow: () => ipcRenderer.invoke('new-window'),
  parallelWindow: () => ipcRenderer.invoke('parallel-window'),
  copyText: text => ipcRenderer.invoke('copy-text', text),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  backupRecords: () => ipcRenderer.invoke('backup-records'),
  restoreRecords: () => ipcRenderer.invoke('restore-records')
});
