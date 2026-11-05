const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('chessApi', {
  listGames: () => ipcRenderer.invoke('games:list'),
  getGame: (id) => ipcRenderer.invoke('games:get', id),
  touchGame: (id) => ipcRenderer.invoke('games:touch', id),
  setAnalysisSummary: (id, summary) => ipcRenderer.invoke('games:setAnalysisSummary', id, summary),
  renameGame: (id, name) => ipcRenderer.invoke('games:rename', id, name),
  removeGame: (id) => ipcRenderer.invoke('games:remove', id),
  importDialog: () => ipcRenderer.invoke('games:importDialog'),
  importText: (text) => ipcRenderer.invoke('games:importText', text),
  /** Import files dropped onto the window. */
  importFiles: (files) =>
    ipcRenderer.invoke('games:importPaths', [...files].map((f) => webUtils.getPathForFile(f))),
  // ---- settings & AI keys (keys arrive masked; copy happens in the main process)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, snap) => cb(snap)),
  addKey: (entry) => ipcRenderer.invoke('keys:add', entry),
  removeKey: (id) => ipcRenderer.invoke('keys:remove', id),
  renameKey: (id, name) => ipcRenderer.invoke('keys:rename', id, name),
  setActiveKey: (id) => ipcRenderer.invoke('keys:setActive', id),
  copyKey: (id) => ipcRenderer.invoke('keys:copy', id),
  // ---- analysis cache
  cacheInfo: () => ipcRenderer.invoke('analysis:cacheInfo'),
  clearCache: () => ipcRenderer.invoke('analysis:clearCache'),
  // ---- engine analysis
  analysisStatus: () => ipcRenderer.invoke('analysis:status'),
  startAnalysis: (id) => ipcRenderer.invoke('analysis:start', id),
  cancelAnalysis: (id) => ipcRenderer.invoke('analysis:cancel', id),
  bestLine: (fen, opts) => ipcRenderer.invoke('analysis:bestLine', fen, opts),
  prefetchLines: (gameId, items, opts) => ipcRenderer.invoke('analysis:prefetchLines', gameId, items, opts),
  /** Subscribe to analysis events; returns an unsubscribe function. */
  onAnalysis: (cb) => {
    const chans = ['analysis:position', 'analysis:progress', 'analysis:done', 'analysis:error', 'analysis:line'];
    const fns = chans.map((ch) => {
      const fn = (_e, payload) => cb(ch.split(':')[1], payload);
      ipcRenderer.on(ch, fn);
      return [ch, fn];
    });
    return () => fns.forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
  },
  /** Main process asks the UI to open a game (e.g. file opened from OS). */
  onOpenGame: (cb) => ipcRenderer.on('open-game', (_e, id) => cb(id)),
});
