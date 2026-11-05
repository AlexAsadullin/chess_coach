#!/usr/bin/env node
/**
 * Makes sure the Electron binary is really installed.
 *
 * Electron's own postinstall (node_modules/electron/install.js) unpacks its
 * zip with `extract-zip`, which on recent Node versions can stop after the
 * first file and still exit successfully, leaving only LICENSES.chromium.html.
 * If that happened, download the same zip via @electron/get (uses the cache)
 * and unpack it with the system's tar/unzip instead.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const { version } = require(path.join(electronDir, 'package.json'));

const PLATFORM_PATH = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  win32: 'electron.exe',
  linux: 'electron',
}[process.platform];

function installed() {
  return fs.existsSync(path.join(distDir, PLATFORM_PATH))
    && fs.existsSync(path.join(electronDir, 'path.txt'));
}

async function main() {
  if (installed()) {
    console.log(`Electron ${version} binary present`);
    return;
  }
  console.log(`Electron ${version} binary missing; unpacking it with system tools…`);
  const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [electronDir] }));
  const zip = await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch: process.arch });
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  if (process.platform === 'linux') execFileSync('unzip', ['-q', '-o', zip, '-d', distDir], { stdio: 'inherit' });
  else execFileSync('tar', ['-xf', zip, '-C', distDir], { stdio: 'inherit' }); // bsdtar reads zip (macOS, Windows 10+)
  fs.writeFileSync(path.join(electronDir, 'path.txt'), PLATFORM_PATH);
  if (!installed()) throw new Error('Electron binary still missing after unpacking');
  console.log(`Electron ${version} installed`);
}

main().catch((err) => {
  console.error(`ensure-electron failed: ${err.message}`);
  process.exitCode = 1;
});
