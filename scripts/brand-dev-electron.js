#!/usr/bin/env node
/**
 * macOS only, development only: makes `npm start` show "Chess Coach" and the
 * app icon in the menu bar and Dock instead of "Electron". Patches the
 * Electron.app bundle inside node_modules (name + icon) and re-signs it
 * ad-hoc so macOS still launches it. Packaged builds don't need this —
 * electron-builder sets name and icon itself.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'Chess Coach';
if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(appDir, 'Contents', 'Info.plist');
const icnsOut = path.join(appDir, 'Contents', 'Resources', 'electron.icns');
const iconPng = path.join(root, 'build', 'icon.png');
const marker = path.join(root, 'node_modules', 'electron', '.chess-coach-branded'); // outside the signed bundle

try {
  if (!fs.existsSync(plist)) throw new Error('Electron.app not found (run npm install)');
  const stamp = `${fs.statSync(iconPng).mtimeMs}`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) {
    console.log('dev Electron already branded');
    process.exit(0);
  }
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  run('plutil', ['-replace', 'CFBundleName', '-string', NAME, plist]);
  run('plutil', ['-replace', 'CFBundleDisplayName', '-string', NAME, plist]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const set = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', `${size}`, `${size}`, iconPng, '--out', path.join(set, `icon_${size}x${size}.png`)]);
    run('sips', ['-z', `${size * 2}`, `${size * 2}`, iconPng, '--out', path.join(set, `icon_${size}x${size}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', set, '-o', icnsOut]);
  fs.rmSync(tmp, { recursive: true, force: true });

  run('codesign', ['--force', '--deep', '--sign', '-', appDir]);
  fs.writeFileSync(marker, stamp);
  console.log(`dev Electron branded as "${NAME}"`);
} catch (err) {
  console.warn(`brand-dev-electron skipped: ${err.message}`);
}
