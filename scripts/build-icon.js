/**
 * Renders build/icon.svg to PNGs (run with Electron):
 *   npx electron scripts/build-icon.js
 * Outputs build/icon.png (1024, used by electron-builder for .icns/.ico) and
 * src/renderer/assets/icon.png (512, window/dock icon in development).
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const render = (size) => win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`);
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), Buffer.from(await render(1024), 'base64'));
  fs.mkdirSync(path.join(root, 'src', 'renderer', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'assets', 'icon.png'), Buffer.from(await render(512), 'base64'));
  console.log('icons written');
  app.quit();
});
