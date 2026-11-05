#!/usr/bin/env node
/**
 * Downloads the official Stockfish release binary (GPL-3.0) for a platform
 * into engine/<os>-<arch>/ so it can be bundled with the app.
 *
 *   node scripts/fetch-stockfish.js                 # current machine
 *   node scripts/fetch-stockfish.js --os win --arch x64
 *   node scripts/fetch-stockfish.js --force         # re-download
 *
 * <os> uses electron-builder names: mac | win | linux.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const VERSION = 'sf_19';
const BASE = `https://github.com/official-stockfish/Stockfish/releases/download/${VERSION}`;
const ASSETS = {
  'mac-x64': 'stockfish-macos-universal.tar.gz',
  'mac-arm64': 'stockfish-macos-universal.tar.gz',
  'linux-x64': 'stockfish-linux-x86-64-universal.tar.gz',
  'linux-arm64': 'stockfish-linux-arm64-universal.tar.gz',
  'win-x64': 'stockfish-windows-x86-64-universal.zip',
  'win-arm64': 'stockfish-windows-arm64-universal.zip',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const OS_NAME = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const target = `${arg('os', OS_NAME)}-${arg('arch', process.arch)}`;
const force = process.argv.includes('--force');
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'engine', target);
const exeName = target.startsWith('win') ? 'stockfish.exe' : 'stockfish';
const exePath = path.join(outDir, exeName);
const stamp = path.join(outDir, 'VERSION');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'chess-analysis-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(download(res.headers.location, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let lastPct = -10;
      res.on('data', (c) => {
        got += c.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct >= lastPct + 10) {
          lastPct = pct;
          process.stdout.write(`  ${pct}%`);
        }
      });
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => { process.stdout.write('\n'); resolve(); }));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function findBinary(dir) {
  let best = null;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^stockfish/i.test(e.name) && !/\.(md|txt|sh|cff)$/i.test(e.name)) {
        const size = fs.statSync(p).size;
        if (!best || size > best.size) best = { p, size };
      }
    }
  };
  walk(dir);
  return best?.p;
}

async function main() {
  const asset = ASSETS[target];
  if (!asset) throw new Error(`No Stockfish build configured for ${target}`);
  if (!force && fs.existsSync(exePath) && fs.existsSync(stamp)
      && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
    console.log(`Stockfish ${VERSION} already present for ${target}`);
    return;
  }
  // the same archive may already be unpacked for another arch (macOS builds are universal)
  for (const [other, otherAsset] of Object.entries(ASSETS)) {
    const otherExe = path.join(root, 'engine', other, exeName);
    const otherStamp = path.join(root, 'engine', other, 'VERSION');
    if (other !== target && otherAsset === asset && fs.existsSync(otherExe)
        && fs.existsSync(otherStamp) && fs.readFileSync(otherStamp, 'utf8').trim() === VERSION) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.cpSync(path.dirname(otherExe), outDir, { recursive: true });
      console.log(`Stockfish ${VERSION} copied from ${other} for ${target}`);
      return;
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
  try {
    const archive = path.join(tmp, asset);
    console.log(`Downloading ${asset} …`);
    await download(`${BASE}/${asset}`, archive);
    const extractDir = path.join(tmp, 'x');
    fs.mkdirSync(extractDir);
    // bsdtar (macOS, Windows 10+) reads .zip and .tar.gz; GNU tar reads .tar.gz (Linux)
    execFileSync('tar', ['-xf', archive, '-C', extractDir], { stdio: 'inherit' });
    const bin = findBinary(extractDir);
    if (!bin) throw new Error('Stockfish binary not found in archive');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(bin, exePath);
    fs.chmodSync(exePath, 0o755);
    const license = path.join(path.dirname(bin), 'Copying.txt');
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(outDir, 'Copying.txt'));
    fs.writeFileSync(stamp, `${VERSION}\n`);
    fs.writeFileSync(path.join(outDir, 'SOURCE.txt'),
      `Stockfish ${VERSION} (GPL-3.0). Official binary from ${BASE}/${asset}\n` +
      'Source code: https://github.com/official-stockfish/Stockfish\n');
    console.log(`Stockfish ${VERSION} installed at ${path.relative(root, exePath)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fetch-stockfish failed: ${err.message}`);
  // never break `npm install` — the app shows a clear message when the engine is missing
  process.exitCode = process.argv.includes('--strict') ? 1 : 0;
});
