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
  tmdbTvCatalog: (kind, limit, options) =>
    ipcRenderer.invoke('tmdb:tvCatalog', kind, limit, options),
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
  browserClickCenter: (options) => ipcRenderer.invoke('browser:clickCenter', options),
  browserGetNav: () => ipcRenderer.invoke('browser:getNav'),
  browserGetVolume: () => ipcRenderer.invoke('browser:getVolume'),
  browserSetVolume: (percent) => ipcRenderer.invoke('browser:setVolume', percent),
  browserAdDockClose: () => ipcRenderer.invoke('browser:adDockClose'),
  browserAdDockStatus: () => ipcRenderer.invoke('browser:adDockStatus'),
  browserMultiShow: (payload) => ipcRenderer.invoke('browser:multiShow', payload),
  browserMultiSetBounds: (payload) => ipcRenderer.invoke('browser:multiSetBounds', payload),
  browserMultiSetAudio: (payload) => ipcRenderer.invoke('browser:multiSetAudio', payload),
  browserMultiSpotlight: (payload) => ipcRenderer.invoke('browser:multiSpotlight', payload),
  browserMultiNudge: (payload) => ipcRenderer.invoke('browser:multiNudge', payload),
  onBrowserMultiFocus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:multi-focus', listener)
    return () => ipcRenderer.removeListener('browser:multi-focus', listener)
  },
  browserMultiHide: (payload) => ipcRenderer.invoke('browser:multiHide', payload),
  browserMultiHideAll: (options) => ipcRenderer.invoke('browser:multiHideAll', options || {}),
  quit: () => ipcRenderer.invoke('app:quit'),
  exitFullScreen: () => ipcRenderer.invoke('app:exitFullScreen'),
  setFullScreen: (enabled) => ipcRenderer.invoke('app:setFullScreen', Boolean(enabled)),
  isFullScreen: () => ipcRenderer.invoke('app:isFullScreen'),
  setMinimizeToPipPolicy: (policy) => ipcRenderer.invoke('app:setMinimizeToPipPolicy', policy || {}),
  minimizeWindow: () => ipcRenderer.invoke('app:minimizeWindow'),
  onMinimizeToPip: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:minimize-to-pip', listener)
    return () => ipcRenderer.removeListener('app:minimize-to-pip', listener)
  },
  onFullScreenChange: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('app:fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('app:fullscreen-changed', listener)
  },
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  setBackgroundSync: (active) => ipcRenderer.invoke('app:backgroundSync', Boolean(active)),
  checkForUpdates: () => ipcRenderer.invoke('app:updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('app:updater:download'),
  installUpdate: () => ipcRenderer.invoke('app:updater:install'),
  onUpdater: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('app:updater', listener)
    return () => ipcRenderer.removeListener('app:updater', listener)
  },
  getSystemCapabilities: () => ipcRenderer.invoke('system:getCapabilities'),
  setPerformanceKnobs: (knobs) => ipcRenderer.invoke('system:setPerformanceKnobs', knobs),
  fetchHtml: (url, opts) => ipcRenderer.invoke('page:fetchHtml', url, opts || {}),
  fetchJsonPost: (url, body, referer) => ipcRenderer.invoke('page:fetchJsonPost', url, body, referer),
  fetchJsonGet: (url, referer) => ipcRenderer.invoke('page:fetchJsonGet', url, referer),
  resolveWyzieSubtitle: (options) => ipcRenderer.invoke('wyzie:resolveSubtitle', options || {}),
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
  onBrowserVolume: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:volume', listener)
    return () => ipcRenderer.removeListener('browser:volume', listener)
  },
  onBrowserAdDock: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('browser:ad-dock', listener)
    return () => ipcRenderer.removeListener('browser:ad-dock', listener)
  },
  onForceExitFullscreen: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('browser:force-exit-fullscreen', listener)
    return () => ipcRenderer.removeListener('browser:force-exit-fullscreen', listener)
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
