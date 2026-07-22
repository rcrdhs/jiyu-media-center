const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('signalDesktop', {
  isDesktop: true,
  openPlaylist: () => ipcRenderer.invoke('dialog:openPlaylist'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  fetchPlaylist: (url) => ipcRenderer.invoke('playlist:fetchUrl', url),
  probeStream: (url, timeoutMs) => ipcRenderer.invoke('stream:probe', url, timeoutMs),
  probeStreams: (entries, timeoutMs) => ipcRenderer.invoke('stream:probeMany', entries, timeoutMs),
  catalogList: () => ipcRenderer.invoke('catalog:list'),
  catalogPut: (source) => ipcRenderer.invoke('catalog:put', source),
  catalogDelete: (id) => ipcRenderer.invoke('catalog:delete', id),
  catalogClear: () => ipcRenderer.invoke('catalog:clear'),
  catalogReplaceAll: (sources) => ipcRenderer.invoke('catalog:replaceAll', sources),
  browserShow: (bounds) => ipcRenderer.invoke('browser:show', bounds),
  browserHide: () => ipcRenderer.invoke('browser:hide'),
  browserSetBounds: (bounds) => ipcRenderer.invoke('browser:setBounds', bounds),
  browserNavigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  browserGoBack: () => ipcRenderer.invoke('browser:goBack'),
  browserGoForward: () => ipcRenderer.invoke('browser:goForward'),
  browserReload: () => ipcRenderer.invoke('browser:reload'),
  browserOpenExternalCurrent: () => ipcRenderer.invoke('browser:openExternalCurrent'),
  browserOpenPanel: (url) => ipcRenderer.invoke('browser:openPanel', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  fetchHtml: (url) => ipcRenderer.invoke('page:fetchHtml', url),
  torrentStream: (magnet) => ipcRenderer.invoke('torrent:stream', magnet),
  torrentStatus: (infoHash) => ipcRenderer.invoke('torrent:status', infoHash),
  torrentStop: (infoHash) => ipcRenderer.invoke('torrent:stop', infoHash),
  onBrowserNav: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:nav', listener)
    return () => ipcRenderer.removeListener('browser:nav', listener)
  },
})
