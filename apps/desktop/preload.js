const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('WordDrillNative', {
  platform: 'windows',
  getWordbooksDir: () => ipcRenderer.invoke('worddrill:get-dir'),
  openWordbooksDir: () => ipcRenderer.invoke('worddrill:open-dir'),
  writeWordbookBundle: (bookId, fileName, content) =>
    ipcRenderer.invoke('worddrill:write-bundle', bookId, fileName, content),
  deleteWordbookBundle: (bookId) => ipcRenderer.invoke('worddrill:delete-bundle', bookId),
  listWordbookFiles: () => ipcRenderer.invoke('worddrill:list-bundles'),
  saveExportFile: (fileName, content) =>
    ipcRenderer.invoke('worddrill:save-export', fileName, content)
});
