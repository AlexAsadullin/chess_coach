# Chess Coach: developer setup and build guide

This guide takes you from a fresh copy of the source (only the files that are **not** in `.gitignore`) to a running development app and a finished installer.

## 1. What is in the source tree

| Path | What it is |
|---|---|
| `package.json`, `package-lock.json` | Dependencies, npm scripts, electron-builder config (`"build"` field) |
| `src/main/` | Electron main process: window, storage, PGN import, Stockfish (UCI) analysis service |
| `src/renderer/` | UI: HTML/CSS, board, review screen, classification, sounds, eval graph |
| `src/renderer/data/openings.js` | Opening book (generated from the lichess CC0 database, committed) |
| `src/renderer/assets/pieces/` | Extra piece sets (Neo, Chessnut, Merida). Embedded into `vendor/piece-sets.js` by `prepare-assets.js`. |
| `src/renderer/assets/sounds/` | Wood-impact recordings (Kenney, CC0). Embedded into `vendor/sound-data.js` by `prepare-assets.js`. |
| `src/renderer/assets/icon.png` | Window/Dock icon (generated from `build/icon.svg`, committed) |
| `build/icon.svg`, `build/icon.png` | App icon source and the 1024 px render used by electron-builder |
| `scripts/` | Setup/build helpers (see below) |
| `test/` | Unit tests (`node --test`) |
| `docs/engine-research.md` | Why Stockfish was chosen |

These are **not** in the source and are created by the steps below:

| Path | Created by | Size |
|---|---|---|
| `node_modules/` | `npm install` | ~430 MB |
| `src/renderer/vendor/` (chess.js, piece sprites and embedded sounds for the UI) | `scripts/prepare-assets.js` (runs on `npm install` and `npm start`) | 150 KB |
| `engine/<os>-<arch>/stockfish` (the chess engine) | `scripts/fetch-stockfish.js` (runs on `npm install`) | ~105 MB |
| `dist/` (installers) | `npm run dist:*` | ~300 MB per platform |

## 2. Prerequisites

- **Node.js 20 or newer**, with npm 10 or newer. The project was built with Node 26 and npm 11. Check with `node -v` and `npm -v`.
- An **internet connection** for the first install. It downloads Electron (~100 MB) and Stockfish 19 (~80 MB) from their official GitHub releases.
- **macOS builds** need macOS with the Xcode Command Line Tools (`xcode-select --install`). They provide `codesign`, `iconutil`, `sips` and `plutil`.
- **Windows and Linux builds** are best made on Windows or Linux respectively (see section 6).

## 3. First-time setup

```bash
cd chess_analysys
npm install
```

`npm install` installs the packages and then runs the `postinstall` script, which does four things in order:

1. **`scripts/ensure-electron.js`:** checks that the Electron binary was really unpacked into `node_modules/electron/dist`. Electron's own installer can stop after the first file on recent Node versions and still report success. If that happened, this step unpacks the official zip with the system's `tar`/`unzip`.
2. **`scripts/prepare-assets.js`:** copies `chess.js` and the Cburnett piece images into `src/renderer/vendor/`.
3. **`scripts/fetch-stockfish.js`:** downloads the official **Stockfish 19** release for your OS and CPU and unpacks it to `engine/<os>-<arch>/stockfish`. Its licence (`Copying.txt`) goes in the same folder.
4. **`scripts/brand-dev-electron.js`** (macOS only): renames the development Electron to "Chess Coach", gives it the app icon, and re-signs it ad-hoc. This makes `npm start` show the right name and icon in the Dock.

npm 11 only runs dependency install scripts that are listed in `"allowScripts"` in `package.json`. Electron is already approved there. You'll still see an `allow-scripts` warning for `electron-winstaller`; that's expected, and its script is not needed. After upgrading Electron, approve the new version again:

```bash
npm approve-scripts electron
```

Check the result:

```bash
ls engine/*/
```

```bash
npm test
```

You should see `stockfish`, `Copying.txt`, `SOURCE.txt`, `VERSION`, and all tests passing.

### If a download step failed

The setup never fails silently; re-run the single step:

```bash
npm run fetch-engine
```

```bash
node scripts/ensure-electron.js
```

The last command fixes "Electron failed to install correctly", including the case where `node_modules/electron/dist` only contains `LICENSES.chromium.html`.

To use a Stockfish you already have instead of downloading one, set `STOCKFISH_PATH` (e.g. `STOCKFISH_PATH=/opt/homebrew/bin/stockfish npm start`).

