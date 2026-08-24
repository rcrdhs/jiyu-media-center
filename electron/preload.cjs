const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('signalDesktop', {
  isDesktop: true,
  openPlaylist: () => ipcRenderer.invoke('dialog:openPlaylist'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  fetchPlaylist: (url) => ipcRenderer.invoke('playlist:fetchUrl', url),
  probeStream: (url, timeoutMs) => ipcRenderer.invoke('stream:probe', url, timeoutMs),
  probeStreams: (entries, timeoutMs) => ipcRenderer.invoke('stream:probeMany', entries, timeoutMs),
  setPlaybackHeaders: (options) => ipcRenderer.invoke('stream:setPlaybackHeaders', options),
  resolveVimeoLiveHls: (input) => ipcRenderer.invoke('vimeo:resolveLiveHls', input),
  catalogList: () => ipcRenderer.invoke('catalog:list'),
  catalogPut: (source) => ipcRenderer.invoke('catalog:put', source),
  catalogDelete: (id) => ipcRenderer.invoke('catalog:delete', id),
  catalogClear: () => ipcRenderer.invoke('catalog:clear'),
  catalogReplaceAll: (sources) => ipcRenderer.invoke('catalog:replaceAll', sources),
  torrentSourcesList: () => ipcRenderer.invoke('torrentSources:list'),
  torrentSourcesSave: (sources) => ipcRenderer.invoke('torrentSources:save', sources),
  tmdbPopularTv: (limit) => ipcRenderer.invoke('tmdb:popularTv', limit),
  tmdbTvCatalog: (kind, limit) => ipcRenderer.invoke('tmdb:tvCatalog', kind, limit),
  tmdbSyncControl: (action) => ipcRenderer.invoke('tmdb:syncControl', action),
  onTmdbProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('tmdb:progress', listener)
    return () => ipcRenderer.removeListener('tmdb:progress', listener)
  },
  browserShow: (bounds) => ipcRenderer.invoke('browser:show', bounds),
  browserHide: (options) => ipcRenderer.invoke('browser:hide', options),
  browserSetBounds: (bounds) => ipcRenderer.invoke('browser:setBounds', bounds),
  browserNavigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  browserGoBack: () => ipcRenderer.invoke('browser:goBack'),
  browserGoForward: () => ipcRenderer.invoke('browser:goForward'),
  browserReload: () => ipcRenderer.invoke('browser:reload'),
  browserOpenExternalCurrent: () => ipcRenderer.invoke('browser:openExternalCurrent'),
  browserOpenPanel: (url) => ipcRenderer.invoke('browser:openPanel', url),
  browserExecute: (code) => ipcRenderer.invoke('browser:execute', code),
  browserGetNav: () => ipcRenderer.invoke('browser:getNav'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getSystemCapabilities: () => ipcRenderer.invoke('system:getCapabilities'),
  setPerformanceKnobs: (knobs) => ipcRenderer.invoke('system:setPerformanceKnobs', knobs),
  fetchHtml: (url) => ipcRenderer.invoke('page:fetchHtml', url),
  fetchJsonPost: (url, body, referer) => ipcRenderer.invoke('page:fetchJsonPost', url, body, referer),
  fetchJsonGet: (url, referer) => ipcRenderer.invoke('page:fetchJsonGet', url, referer),
  closeCfBrowser: (options) => ipcRenderer.invoke('cf:closeSystemBrowser', options),
  torrentStream: (magnet, options) => ipcRenderer.invoke('torrent:stream', magnet, options),
  torrentStatus: (infoHash) => ipcRenderer.invoke('torrent:status', infoHash),
  torrentEnsureDownloading: (infoHash, playheadSec, runtimeSec) =>
    ipcRenderer.invoke('torrent:ensureDownloading', infoHash, playheadSec, runtimeSec),
  torrentStop: (infoHash) => ipcRenderer.invoke('torrent:stop', infoHash),
  onBrowserNav: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:nav', listener)
    return () => ipcRenderer.removeListener('browser:nav', listener)
  },
  onSaveContinue: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:save-continue', listener)
    return () => ipcRenderer.removeListener('app:save-continue', listener)
  },
  continueSaved: () => {
    ipcRenderer.send('app:continue-saved')
  },
})
