const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, shell, nativeImage, safeStorage } = require('electron');
const { GameStore } = require('./storage');
const { registerIpc, importFile } = require('./ipc');
const { AnalysisService } = require('./analysis-service');
const { SettingsStore } = require('./settings');

app.setName('Chess Coach');
// Optional: keep the library somewhere else (portable use, testing).
if (process.env.CHESS_COACH_DATA) app.setPath('userData', process.env.CHESS_COACH_DATA);
const ICON = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');

/** Games saved before the rename (app was "Chess Analysis") move over once. */
function migrateOldLibrary() {
  const newLib = path.join(app.getPath('userData'), 'library');
  const oldLib = path.join(app.getPath('appData'), 'Chess Analysis', 'library');
  if (fs.existsSync(newLib) || !fs.existsSync(oldLib)) return;
  try {
    fs.mkdirSync(path.dirname(newLib), { recursive: true });
    fs.cpSync(oldLib, newLib, { recursive: true });
  } catch (err) {
    console.error('library migration failed', err);
  }
}

let mainWindow = null;
let store = null;
let analysis = null;
const pendingFiles = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#302e2b',
    title: 'Chess Coach',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.once('did-finish-load', () => flushPendingFiles());
}

/** Files passed by the OS ("Open with…", double-click a .pgn). */
function openFromOs(filePath) {
  if (!store || !mainWindow) {
    pendingFiles.push(filePath);
    return;
  }
  try {
    const { games } = importFile(store, filePath);
    if (games[0]) mainWindow.webContents.send('open-game', games[0].id);
  } catch (err) {
    console.error('Failed to import', filePath, err);
  }
}

function flushPendingFiles() {
  while (pendingFiles.length) openFromOs(pendingFiles.shift());
}

function fileArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && /\.(pgn|txt)$/i.test(a));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    fileArgs(argv).forEach(openFromOs);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    openFromOs(filePath);
  });

  app.whenReady().then(() => {
    migrateOldLibrary();
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(ICON));
    app.setAboutPanelOptions({ applicationName: 'Chess Coach', credits: 'Analysis by Stockfish 19 (GPL-3.0)' });
    store = new GameStore(app.getPath('userData'));
    const settings = new SettingsStore(app.getPath('userData'), safeStorage);
    settings.onChange((snap) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', snap);
    });
    analysis = new AnalysisService(
      app.getPath('userData'),
      () => settings.get().analysis.depth,
      () => settings.get().analysis.linePlies,
    );
    registerIpc(store, analysis, settings);
    pendingFiles.push(...fileArgs(process.argv));
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => analysis?.quit());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
