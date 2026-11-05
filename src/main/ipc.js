const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, BrowserWindow, clipboard } = require('electron');
const { parseText } = require('./pgn-import');

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function importFile(store, filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is larger than 20 MB');
  const text = fs.readFileSync(filePath, 'utf8');
  const { games, errors } = parseText(text, path.basename(filePath));
  return { games: store.add(games), errors, file: path.basename(filePath) };
}

/** Register every IPC handler the renderer uses (see src/main/preload.js). */
function registerIpc(store, analysis, settings) {
  ipcMain.handle('games:list', () => store.list());
  ipcMain.handle('games:get', (_e, id) => store.get(id));
  ipcMain.handle('games:touch', (_e, id) => store.touch(id));
  ipcMain.handle('games:setAnalysisSummary', (_e, id, summary) => store.setAnalysisSummary(id, summary));
  ipcMain.handle('games:rename', (_e, id, name) => store.rename(id, name));
  ipcMain.handle('games:remove', (_e, id) => {
    analysis?.cancel(id);
    analysis?.deleteCache(id);
    store.remove(id);
  });

  if (settings) {
    ipcMain.handle('settings:get', () => settings.snapshot());
    ipcMain.handle('settings:update', (_e, partial) => settings.update(partial));
    ipcMain.handle('keys:add', (_e, entry) => settings.addKey(entry || {}));
    ipcMain.handle('keys:remove', (_e, id) => settings.removeKey(id));
    ipcMain.handle('keys:rename', (_e, id, name) => settings.renameKey(id, name));
    ipcMain.handle('keys:setActive', (_e, id) => settings.setActiveKey(id));
    ipcMain.handle('keys:copy', (_e, id) => {
      const secret = settings.revealKey(id);
      if (!secret) return false;
      clipboard.writeText(secret);
      return true;
    });
  }

  if (analysis) {
    ipcMain.handle('analysis:cacheInfo', () => analysis.cacheInfo());
    ipcMain.handle('analysis:clearCache', () => {
      const info = analysis.clearCache();
      store.clearAnalysisSummaries();
      return info;
    });
    ipcMain.handle('analysis:status', () => analysis.status());
    ipcMain.handle('analysis:start', (e, id) => {
      const wc = e.sender;
      const send = (ch, payload) => { if (!wc.isDestroyed()) wc.send(ch, payload); };
      return analysis.start(store.get(id), send);
    });
    ipcMain.handle('analysis:cancel', (_e, id) => analysis.cancel(id));
    ipcMain.handle('analysis:bestLine', (e, fen, opts = {}) => {
      const wc = e.sender;
      const onStep = opts.requestId
        ? (p) => { if (!wc.isDestroyed()) wc.send('analysis:line', { requestId: opts.requestId, ...p }); }
        : undefined;
      return analysis.bestLine(String(fen), opts, onStep);
    });
    ipcMain.handle('analysis:prefetchLines', (_e, gameId, items, opts) =>
      analysis.prefetchLines(gameId, Array.isArray(items) ? items.slice(0, 400) : [], opts || {}));
  }

  ipcMain.handle('games:importDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Import chess game',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Chess games', extensions: ['pgn', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled) return null;
    return mergeResults(res.filePaths.map((p) => safeImport(store, p)));
  });

  ipcMain.handle('games:importPaths', (_e, paths) =>
    mergeResults(paths.map((p) => safeImport(store, p))));

  ipcMain.handle('games:importText', (_e, text) => {
    const { games, errors } = parseText(String(text), null);
    return { games: store.add(games), errors };
  });
}

function safeImport(store, p) {
  try {
    return importFile(store, p);
  } catch (err) {
    return { games: [], errors: [{ message: `${path.basename(p)}: ${err.message}` }] };
  }
}

function mergeResults(results) {
  return {
    games: results.flatMap((r) => r.games),
    errors: results.flatMap((r) => r.errors.map((x) => ({ ...x, file: r.file }))),
  };
}

module.exports = { registerIpc, importFile };