## 4. Run in development

```bash
npm start
```

- Saved games and the analysis cache live in the OS app-data folder:
  - macOS: `~/Library/Application Support/Chess Coach/library`
  - Windows: `%APPDATA%\Chess Coach\library`
  - Linux: `~/.config/Chess Coach/library`
- Settings live in `settings.json` and AI keys (encrypted) in `ai-keys.json`, both in the same app-data folder. On macOS the first key you add creates a "Chess Coach Safe Storage" item in your login keychain. A rebuilt ad-hoc-signed app may ask once for permission to read it.
- To use a separate library (for testing, or a portable setup), start with a data folder of your choice:

```bash
CHESS_COACH_DATA=/tmp/chess-coach-test npm start
```

- The UI is plain ES modules with no bundler. Edit files in `src/renderer/` and reload the window with ⌘R / Ctrl+R. Changes in `src/main/` need a restart.

## 5. Tests

```bash
npm test
```

The tests cover PGN import (multi-game files, comments, header-less games), storage, and every move-classification rule. They use hand-made engine output, so Stockfish is not needed to run them.

## 6. Build installers

electron-builder bundles the app, Electron and the Stockfish binary (via `extraResources`) into a self-contained app. End users need nothing else.

| Command | Output (in `dist/`) | Build on |
|---|---|---|
| `npm run dist:mac` | `Chess-Coach-macOS.dmg` (fixed name, so the README's "latest release" download link always works), `Chess-Coach-<version>-universal.zip`, and `mac-universal/Chess Coach.app` (Intel + Apple Silicon) | macOS |
| `npm run dist:win` | `Chess-Coach-<version>-x64.exe` (NSIS installer) | Windows (or macOS/Linux with Wine) |
| `npm run dist:linux` | `Chess-Coach-<version>-x86_64.AppImage`, `.deb` | Linux |

Each `dist:*` script first fetches the matching Stockfish build (`--strict`, so a failed download stops the build), then runs electron-builder.

If the macOS build stops with `ENOTEMPTY ... mac-universal-x64-temp`, Finder created a `.DS_Store` inside `dist/` while it was building. Delete `dist/` and run the command again.

### macOS signing

- **Default (no Apple account):** the app is **ad-hoc signed** (`"identity": "-"` in `package.json`). It runs fine on the Mac that built it. On other Macs, Gatekeeper blocks the first launch because the app is not notarized. Users allow it once:
  1. Double-click the app. macOS says it can't verify the app. Click **Done**.
  2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "Chess Coach". Confirm.

  Or, in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Chess Coach.app"
```

- **With an Apple Developer ID ($99/year):** this removes the warning. Install your "Developer ID Application" certificate in the Keychain. Then build with your identity, hardened runtime on, and notarization credentials:

```bash
APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=TEAMID npx electron-builder --mac --universal -c.mac.identity="Developer ID Application: Your Name (TEAMID)" -c.mac.hardenedRuntime=true -c.mac.notarize=true
```

## 7. Regenerating committed assets (optional)

| What | Command | When |
|---|---|---|
| App icon PNGs from `build/icon.svg` | `npm run build-icon` | After editing the SVG. On macOS, then run `node scripts/brand-dev-electron.js` for the Dock icon in development. |
| Opening book `src/renderer/data/openings.js` | `npm run build-openings` | To pick up a newer lichess opening list |
| Renderer vendor files | `node scripts/prepare-assets.js` | Runs automatically |
| Stockfish | `npm run fetch-engine -- --force` | After changing `VERSION` in `scripts/fetch-stockfish.js` |

## 8. Analysis settings

The deep-pass depth is chosen in the app's Settings (16, 20 or 24). The other engine settings are in `src/main/analysis-service.js` (`SETTINGS`):

| Setting | Value | Purpose |
|---|---|---|
| `quickDepth` | 12 | Fast first pass |
| `depth` | 20 | Default deep-pass depth (the Settings value overrides it) |
| `multipv` | 2 | Number of best lines per position |
| `lineDepth` | 18 | Depth for each move of the Best-line branch |

Saved results record the depth they reached, so changing the depth keeps them: a deeper setting refines them, a shallower one reuses them. Only a change to `multipv` or the file format needs a new `CACHE_VERSION`. Classification thresholds are in `src/renderer/js/analysis/classify.js` (`THRESHOLDS`).

## 9. Quick checklist (fresh copy → working app → installer)

```bash
npm install
```

```bash
npm test
```

```bash
npm start
```

```bash
npm run dist:mac
```
