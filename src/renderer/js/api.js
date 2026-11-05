/**
 * Bridge to the main process (see src/main/preload.js). When the renderer is
 * opened in a plain browser (UI development without Electron) it falls back
 * to an in-memory store so the screens can still be previewed.
 */
export const api = window.chessApi || browserFallback();

const fallbackSettings = {
  settings: {
    board: { theme: 'green', pieces: 'cburnett', coordinates: true, animation: 'fast' },
    sound: { enabled: true, volume: 60 },
    analysis: { depth: 20, bestArrow: true, linePlies: 26 },
    ai: { activeKeyId: null },
  },
  keys: [],
  providers: ['OpenAI', 'Anthropic', 'Google', 'Mistral', 'Other'],
  encrypted: false,
};

function browserFallback() {
  const games = new Map();
  let parse = null;
  const ensureParser = async () => {
    if (!parse) {
      const { Chess } = await import('../vendor/chess.js');
      parse = (text) => {
        const c = new Chess();
        c.loadPgn(text, { strict: false });
        const h = c.getHeaders();
        const sans = c.history();
        const id = Math.random().toString(16).slice(2, 18).padEnd(16, '0');
        const name = `${h.White || 'White'} vs ${h.Black || 'Black'}`;
        return {
          id, name, white: h.White || 'White', black: h.Black || 'Black',
          whiteElo: h.WhiteElo || null, blackElo: h.BlackElo || null, result: h.Result || '*',
          event: h.Event || null, termination: h.Termination || null,
          date: h.Date ? h.Date.replace(/\./g, '-') : null, plies: sans.length,
          movesCount: Math.ceil(sans.length / 2), sans, startFen: null,
          importedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
        };
      };
    }
  };
  const importText = async (text) => {
    await ensureParser();
    try {
      const g = parse(text);
      games.set(g.id, g);
      return { games: [g], errors: [] };
    } catch (e) {
      return { games: [], errors: [{ message: e.message }] };
    }
  };
  return {
    listGames: async () => [...games.values()],
    getGame: async (id) => games.get(id),
    touchGame: async (id) => { const g = games.get(id); if (g) g.lastOpenedAt = new Date().toISOString(); },
    renameGame: async () => {},
    removeGame: async (id) => { games.delete(id); },
    importDialog: async () => {
      const input = Object.assign(document.createElement('input'), { type: 'file' });
      const file = await new Promise((r) => { input.onchange = () => r(input.files[0]); input.click(); });
      return file ? importText(await file.text()) : null;
    },
    importText,
    importFiles: async (files) => importText(await files[0].text()),
    onOpenGame: () => {},
    // settings (in-memory; Electron stores them on disk and encrypts keys)
    getSettings: async () => fallbackSettings,
    updateSettings: async (p) => {
      for (const [g, v] of Object.entries(p)) Object.assign(fallbackSettings.settings[g], v);
      return fallbackSettings;
    },
    cacheInfo: async () => ({ bytes: 0, games: 0 }),
    clearCache: async () => ({ bytes: 0, games: 0 }),
  };
}
